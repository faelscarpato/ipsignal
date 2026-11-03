"use client";

import { useMemo, useState } from "react";
import {
  Ban,
  ChevronDown,
  FlaskConical,
  Inbox,
  Pencil,
  Play,
  Power,
  PowerOff,
  ScanSearch,
  Trash2,
  Undo2,
} from "lucide-react";
import type { Channel, ResultsMap } from "@/lib/iptv/types";
import { displayHost } from "@/lib/iptv/redact";
import { StatusWithMeta } from "./StatusBadge";

const PAGE = 240;

export function ChannelTable({
  channels,
  results,
  selection,
  onToggleSelect,
  onSelectAllShown,
  onClearSelection,
  onTest,
  onWatch,
  onEdit,
  onToggleDisable,
  onRemove,
  truncatedInfo,
  hasFilters,
  onClearFilters,
  deletedChannels,
  onRestoreDeleted,
  runActive,
}: {
  channels: Channel[];
  results: ResultsMap;
  selection: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onSelectAllShown: (ids: string[]) => void;
  onClearSelection: () => void;
  onTest: (id: string) => void;
  onWatch: (c: Channel) => void;
  onEdit: (c: Channel) => void;
  onToggleDisable: (c: Channel) => void;
  onRemove: (c: Channel) => void;
  truncatedInfo: string | null;
  hasFilters: boolean;
  onClearFilters: () => void;
  deletedChannels: Channel[];
  onRestoreDeleted: () => void;
  runActive: boolean;
}) {
  const [shown, setShown] = useState(PAGE);
  const [failedLogos, setFailedLogos] = useState<ReadonlySet<string>>(new Set());
  const [trashOpen, setTrashOpen] = useState(false);

  const slice = useMemo(() => channels.slice(0, shown), [channels, shown]);
  const allShownSelected = slice.length > 0 && slice.every((c) => selection.has(c.id));

  if (channels.length === 0) {
    return (
      <div className="card grid place-items-center px-6 py-16 text-center">
        <Inbox size={28} className="mb-3 text-fog" aria-hidden />
        <p className="text-sm font-medium text-fog2">
          {hasFilters ? "Nenhum canal corresponde aos filtros atuais." : "Nenhum canal nesta playlist."}
        </p>
        {hasFilters && (
          <button className="btn mt-4 !text-xs" onClick={onClearFilters}>
            <ScanSearch size={13} /> Limpar filtros
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      {/* cabeçalho (desktop) */}
      <div className="hidden items-center gap-3 border-b border-line bg-panel2/60 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fog md:flex">
        <label className="flex items-center" title="Selecionar todos os exibidos">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[#4de8b6]"
            checked={allShownSelected}
            onChange={() => (allShownSelected ? onClearSelection() : onSelectAllShown(slice.map((c) => c.id)))}
            aria-label="Selecionar todos os canais exibidos"
          />
        </label>
        <span className="w-10" />
        <span className="min-w-0 flex-1">Canal</span>
        <span className="w-64">Estado · Último teste (horário · duração)</span>
        <span className="w-40">Origem</span>
        <span className="w-40 text-right">Ações</span>
      </div>

      <ul className="divide-y divide-line" role="list">
        {slice.map((c) => {
          const result = results[c.id];
          const selected = selection.has(c.id);
          const logoOk = c.tvgLogo && !failedLogos.has(c.id) && /^https?:\/\//i.test(c.tvgLogo);
          return (
            <li
              key={c.id}
              className={`group flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors md:flex-nowrap ${
                selected ? "bg-cyanx/[0.06]" : "hover:bg-panel2/50"
              } ${c.disabled ? "opacity-55" : ""}`}
            >
              <label className="order-1 flex items-center self-start md:self-center">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#4de8b6]"
                  checked={selected}
                  onChange={() => onToggleSelect(c.id)}
                  aria-label={`Selecionar ${c.name}`}
                />
              </label>

              <span className="order-2 grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-panel2">
                {logoOk ? (
                  // eslint-disable-next-line @next/next/no-img-element -- URLs de logo são externas e arbitrárias
                  <img
                    src={c.tvgLogo ?? ""}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-contain"
                    onError={() => setFailedLogos((prev) => new Set(prev).add(c.id))}
                  />
                ) : (
                  <span className="font-mono text-xs font-semibold text-fog" aria-hidden>
                    {initials(c.name)}
                  </span>
                )}
              </span>

              <div className="order-3 min-w-0 flex-1 basis-40">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-snow" title={c.name}>
                    {c.name}
                  </span>
                  {c.manual && (
                    <span className="shrink-0 rounded-full border border-violet/35 bg-violet/10 px-1.5 py-px text-[10px] font-medium text-violet">
                      manual
                    </span>
                  )}
                  {c.disabled && (
                    <span className="shrink-0 rounded-full border border-line2 bg-panel2 px-1.5 py-px text-[10px] font-medium text-fog">
                      desativado
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-fog">
                  <span className="truncate rounded border border-line bg-panel2 px-1.5 py-px">{c.group ?? "Sem grupo"}</span>
                  <span className="hidden truncate font-mono sm:inline" title="URL exibida sem credenciais">
                    {displayHost(c.url)}
                  </span>
                </div>
              </div>

              <div className="order-4 w-full pl-13 md:order-5 md:w-64 md:pl-0">
                <StatusWithMeta
                  result={result}
                  onRetest={() => onTest(c.id)}
                  disabled={runActive}
                />
              </div>

              <div className="order-5 hidden w-40 truncate font-mono text-[11px] text-fog md:order-4 md:block" title={displayHost(c.url)}>
                {displayHost(c.url)}
              </div>

              <div className="ml-auto flex items-center gap-1 md:order-6 md:w-40 md:justify-end">
                <RowAction label={`Assistir ${c.name}`} onClick={() => onWatch(c)}>
                  <Play size={14} />
                </RowAction>
                <RowAction
                  label={result ? `Testar novamente ${c.name}` : `Testar ${c.name}`}
                  onClick={() => onTest(c.id)}
                  disabled={runActive}
                >
                  <FlaskConical size={14} />
                </RowAction>
                <RowAction label={`Editar ${c.name}`} onClick={() => onEdit(c)} disabled={runActive}>
                  <Pencil size={14} />
                </RowAction>
                <RowAction
                  label={c.disabled ? `Reativar ${c.name}` : `Desativar ${c.name}`}
                  onClick={() => onToggleDisable(c)}
                  disabled={runActive}
                >
                  {c.disabled ? <Power size={14} className="text-mint" /> : <PowerOff size={14} />}
                </RowAction>
                <RowAction label={`Remover ${c.name}`} onClick={() => onRemove(c)} danger disabled={runActive}>
                  <Trash2 size={14} />
                </RowAction>
              </div>
            </li>
          );
        })}
      </ul>

      {channels.length > shown && (
        <div className="border-t border-line p-3 text-center">
          <button className="btn !text-xs" onClick={() => setShown((s) => s + PAGE)}>
            <ChevronDown size={13} /> Mostrar mais {Math.min(PAGE, channels.length - shown)} de {channels.length - shown} restantes
          </button>
        </div>
      )}

      {(truncatedInfo || deletedChannels.length > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-panel2/40 px-4 py-2.5 text-[11px] text-fog">
          <span>
            {truncatedInfo}
            {deletedChannels.length > 0 && (
              <>
                {" "}
                <Ban size={11} className="inline text-rose/70" aria-hidden /> {deletedChannels.length} na lixeira
              </>
            )}
          </span>
          {deletedChannels.length > 0 && (
            <span className="flex items-center gap-2">
              <button className="underline-offset-2 hover:underline" onClick={() => setTrashOpen((v) => !v)}>
                {trashOpen ? "Ocultar lixeira" : "Ver lixeira"}
              </button>
              <button className="btn !py-1 !text-[11px]" onClick={onRestoreDeleted}>
                <Undo2 size={12} /> Restaurar todos
              </button>
            </span>
          )}
        </div>
      )}
      {trashOpen && deletedChannels.length > 0 && (
        <ul className="divide-y divide-line border-t border-line bg-panel2/20 text-xs text-fog2">
          {deletedChannels.slice(0, 30).map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-4 py-2">
              <Trash2 size={12} className="text-rose/70" aria-hidden />
              <span className="truncate">{c.name}</span>
              <span className="font-mono text-[10px] text-fog">{c.group ?? "Sem grupo"}</span>
            </li>
          ))}
          {deletedChannels.length > 30 && <li className="px-4 py-2 text-fog">… e mais {deletedChannels.length - 30}.</li>}
        </ul>
      )}
    </div>
  );
}

function RowAction({
  label,
  onClick,
  children,
  danger,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`rounded-lg border border-transparent p-1.5 text-fog transition-colors hover:border-line2 hover:bg-panel3 hover:text-snow disabled:opacity-40 ${
        danger ? "hover:!text-rose" : ""
      }`}
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "TV";
}
