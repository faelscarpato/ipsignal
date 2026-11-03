"use client";

import {
  AlertOctagon,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  Clock3,
  CloudOff,
  FileWarning,
  FileX2,
  KeyRound,
  Loader2,
  RotateCcw,
  ShieldAlert,
  SignalMedium,
  TimerOff,
  WifiOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { isResultStale, STATUS_META } from "@/lib/iptv/status";
import type { TestResult, TestState } from "@/lib/iptv/types";

const ICONS: Record<TestState, LucideIcon> = {
  untested: CircleDashed,
  queued: Clock3,
  testing: Loader2,
  playing: CircleCheck,
  reachable_unconfirmed: SignalMedium,
  import_error: AlertOctagon,
  network_error: WifiOff,
  timeout: TimerOff,
  blocked_cors: ShieldAlert,
  auth_failed: KeyRound,
  manifest_invalid: FileWarning,
  codec_unsupported: FileX2,
  unavailable: CloudOff,
  undetermined: CircleHelp,
};

const TONES: Record<string, string> = {
  ok: "border-mint/35 bg-mint/10 text-mint",
  info: "border-cyanx/35 bg-cyanx/10 text-cyanx",
  warn: "border-amber/35 bg-amber/10 text-amber",
  danger: "border-rose/35 bg-rose/10 text-rose",
  muted: "border-line2 bg-panel2 text-fog2",
  accent: "border-cyanx/35 bg-cyanx/10 text-cyanx",
};

export function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 30_000) return "agora";
  if (diff < 3_600_000) return `há ${Math.max(1, Math.round(diff / 60_000))} min`;
  if (diff < 86_400_000) return `há ${Math.round(diff / 3_600_000)} h`;
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function StatusBadge({ state, size = "md" }: { state: TestState; size?: "sm" | "md" }) {
  const meta = STATUS_META[state];
  const Icon = ICONS[state];
  const spinning = state === "testing";
  return (
    <span
      title={`${meta.description} Próximo passo: ${meta.nextStep}`}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border font-medium ${
        TONES[meta.tone]
      } ${size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"}`}
    >
      <Icon
        size={size === "sm" ? 12 : 13}
        strokeWidth={2.2}
        className={spinning ? "animate-spin" : state === "queued" ? "eq-bar" : undefined}
        aria-hidden
      />
      <span className="truncate">{meta.label}</span>
    </span>
  );
}

export function StatusWithMeta({
  result,
  onRetest,
  disabled,
}: {
  result?: TestResult;
  onRetest?: () => void;
  disabled?: boolean;
}) {
  const state = result?.state ?? "untested";
  const meta = STATUS_META[state];
  const stale = Boolean(result && !["queued", "testing", "untested"].includes(state) && isResultStale(result.checkedAt));
  const nextStep = result?.nextStep ?? meta.nextStep;

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge state={state} size="sm" />
        {stale && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-amber/35 bg-amber/10 px-1.5 py-px text-[10px] font-medium text-amber"
            title="Resultado antigo: streams ao vivo mudam com o tempo. Revalide antes de considerar atual."
          >
            antigo · revalide
          </span>
        )}
      </div>
      {result && !["queued", "testing"].includes(state) && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-fog">
          <span title={new Date(result.checkedAt).toLocaleString("pt-BR")}>
            {formatWhen(result.checkedAt)} · {formatDuration(result.durationMs)}
          </span>
          {onRetest && (
            <button
              type="button"
              onClick={onRetest}
              disabled={disabled}
              className="inline-flex items-center gap-0.5 font-sans text-[10.5px] text-cyanx underline-offset-2 hover:underline disabled:opacity-40"
              title="Testar novamente este canal"
            >
              <RotateCcw size={10} aria-hidden /> revalidar
            </button>
          )}
        </div>
      )}
      {result && !["queued", "testing", "untested"].includes(state) && (
        <p
          className="line-clamp-2 text-[11px] leading-snug text-fog"
          title={`${result.detail} — ${nextStep}`}
        >
          {state === "playing" ? result.detail : `${result.detail} ${nextStep}`}
        </p>
      )}
    </div>
  );
}
