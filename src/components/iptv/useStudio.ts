"use client";

/**
 * Núcleo de estado do Estúdio: documento da playlist (origem imutável +
 * edições), resultados de teste, histórico desfazer/refazer, seleção,
 * execução de testes com concorrência limitada, autorização do relay
 * e persistência local.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildM3U, type ExportResult } from "@/lib/m3u/export";
import { LIMITS, parseM3U, type ParseIssue, type ParseResult } from "@/lib/m3u/parse";
import { classifyImportFetchError } from "@/lib/iptv/classify";
import { runPool } from "@/lib/iptv/runner";
import { isFailureState, isResultStale, isTransientState } from "@/lib/iptv/status";
import { testChannelPlayback } from "@/lib/iptv/tester";
import {
  clearLocalSession,
  loadLocalSession,
  localStoreAvailable,
  saveLocalSession,
} from "@/lib/iptv/localStore";
import type { ResultsMap, TestResult } from "@/lib/iptv/types";
import {
  applyEdit,
  createDoc,
  EMPTY_HISTORY,
  mergeUpdatedPlaylist,
  pushHistory,
  redo,
  undo,
  type EditAction,
  type History,
  type PlaylistDoc,
} from "@/lib/playlist/store";
import { ensureRelayAuthorized, resetClientRelaySession } from "@/lib/relay/client";

export interface LastImport {
  sourceName: string;
  sourceKind: PlaylistDoc["sourceKind"];
  issues: ParseIssue[];
  stats: ParseResult["stats"];
  at: number;
}

export interface Toast {
  id: number;
  message: string;
  undoable?: boolean;
}

export interface RunState {
  active: boolean;
  done: number;
  total: number;
}

export function useStudio() {
  const [hydrated, setHydrated] = useState(false);
  const [doc, setDoc] = useState<PlaylistDoc | null>(null);
  const [results, setResults] = useState<ResultsMap>({});
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [lastImport, setLastImport] = useState<LastImport | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [run, setRun] = useState<RunState>({ active: false, done: 0, total: 0 });
  const [refreshingOrigin, setRefreshingOrigin] = useState(false);
  const [storageNotice, setStorageNotice] = useState<"ok" | "unavailable" | "quota" | null>(null);

  const runCtlRef = useRef<AbortController | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  /* ---------------- persistência local ---------------- */

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!localStoreAvailable()) {
        if (alive) {
          setStorageNotice("unavailable");
          setHydrated(true);
        }
        return;
      }
      const session = await loadLocalSession();
      if (!alive) return;
      if (session) {
        setDoc(session.doc);
        const stable: ResultsMap = {};
        for (const [id, r] of Object.entries(session.results)) {
          stable[id] = isTransientState(r.state)
            ? { ...r, state: "untested", detail: "Sessão anterior interrompida durante o teste." }
            : r;
        }
        setResults(stable);
        setLastImport({
          sourceName: session.doc.sourceName,
          sourceKind: session.doc.sourceKind,
          issues: [],
          stats: {
            totalLines: 0,
            entries: session.doc.channels.length,
            droppedEntries: 0,
            parseMs: 0,
          },
          at: session.doc.importedAt,
        });
        void ensureRelayAuthorized(
          session.doc.channels.filter((c) => !c.deleted).map((c) => c.url),
        );
      }
      setStorageNotice("ok");
      setHydrated(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !doc) return;
    const timer = setTimeout(() => {
      saveLocalSession({ version: 1, savedAt: Date.now(), doc, results }).then((ok) => {
        if (!ok) setStorageNotice((n) => (n === "unavailable" ? n : "quota"));
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [doc, results, hydrated]);

  /* ---------------- helpers ---------------- */

  const showToast = useCallback((message: string, undoable = false) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: ++seqRef.current, message, undoable });
    toastTimerRef.current = setTimeout(() => setToast(null), 5200);
  }, []);

  const notify = useCallback(
    (message: string) => showToast(message, false),
    [showToast],
  );

  const importParsed = useCallback(
    (
      parsed: ParseResult,
      sourceName: string,
      sourceKind: PlaylistDoc["sourceKind"],
      sourceUrl?: string,
    ) => {
      runCtlRef.current?.abort();
      const newDoc = createDoc(
        sourceName,
        sourceKind,
        parsed.channels,
        parsed.headerAttrs,
        sourceUrl,
      );
      setDoc(newDoc);
      setResults({});
      setHistory(EMPTY_HISTORY);
      setSelection(new Set());
      setLastImport({
        sourceName,
        sourceKind,
        issues: parsed.issues,
        stats: parsed.stats,
        at: Date.now(),
      });
      void ensureRelayAuthorized(parsed.channels.map((c) => c.url));
      showToast(
        `Importados ${parsed.channels.length} canais de “${sourceName}”.${
          parsed.issues.length ? ` ${parsed.issues.length} avisos/erros por linha.` : ""
        }`,
      );
    },
    [showToast],
  );

  /**
   * Revalida/atualiza a playlist a partir de sua URL remota de origem (`doc.sourceUrl`).
   * Se a requisição ou o conteúdo falhar, preserva integralmente a playlist válida atual.
   */
  const refreshFromOriginUrl = useCallback(async () => {
    if (!doc?.sourceUrl || refreshingOrigin) return;
    const targetUrl = doc.sourceUrl;
    setRefreshingOrigin(true);
    try {
      let text: string | null = null;
      let kind: PlaylistDoc["sourceKind"] = doc.sourceKind;
      const ctl = new AbortController();
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, 15000);

      try {
        const res = await fetch(targetUrl, { signal: ctl.signal, redirect: "follow" });
        if (res.ok) {
          const raw = await res.text();
          if (raw.length <= LIMITS.maxTextBytes) {
            text = raw;
            kind = "url";
          }
        }
      } catch (err) {
        const errKind = classifyImportFetchError(err, timedOut);
        if (errKind === "cors") {
          // Fallback automático para o serviço do projeto
          const srvRes = await fetch("/api/import-playlist", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: targetUrl }),
          });
          const srvData = (await srvRes.json()) as
            | { ok: true; content: string }
            | { ok: false; message: string };
          if (srvData.ok) {
            text = srvData.content;
            kind = "server";
          } else {
            showToast(
              `Falha ao atualizar lista (${srvData.message}). Playlist atual preservada.`,
            );
            return;
          }
        } else {
          showToast("Falha de rede ao atualizar a playlist. Lista válida atual preservada.");
          return;
        }
      } finally {
        clearTimeout(t);
      }

      if (!text) {
        showToast("A origem não retornou uma playlist válida. Lista atual preservada.");
        return;
      }

      const parsed = parseM3U(text);
      if (!parsed.ok || parsed.channels.length === 0) {
        showToast(
          `Atualização ignorada: o conteúdo retornado não é M3U válido. Sua playlist atual foi preservada.`,
        );
        return;
      }

      const updatedDoc = mergeUpdatedPlaylist(doc, parsed.channels, parsed.headerAttrs, kind);
      setHistory((h) =>
        pushHistory(h, { label: "Atualizar lista da origem", channels: doc.channels }),
      );
      setDoc(updatedDoc);
      void ensureRelayAuthorized(updatedDoc.channels.map((c) => c.url));
      showToast(
        `Playlist atualizada (${parsed.channels.length} canais da origem; edições preservadas).`,
        true,
      );
    } catch {
      showToast("Erro ao atualizar da origem. Sua playlist válida foi preservada.");
    } finally {
      setRefreshingOrigin(false);
    }
  }, [doc, refreshingOrigin, showToast]);

  const edit = useCallback(
    (action: EditAction, opts?: { silent?: boolean }) => {
      if (!doc) return null;
      const res = applyEdit(doc, action);
      if (res.ok) {
        setDoc(res.doc);
        setHistory((h) => pushHistory(h, { label: res.label, channels: doc.channels }));
        if (action.type === "addChannel") {
          void ensureRelayAuthorized([action.url]);
        }
        if (!opts?.silent) showToast(`${res.label}.`, true);
      } else if (!opts?.silent) {
        showToast(`Não foi possível: ${res.error ?? "operação inválida"}.`);
      }
      return res;
    },
    [doc, showToast],
  );

  const undoEdit = useCallback(() => {
    if (!doc) return;
    const u = undo(doc, history);
    if (!u) return;
    setDoc(u.doc);
    setHistory(u.history);
    showToast(`Desfeito: ${u.label}.`);
  }, [doc, history, showToast]);

  const redoEdit = useCallback(() => {
    if (!doc) return;
    const r = redo(doc, history);
    if (!r) return;
    setDoc(r.doc);
    setHistory(r.history);
    showToast(`Refeito: ${r.label}.`);
  }, [doc, history, showToast]);

  /* ---------------- testes ---------------- */

  const stateOf = useCallback(
    (id: string) => results[id]?.state ?? "untested",
    [results],
  );

  const updateChannelResult = useCallback((id: string, result: TestResult) => {
    setResults((prev) => ({
      ...prev,
      [id]: result,
    }));
  }, []);

  const runTests = useCallback(
    async (ids: string[]) => {
      if (!doc || run.active || ids.length === 0) return;
      const byId = new Map(doc.channels.map((c) => [c.id, c]));
      const targets = ids
        .map((id) => byId.get(id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c && !c.deleted));
      if (targets.length === 0) return;

      const ctl = new AbortController();
      runCtlRef.current = ctl;

      const queuedAt = Date.now();
      setResults((prev) => {
        const next = { ...prev };
        for (const c of targets) {
          next[c.id] = {
            state: "queued",
            detail: "Aguardando na fila de testes.",
            checkedAt: queuedAt,
            durationMs: 0,
          };
        }
        return next;
      });
      setRun({ active: true, done: 0, total: targets.length });

      await ensureRelayAuthorized(
        targets.map((c) => c.url),
        ctl.signal,
      );

      const tasks = targets.map((c) => ({
        id: c.id,
        run: (signal: AbortSignal) => {
          setResults((prev) => ({
            ...prev,
            [c.id]: {
              state: "testing",
              detail: STATUS_TESTING_DETAIL,
              checkedAt: Date.now(),
              durationMs: 0,
            },
          }));
          return testChannelPlayback(c.url, { signal, directives: c.directives });
        },
      }));

      const outcome = await runPool(tasks, {
        concurrency: 3,
        signal: ctl.signal,
        onProgress: (p) => setRun({ active: true, done: p.done, total: p.total }),
        onTaskResult: (id, r) => {
          setResults((prev) => {
            const next = { ...prev };
            if (r.ok) {
              next[id] = r.value as TestResult;
            } else {
              next[id] = {
                state: "untested",
                detail: "Teste cancelado antes da conclusão.",
                checkedAt: Date.now(),
                durationMs: 0,
              };
            }
            return next;
          });
        },
      });

      setRun({ active: false, done: outcome.done, total: outcome.done });
      setResults((prev) => {
        const next = { ...prev };
        for (const [id, r] of Object.entries(next)) {
          if (isTransientState(r.state)) {
            next[id] = {
              state: "untested",
              detail: "Teste não concluído (cancelado).",
              checkedAt: Date.now(),
              durationMs: 0,
            };
          }
        }
        return next;
      });
      showToast(
        outcome.cancelled
          ? "Execução de testes cancelada (conexões encerradas)."
          : `Testes concluídos: ${outcome.done} canal(is) verificados.`,
      );
    },
    [doc, run.active, showToast],
  );

  const cancelTests = useCallback(() => {
    runCtlRef.current?.abort();
  }, []);

  /* ---------------- escopos de teste ---------------- */

  const visibleChannels = useMemo(() => doc?.channels.filter((c) => !c.deleted) ?? [], [doc]);

  const testableAllIds = useMemo(
    () => visibleChannels.filter((c) => !c.disabled).map((c) => c.id),
    [visibleChannels],
  );
  const failureIds = useMemo(
    () =>
      visibleChannels
        .filter((c) => !c.disabled && isFailureState(results[c.id]?.state ?? "untested"))
        .map((c) => c.id),
    [visibleChannels, results],
  );
  const testedIds = useMemo(
    () =>
      visibleChannels
        .filter((c) => {
          const st = results[c.id]?.state ?? "untested";
          return !c.disabled && st !== "untested" && !isTransientState(st);
        })
        .map((c) => c.id),
    [visibleChannels, results],
  );
  const staleIds = useMemo(
    () =>
      visibleChannels
        .filter((c) => {
          const r = results[c.id];
          if (!r || c.disabled || r.state === "untested" || isTransientState(r.state)) return false;
          return isResultStale(r.checkedAt);
        })
        .map((c) => c.id),
    [visibleChannels, results],
  );
  const untestedIds = useMemo(
    () =>
      visibleChannels
        .filter((c) => !c.disabled && (results[c.id]?.state ?? "untested") === "untested")
        .map((c) => c.id),
    [visibleChannels, results],
  );
  const selectedIds = useMemo(() => [...selection], [selection]);

  /* ---------------- limpeza ---------------- */

  const clearAllLocal = useCallback(async () => {
    runCtlRef.current?.abort();
    resetClientRelaySession();
    await clearLocalSession();
    setDoc(null);
    setResults({});
    setHistory(EMPTY_HISTORY);
    setSelection(new Set());
    setLastImport(null);
    showToast("Dados locais apagados deste navegador.");
  }, [showToast]);

  const toggleSelect = useCallback((id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setSelectionAll = useCallback((ids: string[]) => setSelection(new Set(ids)), []);
  const clearSelection = useCallback(() => setSelection(new Set()), []);

  const exportM3U = useCallback(
    (includeDisabled: boolean): ExportResult => {
      if (!doc)
        return { ok: false, content: "", exportedCount: 0, omittedDisabled: 0, omittedDeleted: 0 };
      return buildM3U(doc.channels, doc.headerAttrs, { includeDisabled });
    },
    [doc],
  );

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of visibleChannels) {
      const s = results[c.id]?.state ?? "untested";
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return counts;
  }, [visibleChannels, results]);

  return {
    hydrated,
    doc,
    results,
    history,
    selection,
    lastImport,
    toast,
    setToast,
    notify,
    run,
    refreshingOrigin,
    storageNotice,
    importParsed,
    refreshFromOriginUrl,
    edit,
    undoEdit,
    redoEdit,
    runTests,
    cancelTests,
    updateChannelResult,
    stateOf,
    visibleChannels,
    testableAllIds,
    failureIds,
    testedIds,
    staleIds,
    untestedIds,
    selectedIds,
    toggleSelect,
    setSelectionAll,
    clearSelection,
    clearAllLocal,
    exportM3U,
    statusCounts,
  };
}

const STATUS_TESTING_DETAIL = "Carregando manifesto e primeiro trecho de mídia pelo relay…";
