/**
 * Teste REAL de reprodução no navegador do usuário, usando o relay de mídia
 * integrado (/api/stream-relay) e o mesmo motor do player de exibição
 * (hls.js via Media Source Extensions ou HLS/mídia nativa).
 *
 * Regras fundamentais:
 * - "playing" exige evidência real de mídia decodificada/bufferizada no player
 *   (FRAG_BUFFERED com bytes em video.buffered ou loadeddata/playing com readyState >= 2).
 * - Manifesto OK ou HTTP 200, sozinhos, classificam no máximo como "reachable_unconfirmed".
 * - Assim que a evidência aparece (ou na falha/cancelamento), o player e as conexões
 *   são imediatamente destruídos para não baixar o stream inteiro.
 */

import {
  classifyHlsError,
  classifyRelayErrorKind,
  decideOutcome,
  type HlsErrorInfo,
  type RelayErrorKind,
  type StreamEvidence,
} from "./classify";
import { detectBrowserMediaCapabilities, inspectStreamFormat } from "./capabilities";
import { redactText } from "./redact";
import { STATUS_META } from "./status";
import type { TestResult, TestState } from "./types";
import { validateHttpUrl } from "./validate";
import { resolveChannelRelayUrl } from "@/lib/relay/client";

export const TEST_TIMEOUT_MS = 12000;

export interface TestChannelOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Diretivas #EXTVLCOPT/#KODIPROP do canal (para repassar User-Agent/Referer seguros). */
  directives?: readonly string[];
  /** Usa o relay de mídia integrado (padrão: true). */
  useRelay?: boolean;
}

interface Finish {
  state: TestState;
  detail: string;
  nextStep?: string;
}

function classifyMediaElementError(code: number | undefined): Finish {
  switch (code) {
    case 1:
      return {
        state: "undetermined",
        detail: "Carregamento interrompido pelo navegador.",
        nextStep: STATUS_META.undetermined.nextStep,
      };
    case 2:
      return {
        state: "network_error",
        detail: "Falha de rede ao carregar a mídia (conexão interrompida ou origem inacessível).",
        nextStep: STATUS_META.network_error.nextStep,
      };
    case 3:
      return {
        state: "codec_unsupported",
        detail: "O navegador baixou dados da mídia, mas a decodificação falhou (codec incompatível ou fluxo corrompido).",
        nextStep: STATUS_META.codec_unsupported.nextStep,
      };
    case 4:
      return {
        state: "codec_unsupported",
        detail: "Formato, contêiner ou codec não suportado por este navegador.",
        nextStep: STATUS_META.codec_unsupported.nextStep,
      };
    default:
      return {
        state: "undetermined",
        detail: "Erro de mídia não identificado pelo elemento de vídeo.",
        nextStep: STATUS_META.undetermined.nextStep,
      };
  }
}

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

function extractRelayErrorFromHlsData(data: {
  response?: { code?: number; text?: string };
  networkDetails?: unknown;
}): { kind: RelayErrorKind | null; message: string | null } {
  let kind: RelayErrorKind | null = null;
  let message: string | null = null;

  const net = data.networkDetails as
    | { getResponseHeader?: (name: string) => string | null; responseText?: string }
    | undefined;

  if (net && typeof net.getResponseHeader === "function") {
    const hdr = net.getResponseHeader("x-relay-error-kind");
    if (hdr) kind = hdr as RelayErrorKind;
  }

  const rawText =
    typeof data.response?.text === "string"
      ? data.response.text
      : typeof net?.responseText === "string"
        ? net.responseText
        : null;

  if (rawText && rawText.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawText) as { kind?: RelayErrorKind; message?: string };
      if (!kind && parsed.kind) kind = parsed.kind;
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      /* ignore JSON parse error */
    }
  }

  return { kind, message };
}

async function probeRelayDiagnostic(
  relayUrl: string,
  signal?: AbortSignal,
): Promise<{ state: TestState; detail: string } | null> {
  try {
    const sep = relayUrl.includes("?") ? "&" : "?";
    const res = await fetch(`${relayUrl}${sep}probe=1`, {
      method: "GET",
      signal,
    });
    const relayKind = res.headers.get("x-relay-error-kind");
    let bodyMsg: string | null = null;
    let bodyKind: string | null = null;
    try {
      const json = (await res.json()) as { kind?: string; message?: string };
      bodyKind = json.kind ?? null;
      bodyMsg = json.message ?? null;
    } catch {
      /* ignore */
    }
    const mapped = classifyRelayErrorKind(relayKind ?? bodyKind);
    if (mapped) {
      return {
        state: mapped,
        detail: bodyMsg ? redactText(bodyMsg) : STATUS_META[mapped].description,
      };
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403 || res.status === 422) {
        return { state: "auth_failed", detail: bodyMsg ?? `Acesso negado (HTTP ${res.status}).` };
      }
      if (res.status === 408 || res.status === 504) {
        return { state: "timeout", detail: bodyMsg ?? "Tempo limite esgotado na origem." };
      }
      if (res.status === 502) {
        return { state: "network_error", detail: bodyMsg ?? "Falha de rede ao contatar a origem." };
      }
      return { state: "unavailable", detail: bodyMsg ?? `Origem indisponível (HTTP ${res.status}).` };
    }
    return null;
  } catch {
    return null;
  }
}

export async function testChannelPlayback(
  url: string,
  opts: TestChannelOptions = {},
): Promise<TestResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? TEST_TIMEOUT_MS;
  const useRelay = opts.useRelay ?? true;

  const urlCheck = validateHttpUrl(url);
  if (!urlCheck.ok) {
    return {
      state: "import_error",
      detail: `URL inválida no canal: ${urlCheck.reason}.`,
      nextStep: STATUS_META.import_error.nextStep,
      checkedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      viaRelay: false,
    };
  }

  if (typeof window === "undefined" || typeof document === "undefined") {
    return {
      state: "undetermined",
      detail: "Testes de reprodução exigem um ambiente de navegador com elemento de vídeo.",
      nextStep: STATUS_META.undetermined.nextStep,
      checkedAt: Date.now(),
      durationMs: 0,
      viaRelay: false,
    };
  }

  const format = inspectStreamFormat(url);
  if (format.kind === "unsupported_container") {
    return {
      state: "codec_unsupported",
      detail: format.reasonIfUnsupported ?? STATUS_META.codec_unsupported.description,
      nextStep: STATUS_META.codec_unsupported.nextStep,
      checkedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      viaRelay: false,
    };
  }

  const capabilities = detectBrowserMediaCapabilities();
  const isFixture = isLocalFixtureUrl(url);
  const viaRelay = useRelay && !isFixture;

  let playbackUrl = url;
  if (viaRelay) {
    playbackUrl = await resolveChannelRelayUrl(url, opts.directives, opts.signal);
  }

  const evidence: StreamEvidence = {
    manifestParsed: false,
    levelLoaded: false,
    fragLoaded: false,
    playbackEvidence: false,
    timedOut: false,
  };
  let classified: TestState | null = null;
  let detailExtra = "";

  const finish = (f: Finish): TestResult => ({
    state: f.state,
    detail: f.detail,
    nextStep: f.nextStep ?? STATUS_META[f.state].nextStep,
    checkedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    viaRelay,
  });

  return new Promise<TestResult>((resolve) => {
    let settled = false;
    const internalAbort = new AbortController();
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.width = 320;
    video.height = 180;

    let hls: { destroy: () => void; stopLoad?: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      internalAbort.abort();
      opts.signal?.removeEventListener("abort", onAbort);
      video.onloadeddata = null;
      video.onplaying = null;
      video.onerror = null;
      try {
        hls?.stopLoad?.();
        hls?.destroy();
      } catch {
        /* noop */
      }
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        /* noop */
      }
    };

    const done = (f: Finish) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(finish(f));
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(
        finish({
          state: "undetermined",
          detail: "Teste cancelado pelo usuário antes da conclusão.",
        }),
      );
    };

    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const mediaEvidence = () => {
      if (video.readyState < 2 && video.buffered.length === 0) return;
      evidence.playbackEvidence = true;
      done({
        state: "playing",
        detail: `Reprodução confirmada (${viaRelay ? "via relay" : "direto"}): mídia decodificada no buffer em ${(
          (Date.now() - startedAt) /
          1000
        ).toFixed(1)} s.`,
        nextStep: STATUS_META.playing.nextStep,
      });
    };

    video.onloadeddata = mediaEvidence;
    video.onplaying = mediaEvidence;

    const finalizeByEvidence = (fromTimeout: boolean) => {
      if (fromTimeout) evidence.timedOut = true;
      const state = decideOutcome(evidence, classified);
      const meta = STATUS_META[state];
      let detail = meta.description;
      if (state === "reachable_unconfirmed") {
        detail = evidence.fragLoaded
          ? "Endpoint respondeu, manifesto OK e segmentos baixados, mas nenhum quadro/áudio entrou no buffer a tempo. Reprodução NÃO confirmada."
          : "Endpoint respondeu e o manifesto HLS é válido, mas nenhum segmento de mídia foi carregado a tempo. Reprodução NÃO confirmada.";
      } else if (detailExtra) {
        detail = detailExtra.length > 24 ? detailExtra : `${detail} (${detailExtra})`;
      }
      done({ state, detail, nextStep: meta.nextStep });
    };

    timer = setTimeout(() => finalizeByEvidence(true), timeoutMs);

    const run = async () => {
      if (format.kind === "hls") {
        const mod = await import("hls.js");
        const Hls = mod.default;
        if (Hls.isSupported() && capabilities.mseSupported) {
          const instance = new Hls({
            maxBufferLength: 6,
            maxMaxBufferLength: 8,
            capLevelToPlayerSize: true,
            manifestLoadingTimeOut: Math.max(4000, timeoutMs - 2000),
            levelLoadingTimeOut: Math.max(4000, timeoutMs - 2000),
            fragLoadingTimeOut: Math.max(4000, timeoutMs - 2000),
            fragLoadingMaxRetry: 0,
            manifestLoadingMaxRetry: 0,
            levelLoadingMaxRetry: 0,
          });
          hls = instance;
          instance.on(Hls.Events.MANIFEST_PARSED, () => {
            evidence.manifestParsed = true;
            video.play().catch(() => undefined);
          });
          instance.on(Hls.Events.LEVEL_LOADED, () => {
            evidence.levelLoaded = true;
          });
          instance.on(Hls.Events.FRAG_LOADED, () => {
            evidence.fragLoaded = true;
          });
          instance.on(Hls.Events.FRAG_BUFFERED, () => {
            if (video.buffered.length > 0) {
              evidence.playbackEvidence = true;
              done({
                state: "playing",
                detail: `Reprodução confirmada (${viaRelay ? "via relay" : "direto"}): segmento anexado ao buffer MSE em ${(
                  (Date.now() - startedAt) /
                  1000
                ).toFixed(1)} s.`,
                nextStep: STATUS_META.playing.nextStep,
              });
            }
          });
          instance.on(Hls.Events.ERROR, (_evt, data) => {
            const isFetchTypeError = data.error instanceof TypeError;
            const relayErr = extractRelayErrorFromHlsData(data);
            const info: HlsErrorInfo = {
              type: String(data.type),
              details: String(data.details),
              responseCode:
                typeof data.response?.code === "number"
                  ? data.response.code
                  : isFetchTypeError || String(data.type) === "networkError"
                    ? 0
                    : null,
              fatal: Boolean(data.fatal),
              isFetchTypeError,
              relayErrorKind: relayErr.kind,
              viaRelay,
            };
            const state = classifyHlsError(info);
            if (state !== "undetermined") {
              classified = state;
              if (relayErr.message) {
                detailExtra = redactText(relayErr.message);
              } else if (typeof info.responseCode === "number" && info.responseCode > 0) {
                detailExtra = `HTTP ${info.responseCode}`;
              }
            }
            if (data.fatal) {
              finalizeByEvidence(false);
            }
          });
          instance.loadSource(playbackUrl);
          instance.attachMedia(video);
          return;
        }

        if (capabilities.nativeHlsSupported) {
          video.onerror = async () => {
            if (viaRelay) {
              const diag = await probeRelayDiagnostic(playbackUrl, internalAbort.signal);
              if (diag) {
                done({ state: diag.state, detail: diag.detail, nextStep: STATUS_META[diag.state].nextStep });
                return;
              }
            }
            done(classifyMediaElementError(video.error?.code));
          };
          video.src = playbackUrl;
          video.load();
          video.play().catch(() => undefined);
          return;
        }

        done({
          state: "codec_unsupported",
          detail:
            "Este navegador não suporta HLS: faltam Media Source Extensions (MSE) e suporte HLS nativo.",
          nextStep: STATUS_META.codec_unsupported.nextStep,
        });
        return;
      }

      // Mídia direta (MP4, WebM, áudio) passando pelo relay
      video.onerror = async () => {
        if (viaRelay) {
          const diag = await probeRelayDiagnostic(playbackUrl, internalAbort.signal);
          if (diag) {
            done({ state: diag.state, detail: diag.detail, nextStep: STATUS_META[diag.state].nextStep });
            return;
          }
        }
        done(classifyMediaElementError(video.error?.code));
      };
      video.src = playbackUrl;
      video.load();
      video.play().catch(() => undefined);
    };

    run().catch(() => {
      done({
        state: "undetermined",
        detail: "Falha inesperada ao inicializar o player de teste.",
        nextStep: STATUS_META.undetermined.nextStep,
      });
    });
  });
}
