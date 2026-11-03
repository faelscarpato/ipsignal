"use client";

import { useCallback, useRef, useState } from "react";
import {
  ClipboardPaste,
  FileUp,
  Globe,
  HardDriveDownload,
  ListVideo,
  Loader2,
  Server,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  classifyImportFetchError,
  classifyImportHttpStatus,
  IMPORT_ERROR_MESSAGES,
  type ImportErrorKind,
} from "@/lib/iptv/classify";
import { LIMITS, readPlaylistFile, type ParseIssue } from "@/lib/m3u/parse";
import { redactUrl } from "@/lib/iptv/redact";
import { validateHttpUrl } from "@/lib/iptv/validate";
import type { PlaylistDoc } from "@/lib/playlist/store";

type Tab = "file" | "url" | "paste";

interface ImportErrorView {
  kind: ImportErrorKind;
  extra?: string;
}

export function buildDemoPlaylist(origin?: string): string {
  const base =
    origin ?? (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000");
  return `#EXTM3U
#EXTINF:-1 tvg-id="mux.bbb" group-title="Streams Reais de Teste",Mux — Big Buck Bunny (Stream Real HLS via Relay)
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 tvg-id="apple.bipbop" group-title="Streams Reais de Teste",Apple — BipBop 4x3 (Stream Real HLS via Relay)
https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8
#EXTINF:-1 tvg-id="local.tone" group-title="Fixtures Locais",Fixture Local — Sinal de Áudio 440Hz (Playback Garantido)
${base}/api/test-streams/live-tone.wav
#EXTINF:-1 tvg-id="local.unconfirmed" group-title="Fixtures Locais",Fixture Local — Manifesto OK sem Mídia (Acessível s/ Playback)
${base}/api/test-streams/unconfirmed/index.m3u8
#EXTINF:-1 tvg-id="local.invalid" group-title="Fixtures Locais",Fixture Local — Manifesto Inválido (HTML em vez de M3U8)
${base}/api/test-streams/invalid/index.m3u8
#EXTINF:-1 tvg-id="local.offline" group-title="Fixtures Locais",Fixture Local — Origem Indisponível (HTTP 404)
${base}/api/test-streams/offline/index.m3u8
`;
}

export function ImportPanel({
  onReady,
  lastImport,
  hasExistingPlaylist = false,
}: {
  onReady: (
    content: string,
    sourceName: string,
    kind: PlaylistDoc["sourceKind"],
    sourceUrl?: string,
  ) => void;
  lastImport: { issues: ParseIssue[]; sourceName: string; at: number } | null;
  hasExistingPlaylist?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("file");
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState<null | { label: string; bytes?: number }>(null);
  const [error, setError] = useState<ImportErrorView | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [pasteInput, setPasteInput] = useState("");
  const [corsTarget, setCorsTarget] = useState<string | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<{ abort: () => void } | null>(null);

  const startBusy = (label: string) => {
    setError(null);
    setCorsTarget(null);
    setBusy({ label });
  };

  const fail = (kind: ImportErrorKind, extra?: string) => {
    setBusy(null);
    setError({ kind, extra });
  };

  /* ------------------------------ arquivo ------------------------------ */

  const handleFile = useCallback(
    async (file: File) => {
      startBusy(`Lendo ${file.name}…`);
      try {
        const text = await readPlaylistFile(file, LIMITS.maxTextBytes);
        onReady(text, file.name, "file");
      } catch (err) {
        fail("too_large", err instanceof Error ? err.message : undefined);
      } finally {
        setBusy(null);
      }
    },
    [onReady],
  );

  /* ------------------------------- URL -------------------------------- */

  const fetchFromServer = useCallback(
    async (targetUrl?: string) => {
      const target = (targetUrl ?? corsTarget ?? urlInput).trim();
      if (!target) return;
      startBusy("Buscando pelo serviço do aplicativo (proteção SSRF ativa)…");
      try {
        const res = await fetch("/api/import-playlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: target }),
        });
        const data = (await res.json()) as
          | { ok: true; content: string; from: string }
          | { ok: false; kind: ImportErrorKind; message: string };
        setBusy(null);
        if (data.ok) {
          setCorsTarget(null);
          onReady(data.content, data.from, "server", target);
        } else {
          setCorsTarget(target);
          fail(data.kind, data.message);
        }
      } catch {
        setCorsTarget(target);
        fail("network", "Falha ao contactar o serviço local do aplicativo.");
      }
    },
    [corsTarget, urlInput, onReady],
  );

  const fetchFromUrl = useCallback(async () => {
    const check = validateHttpUrl(urlInput);
    if (!check.ok) {
      fail("invalid_content", check.reason);
      return;
    }
    const raw = urlInput.trim();
    const ctl = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, 15000);
    abortRef.current = { abort: () => ctl.abort() };
    startBusy("Conectando à origem da playlist…");
    try {
      const res = await fetch(raw, { signal: ctl.signal, redirect: "follow" });
      if (!res.ok) {
        fail(classifyImportHttpStatus(res.status), `HTTP ${res.status}`);
        return;
      }
      const contentLength = Number(res.headers.get("content-length") ?? 0);
      if (contentLength > LIMITS.maxTextBytes) {
        fail("too_large", `O servidor anunciou ${(contentLength / 1024 / 1024).toFixed(1)} MB.`);
        return;
      }
      if (!res.body) {
        fail("network", "Resposta sem corpo legível.");
        return;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > LIMITS.maxTextBytes) {
          ctl.abort();
          fail("too_large", "O conteúdo excede o limite de tamanho.");
          return;
        }
        chunks.push(value);
        setBusy({ label: "Baixando playlist…", bytes: total });
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      const text = new TextDecoder("utf-8").decode(merged);
      setBusy(null);
      onReady(text, redactUrl(raw), "url", raw);
    } catch (err) {
      const kind = classifyImportFetchError(err, timedOut);
      if (kind === "cors") {
        // Quando o browser bloqueia por CORS, usa automaticamente o serviço do projeto
        clearTimeout(timeout);
        abortRef.current = null;
        await fetchFromServer(raw);
        return;
      }
      setBusy(null);
      if (kind !== "aborted") {
        setCorsTarget(raw);
        fail(kind);
      } else {
        setError(null);
      }
    } finally {
      clearTimeout(timeout);
      abortRef.current = null;
    }
  }, [urlInput, onReady, fetchFromServer]);

  /* ------------------------------- colar ------------------------------- */

  const handlePaste = useCallback(() => {
    const text = pasteInput.trim();
    if (!text) {
      fail("invalid_content", "A área está vazia.");
      return;
    }
    if (text.length > LIMITS.maxPasteBytes) {
      fail("too_large", `Texto excede ${Math.round(LIMITS.maxPasteBytes / 1024 / 1024)} MB.`);
      return;
    }
    onReady(text, "texto colado", "paste");
  }, [pasteInput, onReady]);

  const errorMeta = error ? IMPORT_ERROR_MESSAGES[error.kind] : null;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-1 border-b border-line p-2" role="tablist" aria-label="Modo de importação">
        {(
          [
            ["file", "Arquivo .m3u / .m3u8", FileUp],
            ["url", "URL http(s)", Globe],
            ["paste", "Colar texto", ClipboardPaste],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              setError(null);
            }}
            className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
              tab === key ? "bg-panel3 text-snow" : "text-fog hover:text-fog2"
            }`}
          >
            <Icon size={15} aria-hidden />
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{label.split(" ")[0]}</span>
          </button>
        ))}
      </div>

      <div className="p-4 sm:p-5">
        {tab === "file" && (
          <div
            role="button"
            tabIndex={0}
            aria-label="Selecionar ou arrastar arquivo de playlist"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
            }}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
            className={`grid cursor-pointer place-items-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center transition-colors ${
              dragOver ? "border-mint bg-mint/5" : "border-line2 hover:border-[#3a4763] hover:bg-panel2"
            }`}
          >
            <HardDriveDownload size={26} className={dragOver ? "text-mint" : "text-fog"} aria-hidden />
            <div className="text-sm">
              <span className="font-medium text-snow">Arraste um arquivo</span>{" "}
              <span className="text-fog">ou clique para escolher</span>
            </div>
            <p className="max-w-md text-xs leading-relaxed text-fog">
              O arquivo é lido e validado localmente no seu navegador. Limite de{" "}
              {Math.round(LIMITS.maxTextBytes / 1024 / 1024)} MB · até{" "}
              {LIMITS.maxEntries.toLocaleString("pt-BR")} canais. O conteúdo precisa ser M3U válido
              (#EXTM3U/#EXTINF).
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {tab === "url" && (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                className="input font-mono"
                placeholder="https://provedor.exemplo/lista.m3u8"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                inputMode="url"
                aria-label="URL da playlist"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy && urlInput.trim()) void fetchFromUrl();
                }}
              />
              <button
                className="btn btn-primary shrink-0"
                disabled={Boolean(busy) || !urlInput.trim()}
                onClick={() => void fetchFromUrl()}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
                Buscar playlist
              </button>
            </div>
            <p className="flex items-center gap-1.5 text-xs leading-relaxed text-fog">
              <ShieldCheck size={13} className="shrink-0 text-mint" aria-hidden />
              Se a origem bloquear leitura direta no navegador (CORS), a busca é encaminhada
              automaticamente pelo serviço integrado do projeto com validação SSRF.
            </p>
          </div>
        )}

        {tab === "paste" && (
          <div className="space-y-3">
            <textarea
              className="input min-h-36 resize-y font-mono text-xs leading-relaxed"
              placeholder={'#EXTM3U\n#EXTINF:-1 tvg-id="x" group-title="News",Canal X\nhttps://…'}
              value={pasteInput}
              onChange={(e) => setPasteInput(e.target.value)}
              aria-label="Conteúdo M3U colado"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] text-fog">
                {(pasteInput.length / 1024).toFixed(1)} KB / {Math.round(LIMITS.maxPasteBytes / 1024)} KB
              </span>
              <button className="btn btn-primary" disabled={!pasteInput.trim()} onClick={handlePaste}>
                <ClipboardPaste size={14} /> Importar texto
              </button>
            </div>
          </div>
        )}

        {busy && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-cyanx/25 bg-cyanx/5 px-4 py-3">
            <div className="flex items-center gap-2.5 text-sm text-cyanx" role="status">
              <Loader2 size={15} className="animate-spin" aria-hidden />
              <span>
                {busy.label}
                {typeof busy.bytes === "number" && (
                  <span className="font-mono text-xs"> {(busy.bytes / 1024).toFixed(0)} KB</span>
                )}
              </span>
            </div>
            {abortRef.current && (
              <button
                className="btn !px-2.5 !py-1 !text-xs"
                onClick={() => abortRef.current?.abort()}
                aria-label="Cancelar busca"
              >
                <X size={13} /> Cancelar
              </button>
            )}
          </div>
        )}

        {errorMeta && (
          <div className="mt-4 rounded-xl border border-amber/30 bg-amber/5 p-4" role="alert">
            <div className="flex items-start gap-2.5">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-amber">{errorMeta.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-fog2">{errorMeta.hint}</p>
                {error?.extra && <p className="mt-1 font-mono text-[11px] text-fog">{error.extra}</p>}
                {hasExistingPlaylist && (
                  <p className="mt-1.5 text-xs font-medium text-mint">
                    Sua playlist válida atual e suas edições foram preservadas sem alterações.
                  </p>
                )}
                {(error?.kind === "cors" || error?.kind === "network" || error?.kind === "timeout") &&
                  corsTarget && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        className="btn !border-mint/40 !text-mint hover:!bg-mint/10"
                        onClick={() => void fetchFromServer(corsTarget)}
                      >
                        <Server size={13} /> Tentar novamente pelo servidor
                      </button>
                    </div>
                  )}
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
          <button
            className="flex items-center gap-2 text-xs text-fog transition-colors hover:text-fog2"
            onClick={() => onReady(buildDemoPlaylist(), "exemplo de demonstração", "paste")}
          >
            <ListVideo size={13} aria-hidden />
            Sem playlist à mão? Carregar exemplo (streams reais + fixtures locais)
          </button>
          {lastImport && (
            <button
              className="text-xs text-fog underline-offset-2 transition-colors hover:text-fog2 hover:underline"
              onClick={() => setIssuesOpen((v) => !v)}
            >
              {lastImport.issues.length > 0
                ? `${lastImport.issues.length} avisos/erros da última importação`
                : "Última importação sem problemas"}
            </button>
          )}
        </div>

        {issuesOpen && lastImport && (
          <ul className="mt-3 max-h-56 space-y-1.5 overflow-y-auto rounded-xl border border-line bg-panel2 p-3 text-xs">
            {lastImport.issues.length === 0 && <li className="text-fog">Nenhum problema registrado.</li>}
            {lastImport.issues.slice(0, 200).map((issue, i) => (
              <li key={i} className="flex gap-2">
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                    issue.severity === "error" ? "bg-rose" : "bg-amber"
                  }`}
                  aria-hidden
                />
                <span className="text-fog2">
                  <span className="font-mono text-fog">L{issue.line}</span> {issue.message}
                  {issue.snippet && (
                    <span className="block truncate font-mono text-[10.5px] text-fog/70">
                      {issue.snippet}
                    </span>
                  )}
                </span>
              </li>
            ))}
            {lastImport.issues.length > 200 && (
              <li className="text-fog">… e mais {lastImport.issues.length - 200} ocorrências.</li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
