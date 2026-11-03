"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, ShieldCheck, Square, TriangleAlert } from "lucide-react";
import { Dialog } from "./dialogs";
import { classifyHlsError, type HlsErrorInfo, type RelayErrorKind } from "@/lib/iptv/classify";
import { detectBrowserMediaCapabilities, inspectStreamFormat } from "@/lib/iptv/capabilities";
import { redactText } from "@/lib/iptv/redact";
import { STATUS_META } from "@/lib/iptv/status";
import type { Channel, TestResult, TestState } from "@/lib/iptv/types";
import { resolveChannelRelayUrl } from "@/lib/relay/client";

type PlayerStatus = "loading" | "ready" | "paused" | "stopped" | "error";

function isLocalFixtureUrl(rawUrl: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const u = new URL(rawUrl, window.location.origin);
    return (
      u.origin === window.location.origin &&
      (u.pathname.startsWith("/api/test-streams") || u.pathname.startsWith("/api/stream-relay"))
    );
  } catch {
    return false;
  }
}

/**
 * Player de exibição — utiliza o MESMO relay de mídia (/api/stream-relay)
 * e motor de reprodução (hls.js via MSE ou HLS/mídia nativa) do testador.
 * Permite interromper (encerrando conexões upstream) e retomar a transmissão.
 */
export function PlayerDialog({
  channel,
  onClose,
  onPlaybackResult,
}: {
  channel: Channel;
  onClose: () => void;
  onPlaybackResult?: (id: string, result: TestResult) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<{ destroy: () => void; stopLoad?: () => void; startLoad?: () => void } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [status, setStatus] = useState<PlayerStatus>("loading");
  const [errorState, setErrorState] = useState<TestState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sessionSeq, setSessionSeq] = useState(0);
  const viaRelay = !isLocalFixtureUrl(channel.url);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    try {
      hlsRef.current?.stopLoad?.();
      hlsRef.current?.destroy();
    } catch {
      /* noop */
    }
    hlsRef.current = null;
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        /* noop */
      }
    }
    setStatus("stopped");
  }, []);

  const resumeStream = useCallback(() => {
    const video = videoRef.current;
    if (status === "paused" && video && video.src) {
      video.play().then(() => setStatus("ready")).catch(() => undefined);
      return;
    }
    setErrorMsg(null);
    setErrorState(null);
    setStatus("loading");
    setSessionSeq((s) => s + 1);
  }, [status]);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (status === "stopped" || status === "error") {
      resumeStream();
      return;
    }
    if (video.paused) {
      video.play().then(() => setStatus("ready")).catch(() => undefined);
    } else {
      video.pause();
      setStatus("paused");
    }
  }, [status, resumeStream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let destroyed = false;
    const startedAt = Date.now();
    const ctl = new AbortController();
    abortRef.current = ctl;

    const format = inspectStreamFormat(channel.url);
    const capabilities = detectBrowserMediaCapabilities();
    const isFixture = isLocalFixtureUrl(channel.url);
    const useRelayNow = !isFixture;

    const reportSuccess = () => {
      if (destroyed) return;
      setStatus("ready");
      onPlaybackResult?.(channel.id, {
        state: "playing",
        detail: `Reprodução confirmada no player (${useRelayNow ? "via relay" : "fixture local"}).`,
        nextStep: STATUS_META.playing.nextStep,
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        viaRelay: useRelayNow,
      });
    };

    const reportFailure = (state: TestState, msg: string) => {
      if (destroyed) return;
      setStatus("error");
      setErrorState(state);
      setErrorMsg(msg);
      onPlaybackResult?.(channel.id, {
        state,
        detail: msg,
        nextStep: STATUS_META[state].nextStep,
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        viaRelay: useRelayNow,
      });
    };

    const attach = async () => {
      try {
        await Promise.resolve();
        if (destroyed) return;
        if (format.kind === "unsupported_container") {
          reportFailure(
            "codec_unsupported",
            format.reasonIfUnsupported ?? STATUS_META.codec_unsupported.description,
          );
          return;
        }
        setStatus("loading");
        setErrorMsg(null);
        setErrorState(null);

        const playbackUrl = useRelayNow
          ? await resolveChannelRelayUrl(channel.url, channel.directives, ctl.signal)
          : channel.url;

        if (destroyed || ctl.signal.aborted) return;

        if (format.kind === "hls") {
          const mod = await import("hls.js");
          const Hls = mod.default;
          if (Hls.isSupported() && capabilities.mseSupported) {
            const instance = new Hls({
              capLevelToPlayerSize: true,
              maxBufferLength: 15,
              maxMaxBufferLength: 30,
            });
            hlsRef.current = instance;
            instance.on(Hls.Events.MANIFEST_PARSED, () => {
              if (!destroyed) video.play().catch(() => undefined);
            });
            instance.on(Hls.Events.FRAG_BUFFERED, () => {
              if (!destroyed && video.buffered.length > 0) {
                reportSuccess();
              }
            });
            instance.on(Hls.Events.ERROR, (_e, data) => {
              if (!data.fatal || destroyed) return;
              const net = data.networkDetails as
                | { getResponseHeader?: (n: string) => string | null; responseText?: string }
                | undefined;
              const relayKind = (net?.getResponseHeader?.("x-relay-error-kind") ?? null) as RelayErrorKind | null;
              let customMsg: string | null = null;
              const rawText =
                typeof data.response?.text === "string"
                  ? data.response.text
                  : typeof net?.responseText === "string"
                    ? net.responseText
                    : null;
              if (rawText && rawText.trim().startsWith("{")) {
                try {
                  const parsed = JSON.parse(rawText) as { message?: string };
                  if (parsed.message) customMsg = redactText(parsed.message);
                } catch {
                  /* ignore */
                }
              }
              const info: HlsErrorInfo = {
                type: String(data.type),
                details: String(data.details),
                responseCode: typeof data.response?.code === "number" ? data.response.code : 0,
                fatal: true,
                relayErrorKind: relayKind,
                viaRelay: useRelayNow,
              };
              const st = classifyHlsError(info);
              reportFailure(st, customMsg ?? STATUS_META[st].description);
            });
            instance.loadSource(playbackUrl);
            instance.attachMedia(video);
            return;
          }
        }

        // HLS nativo (Safari) ou arquivo direto (MP4/WebM/Áudio) via relay
        video.src = playbackUrl;
        video.load();
        video.play().catch(() => undefined);
      } catch {
        if (!destroyed) {
          reportFailure("undetermined", "Falha ao inicializar o player para este canal.");
        }
      }
    };

    const onReady = () => {
      if (!destroyed && (video.readyState >= 2 || video.buffered.length > 0)) {
        reportSuccess();
      }
    };
    const onPause = () => {
      if (!destroyed && status === "ready") {
        setStatus("paused");
      }
    };
    const onPlay = () => {
      if (!destroyed) {
        setStatus("ready");
      }
    };
    const onError = () => {
      if (!destroyed) {
        reportFailure(
          "unavailable",
          "O player não conseguiu carregar ou decodificar esta transmissão.",
        );
      }
    };

    video.addEventListener("loadeddata", onReady);
    video.addEventListener("playing", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("error", onError);
    void attach();

    return () => {
      destroyed = true;
      ctl.abort();
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("playing", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("error", onError);
      try {
        hlsRef.current?.stopLoad?.();
        hlsRef.current?.destroy();
      } catch {
        /* noop */
      }
      hlsRef.current = null;
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, channel.url, sessionSeq]);

  return (
    <Dialog title={channel.name} icon={<Play size={15} className="text-mint" />} onClose={onClose} wide>
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-line bg-black">
        <video
          ref={videoRef}
          controls
          playsInline
          muted
          className="h-full w-full"
          data-testid="player-video"
        />
        {status === "loading" && (
          <div className="absolute inset-0 grid place-items-center bg-black/60">
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-end gap-1" aria-hidden>
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className="eq-bar block w-1.5 rounded-sm bg-mint"
                    style={{ height: 26, animationDelay: `${i * 0.12}s` }}
                  />
                ))}
              </div>
              <span className="text-xs text-fog2">Conectando via relay e carregando buffer…</span>
            </div>
          </div>
        )}
        {status === "stopped" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 text-center">
            <Square size={22} className="text-fog" />
            <p className="text-sm font-medium text-snow">Transmissão interrompida</p>
            <p className="max-w-sm text-xs text-fog">
              A conexão com a origem foi encerrada. Clique em Retomar para reconectar ao stream.
            </p>
            <button className="btn btn-primary !text-xs" onClick={resumeStream}>
              <Play size={13} /> Retomar transmissão
            </button>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-black/80 p-6 text-center">
            <TriangleAlert size={22} className="text-amber" />
            {errorState && (
              <span className="rounded-full border border-amber/35 bg-amber/10 px-2.5 py-0.5 text-xs font-medium text-amber">
                {STATUS_META[errorState].label}
              </span>
            )}
            <p className="max-w-md text-sm text-fog2">{errorMsg}</p>
            {errorState && (
              <p className="max-w-md text-xs text-fog">{STATUS_META[errorState].nextStep}</p>
            )}
            <button className="btn mt-1 !text-xs" onClick={resumeStream}>
              <RotateCcw size={13} /> Tentar novamente
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {status !== "stopped" ? (
            <>
              <button
                type="button"
                className="btn !py-1.5 !text-xs"
                onClick={togglePlayPause}
                aria-label={status === "paused" ? "Retomar reprodução" : "Pausar reprodução"}
              >
                {status === "paused" ? <Play size={13} /> : <Pause size={13} />}
                {status === "paused" ? "Retomar" : "Pausar"}
              </button>
              <button
                type="button"
                className="btn !py-1.5 !text-xs"
                onClick={stopStream}
                aria-label="Interromper transmissão"
              >
                <Square size={13} /> Interromper
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary !py-1.5 !text-xs"
              onClick={resumeStream}
              aria-label="Retomar transmissão"
            >
              <Play size={13} /> Retomar
            </button>
          )}
          <button
            type="button"
            className="btn !py-1.5 !text-xs"
            onClick={resumeStream}
            aria-label="Recarregar transmissão"
          >
            <RotateCcw size={13} /> Recarregar
          </button>
        </div>

        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-fog">
          <ShieldCheck size={13} className="text-mint" aria-hidden />
          {viaRelay ? "Relay de mídia ativo (sem bloqueio CORS)" : "Fixture local (mesma origem)"}
        </span>
      </div>
    </Dialog>
  );
}
