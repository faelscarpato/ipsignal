"use client";

import { useState } from "react";
import {
  Download,
  Ellipsis,
  Eraser,
  FolderInput,
  ListX,
  Play,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Redo2,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { RESULT_STATES, STATUS_META } from "@/lib/iptv/status";
import type { TestState } from "@/lib/iptv/types";
import type { RunState } from "./useStudio";

export interface Filters {
  q: string;
  group: string | null;
  statuses: ReadonlySet<TestState>;
}

export function StatsChips({
  counts,
  active,
  onToggle,
  onClear,
}: {
  counts: Map<string, number>;
  active: ReadonlySet<TestState>;
  onToggle: (s: TestState) => void;
  onClear: () => void;
}) {
  const order: TestState[] = ["untested", ...RESULT_STATES];
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrar por estado do teste">
      {order.map((s) => {
        const count = counts.get(s) ?? 0;
        if (count === 0 && !active.has(s)) return null;
        const meta = STATUS_META[s];
        const pressed = active.has(s);
        return (
          <button
            key={s}
            className="chip"
            aria-pressed={pressed}
            onClick={() => onToggle(s)}
            title={`${meta.description} (${meta.nextStep})`}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background:
                  meta.tone === "ok"
                    ? "#4de8b6"
                    : meta.tone === "info"
                      ? "#5cc8ff"
                      : meta.tone === "warn"
                        ? "#ffb454"
                        : meta.tone === "danger"
                          ? "#ff6b7a"
                          : meta.tone === "accent"
                            ? "#5cc8ff"
                            : "#4a5568",
              }}
              aria-hidden
            />
            {meta.label}
            <span className="font-mono text-[10px] opacity-80">{count}</span>
          </button>
        );
      })}
      {active.size > 0 && (
        <button className="chip !border-transparent text-fog" onClick={onClear}>
          <ListX size={12} /> limpar
        </button>
      )}
    </div>
  );
}

export function Toolbar({
  filters,
  onFilters,
  groups,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  run,
  onTestAll,
  onTestFailures,
  onRevalidateTested,
  failureCount,
  testedCount,
  staleCount,
  untestedCount,
  totalCount,
  canRefreshOrigin,
  refreshingOrigin,
  onRefreshOrigin,
  onDisableFailures,
  onAdd,
  onExport,
  onRestoreOriginal,
  onClearLocal,
}: {
  filters: Filters;
  onFilters: (f: Filters) => void;
  groups: { name: string; count: number }[];
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  run: RunState;
  onTestAll: () => void;
  onTestFailures: () => void;
  onRevalidateTested: () => void;
  failureCount: number;
  testedCount: number;
  staleCount: number;
  untestedCount: number;
  totalCount: number;
  canRefreshOrigin?: boolean;
  refreshingOrigin?: boolean;
  onRefreshOrigin?: () => void;
  onDisableFailures?: () => void;
  onAdd: () => void;
  onExport: () => void;
  onRestoreOriginal: () => void;
  onClearLocal: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  void untestedCount;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fog"
            aria-hidden
          />
          <input
            className="input !pl-9"
            placeholder="Buscar por nome, grupo ou URL…"
            value={filters.q}
            onChange={(e) => onFilters({ ...filters, q: e.target.value })}
            aria-label="Buscar canais"
          />
        </div>
        <select
          className="input !w-auto"
          value={filters.group ?? ""}
          onChange={(e) => onFilters({ ...filters, group: e.target.value || null })}
          aria-label="Filtrar por grupo"
        >
          <option value="">Todos os grupos ({totalCount})</option>
          {groups.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name} ({g.count})
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1.5">
          <button
            className="btn !px-2.5"
            onClick={onUndo}
            disabled={!canUndo || run.active}
            title="Desfazer"
            aria-label="Desfazer última edição"
          >
            <Undo2 size={15} />
          </button>
          <button
            className="btn !px-2.5"
            onClick={onRedo}
            disabled={!canRedo || run.active}
            title="Refazer"
            aria-label="Refazer edição"
          >
            <Redo2 size={15} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            className="btn btn-primary"
            onClick={onTestAll}
            disabled={run.active || totalCount === 0}
          >
            <Play size={14} /> Testar todos
          </button>
          <button
            className="btn"
            onClick={onTestFailures}
            disabled={run.active || failureCount === 0}
            title={`Repete o teste apenas dos ${failureCount} canal(is) que falharam`}
          >
            <RotateCcw size={14} /> Repetir falhas
          </button>
          {testedCount > 0 && (
            <button
              className="btn"
              onClick={onRevalidateTested}
              disabled={run.active}
              title={
                staleCount > 0
                  ? `Revalida ${staleCount} resultado(s) antigo(s) — streams ao vivo mudam com o tempo`
                  : `Testa novamente os ${testedCount} canal(is) já avaliados`
              }
            >
              <RefreshCw size={14} />
              {staleCount > 0 ? `Revalidar antigos (${staleCount})` : "Testar novamente"}
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            className="btn"
            onClick={onAdd}
            disabled={run.active}
            aria-label="Adicionar canal"
            title="Adicionar canal"
          >
            <Plus size={14} /> <span className="hidden md:inline">Canal</span>
          </button>
          <button
            className="btn"
            onClick={onExport}
            disabled={run.active}
            aria-label="Exportar playlist"
            title="Exportar playlist"
          >
            <Download size={14} /> <span className="hidden md:inline">Exportar</span>
          </button>
          <div className="relative">
            <button
              className="btn !px-2.5"
              onClick={() => setMoreOpen((v) => !v)}
              aria-label="Mais ações"
              aria-expanded={moreOpen}
            >
              <Ellipsis size={15} />
            </button>
            {moreOpen && (
              <div
                className="card absolute right-0 top-full z-30 mt-1.5 w-68 !rounded-xl p-1.5 shadow-2xl"
                role="menu"
              >
                {canRefreshOrigin && onRefreshOrigin && (
                  <button
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fog2 transition-colors hover:bg-panel3 hover:text-snow disabled:opacity-45"
                    disabled={refreshingOrigin || run.active}
                    onClick={() => {
                      setMoreOpen(false);
                      onRefreshOrigin();
                    }}
                  >
                    <RefreshCw size={14} className="text-mint" /> Atualizar playlist da URL
                  </button>
                )}
                {failureCount > 0 && onDisableFailures && (
                  <button
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fog2 transition-colors hover:bg-panel3 hover:text-snow"
                    onClick={() => {
                      setMoreOpen(false);
                      onDisableFailures();
                    }}
                  >
                    <PowerOff size={14} className="text-amber" /> Desativar {failureCount} canal(is) com falha
                  </button>
                )}
                <button
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fog2 transition-colors hover:bg-panel3 hover:text-snow"
                  onClick={() => {
                    setMoreOpen(false);
                    onRestoreOriginal();
                  }}
                >
                  <RotateCcw size={14} className="text-cyanx" /> Restaurar playlist original
                </button>
                <button
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-rose/90 transition-colors hover:bg-rose/10"
                  onClick={() => {
                    setMoreOpen(false);
                    onClearLocal();
                  }}
                >
                  <Eraser size={14} /> Apagar dados locais deste navegador
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SelectionBar({
  count,
  groups,
  onTest,
  onMove,
  onDisable,
  onEnable,
  onRemove,
  onClear,
}: {
  count: number;
  groups: { name: string; count: number }[];
  onTest: () => void;
  onMove: (group: string) => void;
  onDisable: () => void;
  onEnable: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [group, setGroup] = useState("");

  return (
    <div
      className="anim-rise flex flex-wrap items-center gap-2 rounded-xl border border-cyanx/30 bg-cyanx/5 px-3.5 py-2.5"
      role="region"
      aria-label="Ações da seleção"
    >
      <span className="font-mono text-xs text-cyanx">{count} selecionado(s)</span>
      <button className="btn !py-1.5 !text-xs" onClick={onTest}>
        <Play size={13} /> Testar
      </button>
      <button
        className="btn !py-1.5 !text-xs"
        onClick={() => setMoveOpen((v) => !v)}
        aria-expanded={moveOpen}
      >
        <FolderInput size={13} /> Mover p/ grupo
      </button>
      <button className="btn !py-1.5 !text-xs" onClick={onDisable}>
        <PowerOff size={13} /> Desativar
      </button>
      <button className="btn !py-1.5 !text-xs" onClick={onEnable}>
        <Power size={13} /> Reativar
      </button>
      <button className="btn btn-danger !py-1.5 !text-xs" onClick={onRemove}>
        <Trash2 size={13} /> Remover…
      </button>
      <button className="btn !border-transparent !py-1.5 !text-xs text-fog" onClick={onClear}>
        <X size={13} /> Limpar seleção
      </button>
      {moveOpen && (
        <form
          className="ml-auto flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onMove(group);
            setGroup("");
            setMoveOpen(false);
          }}
        >
          <input
            className="input !w-48 !py-1.5 !text-xs"
            placeholder="Grupo novo ou existente"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            list="move-groups"
            aria-label="Grupo de destino"
          />
          <datalist id="move-groups">
            {groups.map((g) => (
              <option key={g.name} value={g.name} />
            ))}
          </datalist>
          <button className="btn btn-primary !py-1.5 !text-xs" type="submit">
            Aplicar
          </button>
        </form>
      )}
    </div>
  );
}

export function RunProgress({ run, onCancel }: { run: RunState; onCancel: () => void }) {
  const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  return (
    <div
      className="anim-rise overflow-hidden rounded-xl border border-cyanx/30 bg-panel"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2.5 text-sm">
          <span className="flex items-end gap-[3px]" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="eq-bar block w-1 rounded-sm bg-cyanx"
                style={{ height: 14, animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </span>
          <span className="text-fog2">
            Testando canais via relay…{" "}
            <span className="font-mono text-cyanx">
              {run.done}/{run.total}
            </span>
          </span>
        </div>
        <button className="btn !py-1 !text-xs" onClick={onCancel}>
          <X size={13} /> Cancelar
        </button>
      </div>
      <div className="h-1 w-full bg-panel2">
        <div
          className="h-full bg-gradient-to-r from-cyanx to-mint transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
