"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CircleAlert,
  Copy,
  Download,
  Info,
  ListChecks,
  ShieldCheck,
  Trash2,
  Tv,
  X,
} from "lucide-react";
import { redactUrl } from "@/lib/iptv/redact";
import { STATUS_META, RESULT_STATES } from "@/lib/iptv/status";
import type { Channel } from "@/lib/iptv/types";
import { sanitizeGroup, validateHttpUrl, validateLogoUrl } from "@/lib/iptv/validate";
import { listGroups } from "@/lib/playlist/store";
import type { PlaylistDoc } from "@/lib/playlist/store";

/* ------------------------------- base ------------------------------- */

export function Dialog({
  title,
  icon,
  onClose,
  children,
  wide,
}: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>("input, button, textarea, select")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`anim-dialog card max-h-[92dvh] w-full overflow-y-auto p-5 sm:p-6 ${
          wide ? "max-w-3xl" : "max-w-lg"
        }`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2.5 text-base font-semibold tracking-tight text-snow">
            {icon}
            {title}
          </h2>
          <button className="btn !px-2 !py-1.5" onClick={onClose} aria-label="Fechar diálogo">
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* --------------------------- confirmação --------------------------- */

export function ConfirmDialog({
  title,
  lines,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  lines: string[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      icon={<CircleAlert size={17} className={danger ? "text-rose" : "text-amber"} />}
      onClose={onClose}
    >
      <ul className="mb-5 space-y-1.5 text-sm text-fog2">
        {lines.map((l, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-line2" aria-hidden />
            <span>{l}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          Voltar
        </button>
        <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

/* ------------------------- editar canal ------------------------- */

export function EditChannelDialog({
  channel,
  doc,
  onSave,
  onClose,
}: {
  channel: Channel;
  doc: PlaylistDoc;
  onSave: (fields: { name: string; logo: string; group: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(channel.name);
  const [logo, setLogo] = useState(channel.tvgLogo ?? "");
  const [group, setGroup] = useState(channel.group ?? "");
  const groups = listGroups(doc);

  const logoInvalid = logo.trim() !== "" && !validateLogoUrl(logo).ok;
  const nameEmpty = name.trim() === "";

  return (
    <Dialog title="Editar canal" icon={<Tv size={16} className="text-cyanx" />} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!nameEmpty && !logoInvalid) onSave({ name: name.trim(), logo: logo.trim(), group: group.trim() });
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fog2">Nome</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={300} />
          {nameEmpty && <span className="mt-1 block text-xs text-rose">O nome não pode ficar vazio.</span>}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fog2">Logo (URL http/https, opcional)</span>
          <input
            className="input"
            value={logo}
            onChange={(e) => setLogo(e.target.value)}
            placeholder="https://…"
            inputMode="url"
          />
          {logoInvalid && (
            <span className="mt-1 block text-xs text-rose">Use uma URL http/https válida ou deixe vazio.</span>
          )}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fog2">Grupo (novo ou existente)</span>
          <input
            className="input"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            list="groups-list"
            placeholder="Ex.: Esportes"
            maxLength={120}
          />
          <datalist id="groups-list">
            {groups.map((g) => (
              <option key={g.name} value={g.name} />
            ))}
          </datalist>
        </label>
        <div className="rounded-xl border border-line bg-panel2 p-3 text-xs text-fog">
          URL do stream (não editável; exibida sem credenciais):
          <div className="mt-1 truncate font-mono text-fog2">{redactUrl(channel.url)}</div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={nameEmpty || logoInvalid}>
            Salvar alterações
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------- adicionar canal ------------------------- */

export function AddChannelDialog({
  doc,
  onAdd,
  onClose,
}: {
  doc: PlaylistDoc;
  onAdd: (fields: { name: string; url: string; group: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [group, setGroup] = useState("");
  const groups = listGroups(doc);
  const urlCheck = url.trim() ? validateHttpUrl(url) : null;
  const canSave = name.trim() !== "" && urlCheck?.ok === true;

  return (
    <Dialog title="Adicionar canal manualmente" icon={<Tv size={16} className="text-mint" />} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) onAdd({ name: name.trim(), url: url.trim(), group: group.trim() });
        }}
      >
        <div className="rounded-xl border border-amber/30 bg-amber/5 p-3 text-xs leading-relaxed text-amber">
          O canal entra como <strong>“Ainda não testado”</strong>. Nada presume que ele funciona —
          rode um teste de reprodução para verificar de verdade.
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fog2">Nome</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={300} placeholder="Nome do canal" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fog2">URL do stream (http/https)</span>
          <input
            className="input font-mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://servidor/canal.m3u8"
            inputMode="url"
          />
          {url.trim() !== "" && urlCheck && !urlCheck.ok && (
            <span className="mt-1 block text-xs text-rose">{urlCheck.reason}.</span>
          )}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fog2">Grupo (opcional)</span>
          <input
            className="input"
            value={group}
            onChange={(e) => setGroup(sanitizeGroup(e.target.value))}
            list="groups-list"
            maxLength={120}
          />
          <datalist id="groups-list">
            {groups.map((g) => (
              <option key={g.name} value={g.name} />
            ))}
          </datalist>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSave}>
            Adicionar canal
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* --------------------------- export --------------------------- */

export interface ExportSummary {
  exportedCount: number;
  omittedDisabled: number;
  omittedDeleted: number;
  ok: boolean;
  reason?: string;
}

export function ExportDialog({
  disabledCount,
  deletedCount,
  onCompute,
  onClose,
}: {
  disabledCount: number;
  deletedCount: number;
  onCompute: (includeDisabled: boolean) => { ok: boolean; content: string } & ExportSummary;
  onClose: () => void;
}) {
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [copied, setCopied] = useState(false);
  const preview = onCompute(includeDisabled);

  const download = () => {
    if (!preview.ok) return;
    const blob = new Blob([preview.content], { type: "audio/x-mpegurl;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sinal-playlist-editada.m3u";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <Dialog title="Exportar playlist M3U" icon={<Download size={16} className="text-cyanx" />} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-fog2">
          A exportação contém <strong className="text-snow">apenas a versão editada</strong>. A playlist
          original permanece intacta e recuperável em “Restaurar original”.
        </p>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-panel2 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 accent-[#4de8b6]"
            checked={includeDisabled}
            onChange={(e) => setIncludeDisabled(e.target.checked)}
          />
          <span>
            Incluir canais desativados
            <span className="mt-0.5 block text-xs text-fog">
              {disabledCount} desativado(s) — por padrão ficam de fora do arquivo.
            </span>
          </span>
        </label>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl border border-mint/25 bg-mint/5 p-3">
            <div className="font-mono text-xl font-semibold text-mint">{preview.exportedCount}</div>
            <div className="text-[11px] text-fog">exportados</div>
          </div>
          <div className="rounded-xl border border-amber/25 bg-amber/5 p-3">
            <div className="font-mono text-xl font-semibold text-amber">{preview.omittedDisabled}</div>
            <div className="text-[11px] text-fog">desativados omitidos</div>
          </div>
          <div className="rounded-xl border border-rose/25 bg-rose/5 p-3">
            <div className="font-mono text-xl font-semibold text-rose">{deletedCount}</div>
            <div className="text-[11px] text-fog">excluídos (sempre omitidos)</div>
          </div>
        </div>
        {!preview.ok && <p className="text-sm text-rose">{preview.reason}</p>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button
            className="btn"
            disabled={!preview.ok}
            onClick={() => {
              navigator.clipboard?.writeText(preview.content).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              });
            }}
          >
            <Copy size={14} /> {copied ? "Copiado!" : "Copiar texto"}
          </button>
          <button className="btn btn-primary" disabled={!preview.ok} onClick={download}>
            <Download size={14} /> Baixar .m3u
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/* --------------------------- ajuda / privacidade --------------------------- */

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Como funciona · privacidade" icon={<Info size={16} className="text-cyanx" />} onClose={onClose} wide>
      <div className="space-y-5 text-sm leading-relaxed text-fog2">
        <section>
          <h3 className="mb-2 flex items-center gap-2 font-semibold text-snow">
            <ShieldCheck size={15} className="text-mint" /> Onde ficam seus dados e como o Relay funciona
          </h3>
          <p>
            Listas, edições e resultados ficam <strong>somente neste aparelho</strong>, no armazenamento
            local do navegador (IndexedDB). Para evitar falhas por bloqueio de CORS nos servidores IPTV,
            o aplicativo utiliza um <strong>relay de mídia integrado</strong> (<code>/api/stream-relay</code>)
            restrito à sua sessão e às fontes que você autorizou, com proteção SSRF, reescrita automática
            de manifestos HLS (master, variantes, segmentos e chaves) e streaming incremental sem salvar
            vídeo em disco ou memória.
          </p>
        </section>
        <section>
          <h3 className="mb-2 font-semibold text-snow">O que cada estado significa</h3>
          <ul className="space-y-1.5">
            {RESULT_STATES.map((s) => (
              <li key={s} className="flex gap-2">
                <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-mint/60" aria-hidden />
                <span>
                  <strong className="text-fog2">{STATUS_META[s].label}:</strong>{" "}
                  <span className="text-fog">
                    {STATUS_META[s].description} <em>Próximo passo: {STATUS_META[s].nextStep}</em>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mb-2 font-semibold text-snow">Limites técnicos de codecs no navegador</h3>
          <p>
            O relay resolve bloqueios de CORS, redirecionamentos e referências relativas de HLS, e o
            motor <code>hls.js</code> faz remux em tempo real de segmentos MPEG-TS (<code>.ts</code>) para
            fMP4 via Media Source Extensions. Contudo, streams que utilizam codecs sem decodificador no
            navegador (ex.: áudio Dolby AC-3/E-AC-3, vídeo HEVC/H.265 sem suporte de hardware, contêineres
            <code>.mkv</code>/<code>.avi</code> ou protocolos <code>rtmp://</code>/<code>rtsp://</code>)
            exigem transcodificação externa (como um servidor FFmpeg dedicado) e são classificados como{" "}
            <strong>Formato/codec incompatível</strong>.
          </p>
        </section>
        <section>
          <h3 className="mb-2 flex items-center gap-2 font-semibold text-snow">
            <ListChecks size={15} className="text-mint" /> Boas práticas
          </h3>
          <p>
            Streams ao vivo mudam o tempo todo: cada resultado mostra <em>quando</em> foi testado e
            quanto levou. Re-teste “apenas falhas” em vez de varrer a lista inteira com frequência, para
            não sobrecarregar o provedor (a concorrência já é limitada a poucos testes simultâneos).
          </p>
        </section>
      </div>
    </Dialog>
  );
}
