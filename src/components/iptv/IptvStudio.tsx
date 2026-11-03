"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Activity,
  CircleGauge,
  CircleHelp,
  FileEdit,
  FlaskConical,
  Loader2,
  Plus,
  Radio,
  ShieldCheck,
  X,
} from "lucide-react";
import { parseM3U } from "@/lib/m3u/parse";
import type { Channel } from "@/lib/iptv/types";
import type { TestState } from "@/lib/iptv/types";
import { docStats, listGroups } from "@/lib/playlist/store";
import { ChannelTable } from "./ChannelTable";
import {
  AddChannelDialog,
  ConfirmDialog,
  EditChannelDialog,
  ExportDialog,
  HelpDialog,
} from "./dialogs";
import { ImportPanel } from "./ImportPanel";
import { PlayerDialog } from "./PlayerDialog";
import { RunProgress, SelectionBar, StatsChips, Toolbar, type Filters } from "./Toolbar";
import { useStudio } from "./useStudio";

type ConfirmState =
  | {
      kind: "replace";
      content: string;
      name: string;
      sourceKind: "file" | "url" | "paste" | "server";
      sourceUrl?: string;
      accepted: number;
    }
  | { kind: "clearLocal" }
  | { kind: "restoreOriginal" }
  | { kind: "removeSelection" };

export function IptvStudio() {
  const studio = useStudio();
  const { doc, results, run, selection } = studio;

  const [filters, setFilters] = useState<Filters>({ q: "", group: null, statuses: new Set() });
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [watching, setWatching] = useState<Channel | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const stats = useMemo(() => (doc ? docStats(doc) : null), [doc]);
  const groups = useMemo(() => (doc ? listGroups(doc) : []), [doc]);

  const filtered = useMemo(() => {
    if (!doc) return [];
    const q = filters.q.trim().toLowerCase();
    return doc.channels.filter((c) => {
      if (c.deleted) return false;
      if (filters.group !== null && (c.group ?? "Sem grupo") !== filters.group) return false;
      if (filters.statuses.size > 0) {
        const s: TestState = results[c.id]?.state ?? "untested";
        if (!filters.statuses.has(s)) return false;
      }
      if (q) {
        const hay = `${c.name}\n${c.group ?? ""}\n${c.tvgName ?? ""}\n${c.url}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [doc, filters, results]);

  const deletedChannels = useMemo(() => doc?.channels.filter((c) => c.deleted) ?? [], [doc]);

  const hasFilters = filters.q.trim() !== "" || filters.group !== null || filters.statuses.size > 0;

  const toggleStatus = useCallback((s: TestState) => {
    setFilters((f) => {
      const next = new Set(f.statuses);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return { ...f, statuses: next };
    });
  }, []);

  /* ----------------------------- importação ----------------------------- */

  const handleReadyImport = useCallback(
    (
      content: string,
      name: string,
      kind: "file" | "url" | "paste" | "server",
      sourceUrl?: string,
    ) => {
      const parsed = parseM3U(content);
      if (!parsed.ok) {
        studio.notify(
          `${parsed.fatal ?? "Importação inválida: nenhum canal válido encontrado."}${
            doc ? " Sua playlist válida atual foi preservada." : ""
          }`,
        );
        return;
      }
      if (doc) {
        setConfirm({
          kind: "replace",
          content,
          name,
          sourceKind: kind,
          sourceUrl,
          accepted: parsed.channels.length,
        });
      } else {
        studio.importParsed(parsed, name, kind, sourceUrl);
      }
    },
    [doc, studio],
  );

  /* --------------------------- ações em lote --------------------------- */

  const selectedChannels = useMemo(
    () => doc?.channels.filter((c) => selection.has(c.id) && !c.deleted) ?? [],
    [doc, selection],
  );

  const disabledSelected = selectedChannels.filter((c) => !c.disabled).length;
  const enabledSelected = selectedChannels.length - disabledSelected;

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 pb-16 sm:px-6">
      {/* ------------------------------- header ------------------------------- */}
      <header className="sticky top-0 z-40 -mx-4 border-b border-line/70 bg-ink/85 px-4 backdrop-blur-md sm:-mx-6 sm:px-6">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-xl border border-mint/30 bg-mint/10">
            <Radio size={16} className="text-mint" aria-hidden />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-tight text-snow">
              Sinal <span className="font-mono font-normal text-fog">· Estúdio de Playlists</span>
            </div>
            {doc && (
              <div className="truncate font-mono text-[10.5px] text-fog">
                origem: {doc.sourceName} ({doc.sourceKind})
              </div>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {run.active && <RunProgressCompact done={run.done} total={run.total} />}
            <button className="btn !px-2.5" onClick={() => setHelpOpen(true)} aria-label="Ajuda e privacidade" title="Ajuda e privacidade">
              <CircleHelp size={16} />
            </button>
          </div>
        </div>
      </header>

      {!studio.hydrated ? (
        <div className="grid flex-1 place-items-center py-32" role="status">
          <Loader2 size={22} className="animate-spin text-mint" aria-hidden />
          <span className="sr-only">Restaurando sessão local…</span>
        </div>
      ) : !doc ? (
        /* ------------------------------ estado vazio / hero ------------------------------ */
        <main className="anim-rise py-10 sm:py-16">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl border border-mint/25 bg-mint/8">
              <span className="flex items-end gap-[3px]" aria-hidden>
                {[10, 18, 26, 14].map((h, i) => (
                  <span key={i} className="eq-bar block w-1.5 rounded-sm bg-mint" style={{ height: h, animationDelay: `${i * 0.13}s` }} />
                ))}
              </span>
            </div>
            <h1 className="text-balance text-[clamp(1.8rem,4.5vw,3rem)] font-bold leading-[1.05] tracking-tight text-snow">
              Teste sua lista IPTV com <span className="text-mint">evidência real de reprodução</span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-pretty text-sm leading-relaxed text-fog2 sm:text-base">
              Importe uma playlist M3U e descubra — canal a canal — o que de fato toca neste
              navegador. Edite, organize e exporte sem perder a versão original. Nada sai do seu
              aparelho.
            </p>
          </div>

          <ImportPanel onReady={handleReadyImport} lastImport={studio.lastImport} />

          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              {
                icon: FlaskConical,
                title: "Playback real, não ping",
                text: "Cada canal é testado no player de verdade (hls.js/HLS nativo). HTTP 200 sozinho nunca vira “online”.",
              },
              {
                icon: FileEdit,
                title: "Edição reversível",
                text: "Renomeie, agrupe, desative, remova — tudo com desfazer. A playlist original fica sempre intacta.",
              },
              {
                icon: ShieldCheck,
                title: "Privado por padrão",
                text: "Listas, edições e resultados ficam no IndexedDB do seu navegador. Sem analytics, sem terceiros.",
              },
            ].map((f) => (
              <div key={f.title} className="card p-5">
                <f.icon size={17} className="mb-3 text-mint" aria-hidden />
                <h2 className="text-sm font-semibold text-snow">{f.title}</h2>
                <p className="mt-1.5 text-xs leading-relaxed text-fog">{f.text}</p>
              </div>
            ))}
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-fog">
            Nem toda lista funcionará: CORS e codecs limitam o que um navegador pode tocar — os estados
            do teste explicam exatamente a etapa que falhou.
          </p>
        </main>
      ) : (
        /* ------------------------------- workspace ------------------------------- */
        <main className="anim-rise space-y-4 pt-5">
          {studio.storageNotice === "unavailable" && (
            <div className="rounded-xl border border-amber/30 bg-amber/5 px-4 py-2.5 text-xs text-amber" role="alert">
              Armazenamento local indisponível neste navegador: suas edições não serão salvas entre sessões.
            </div>
          )}
          {studio.storageNotice === "quota" && (
            <div className="rounded-xl border border-amber/30 bg-amber/5 px-4 py-2.5 text-xs text-amber" role="alert">
              Não foi possível salvar localmente (cota cheia ou modo privado). Exporte sua playlist para não perder as edições.
            </div>
          )}

          {/* resumo */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="card flex items-center gap-2.5 !rounded-xl px-4 py-2.5">
              <CircleGauge size={15} className="text-mint" aria-hidden />
              <span className="text-sm text-fog2">
                <strong className="font-mono text-snow">{stats?.total ?? 0}</strong> canais ·{" "}
                <strong className="font-mono text-snow">{groups.length}</strong> grupos
                {stats && stats.disabled > 0 && (
                  <>
                    {" "}· <strong className="font-mono text-amber">{stats.disabled}</strong> desativados
                  </>
                )}
                {stats && stats.deleted > 0 && (
                  <>
                    {" "}· <strong className="font-mono text-rose">{stats.deleted}</strong> na lixeira
                  </>
                )}
              </span>
            </div>
            <StatsChips
              counts={studio.statusCounts}
              active={filters.statuses}
              onToggle={toggleStatus}
              onClear={() => setFilters((f) => ({ ...f, statuses: new Set() }))}
            />
            <div className="ml-auto">
              <button className="btn !text-xs" onClick={() => setImportOpen((v) => !v)} aria-expanded={importOpen}>
                <Plus size={13} className={importOpen ? "rotate-45 transition-transform" : "transition-transform"} />
                Importar outra playlist
              </button>
            </div>
          </div>

          {importOpen && (
              <div className="anim-rise">
                <ImportPanel
                  onReady={handleReadyImport}
                  lastImport={studio.lastImport}
                  hasExistingPlaylist={Boolean(doc)}
                />
              </div>
            )}

          {run.active && <RunProgress run={run} onCancel={studio.cancelTests} />}

          <Toolbar
            filters={filters}
            onFilters={setFilters}
            groups={groups}
            canUndo={studio.history.past.length > 0}
            canRedo={studio.history.future.length > 0}
            onUndo={studio.undoEdit}
            onRedo={studio.redoEdit}
            run={run}
            onTestAll={() => studio.runTests(studio.testableAllIds)}
            onTestFailures={() => studio.runTests(studio.failureIds)}
            onRevalidateTested={() =>
              studio.runTests(
                studio.staleIds.length > 0 ? studio.staleIds : studio.testedIds,
              )
            }
            failureCount={studio.failureIds.length}
            testedCount={studio.testedIds.length}
            staleCount={studio.staleIds.length}
            untestedCount={studio.untestedIds.length}
            totalCount={stats?.total ?? 0}
            canRefreshOrigin={Boolean(doc?.sourceUrl)}
            refreshingOrigin={studio.refreshingOrigin}
            onRefreshOrigin={() => void studio.refreshFromOriginUrl()}
            onDisableFailures={() => {
              if (studio.failureIds.length > 0) {
                studio.edit({
                  type: "setDisabled",
                  ids: studio.failureIds,
                  disabled: true,
                });
              }
            }}
            onAdd={() => setAdding(true)}
            onExport={() => setExporting(true)}
            onRestoreOriginal={() => setConfirm({ kind: "restoreOriginal" })}
            onClearLocal={() => setConfirm({ kind: "clearLocal" })}
          />

          {selection.size > 0 && (
            <SelectionBar
              count={selection.size}
              groups={groups}
              onTest={() => studio.runTests(studio.selectedIds)}
              onMove={(group) => {
                studio.edit({ type: "setGroup", ids: [...selection], group });
                studio.clearSelection();
              }}
              onDisable={() => {
                studio.edit({ type: "setDisabled", ids: [...selection], disabled: true }, { silent: true });
                studio.clearSelection();
                studio.notify(`Desativados ${disabledSelected} canal(is). Use Desfazer para reverter.`);
              }}
              onEnable={() => {
                studio.edit({ type: "setDisabled", ids: [...selection], disabled: false }, { silent: true });
                studio.clearSelection();
                studio.notify(`Reativados ${enabledSelected} canal(is).`);
              }}
              onRemove={() => setConfirm({ kind: "removeSelection" })}
              onClear={studio.clearSelection}
            />
          )}

          <ChannelTable
            channels={filtered}
            results={results}
            selection={selection}
            onToggleSelect={studio.toggleSelect}
            onSelectAllShown={studio.setSelectionAll}
            onClearSelection={studio.clearSelection}
            onTest={(id) => studio.runTests([id])}
            onWatch={setWatching}
            onEdit={setEditing}
            onToggleDisable={(c) =>
              studio.edit({ type: "setDisabled", ids: [c.id], disabled: !c.disabled })
            }
            onRemove={(c) => studio.edit({ type: "remove", ids: [c.id] })}
            truncatedInfo={null}
            hasFilters={hasFilters}
            onClearFilters={() => setFilters({ q: "", group: null, statuses: new Set() })}
            deletedChannels={deletedChannels}
            onRestoreDeleted={() =>
              studio.edit({ type: "restoreDeleted", ids: deletedChannels.map((c) => c.id) })
            }
            runActive={run.active}
          />

          <footer className="pt-2 text-center text-[11px] leading-relaxed text-fog">
            Privacidade: listas, edições e resultados ficam apenas neste navegador (IndexedDB).
            Nenhum dado vai para terceiros. Resultados de teste são do momento do teste — streams
            ao vivo mudam.
          </footer>
        </main>
      )}

      {/* --------------------------------- toast --------------------------------- */}
      {studio.toast && (
        <div
          key={studio.toast.id}
          className="anim-dialog fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-line2 bg-panel2 px-4 py-3 shadow-2xl"
          role="status"
        >
          <Activity size={14} className="shrink-0 text-mint" aria-hidden />
          <span className="max-w-md text-sm text-snow">{studio.toast.message}</span>
          {studio.toast.undoable && (
            <button
              className="shrink-0 text-sm font-semibold text-mint underline-offset-2 hover:underline"
              onClick={() => {
                studio.undoEdit();
                studio.setToast(null);
              }}
            >
              Desfazer
            </button>
          )}
          <button
            className="shrink-0 rounded-md p-1 text-fog transition-colors hover:text-snow"
            onClick={() => studio.setToast(null)}
            aria-label="Fechar aviso"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* --------------------------------- diálogos --------------------------------- */}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {watching && (
        <PlayerDialog
          channel={watching}
          onClose={() => setWatching(null)}
          onPlaybackResult={studio.updateChannelResult}
        />
      )}
      {editing && doc && (
        <EditChannelDialog
          channel={editing}
          doc={doc}
          onClose={() => setEditing(null)}
          onSave={({ name, logo, group }) => {
            const r = studio.edit(
              { type: "updateChannel", id: editing.id, name, logo, group },
              { silent: true },
            );
            setEditing(null);
            studio.notify(
              r?.ok
                ? "Canal atualizado. Use Desfazer para reverter."
                : `Não foi possível salvar: ${r?.error ?? "dados inválidos"}.`,
            );
          }}
        />
      )}
      {adding && doc && (
        <AddChannelDialog
          doc={doc}
          onClose={() => setAdding(false)}
          onAdd={({ name, url, group }) => {
            const r = studio.edit(
              { type: "addChannel", name, url, group },
              { silent: true },
            );
            setAdding(false);
            studio.notify(
              r?.ok
                ? `“${name}” adicionado como “Ainda não testado” — rode um teste para verificar.`
                : `Não foi possível adicionar: ${r?.error ?? "dados inválidos"}.`,
            );
          }}
        />
      )}
      {exporting && stats && (
        <ExportDialog
          disabledCount={stats.disabled}
          deletedCount={stats.deleted}
          onCompute={(includeDisabled) => studio.exportM3U(includeDisabled)}
          onClose={() => setExporting(false)}
        />
      )}
      {confirm?.kind === "clearLocal" && (
        <ConfirmDialog
          title="Apagar dados locais"
          danger
          confirmLabel="Apagar tudo deste navegador"
          lines={[
            "Remove a playlist importada, TODAS as edições e os resultados de teste guardados neste navegador.",
            "Se precisar, exporte a versão atual antes (botão Exportar).",
          ]}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void studio.clearAllLocal();
          }}
        />
      )}
      {confirm?.kind === "restoreOriginal" && (
        <ConfirmDialog
          title="Restaurar playlist original"
          confirmLabel="Restaurar versão original"
          lines={[
            "A cópia de trabalho volta exatamente ao estado da importação original.",
            `${stats?.total ?? 0} canais originais retornados; edições e canais manuais da cópia atual serão descartados.`,
            "Você ainda poderá desfazer esta ação.",
          ]}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            studio.edit({ type: "restoreOriginal" });
          }}
        />
      )}
      {confirm?.kind === "removeSelection" && (
        <ConfirmDialog
          title={`Remover ${selection.size} canal(is)?`}
          danger
          confirmLabel={`Remover ${selection.size} canal(is)`}
          lines={[
            ...selectedChannels.slice(0, 6).map((c) => `“${c.name}” (${c.group ?? "Sem grupo"})`),
            ...(selection.size > 6 ? [`… e mais ${selection.size - 6} canal(is).`] : []),
            "Eles vão para a lixeira e ficam fora da exportação. É possível desfazer e restaurar depois.",
          ]}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            studio.edit({ type: "remove", ids: [...selection] });
            studio.clearSelection();
          }}
        />
      )}
      {confirm?.kind === "replace" && (
        <ConfirmDialog
          title="Substituir a playlist atual?"
          confirmLabel={`Importar ${confirm.accepted} canais`}
          lines={[
            `Nova origem: “${confirm.name}” com ${confirm.accepted} canais reconhecidos.`,
            "A lista atual, suas edições e o histórico de desfazer serão substituídos.",
            "Os resultados de teste antigos serão descartados. Exporte antes, se precisar.",
          ]}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const parsed = parseM3U(confirm.content);
            setConfirm(null);
            if (parsed.ok) {
              studio.importParsed(parsed, confirm.name, confirm.sourceKind, confirm.sourceUrl);
              setImportOpen(false);
            }
          }}
        />
      )}
    </div>
  );
}

function RunProgressCompact({ done, total }: { done: number; total: number }) {
  return (
    <span className="hidden items-center gap-2 rounded-full border border-cyanx/30 bg-cyanx/5 px-3 py-1 font-mono text-[11px] text-cyanx sm:flex">
      <Loader2 size={11} className="animate-spin" aria-hidden />
      {done}/{total}
    </span>
  );
}
