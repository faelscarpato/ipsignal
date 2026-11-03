/**
 * Detecção de capacidades de mídia do navegador (Media Source Extensions,
 * HLS nativo e codecs suportados) e análise de formatos de stream.
 *
 * Arquitetura de remux/transcodificação:
 * - Segmentos MPEG-TS (.ts) dentro de transmissões HLS (.m3u8) são remuxados
 *   em tempo real no navegador para fMP4 via hls.js + Media Source Extensions (MSE),
 *   sem necessidade de transcodificação pesada no servidor.
 * - Contêineres legados (ex.: .avi, .wmv, .mkv com áudio AC-3/DTS) ou codecs sem
 *   decodificador no navegador/SO (ex.: HEVC/H.265 ou Dolby AC-3 em navegadores sem
 *   licença de hardware) e protocolos não-HTTP (rtmp://, rtsp://, udp://) não podem
 *   ser transcodificados sem um binário externo de mídia (como FFmpeg dedicado com CPU/GPU).
 */

export interface BrowserMediaCapabilities {
  mseSupported: boolean;
  nativeHlsSupported: boolean;
  hlsSupported: boolean;
  codecs: {
    h264: boolean;
    hevc: boolean;
    vp9: boolean;
    av1: boolean;
    aac: boolean;
    mp3: boolean;
    opus: boolean;
    ac3: boolean;
  };
}

export type StreamMediaKind = "hls" | "video" | "audio" | "unsupported_container";

export interface StreamFormatInspection {
  kind: StreamMediaKind;
  extension: string | null;
  reasonIfUnsupported?: string;
}

function checkType(video: HTMLVideoElement | null, mime: string): boolean {
  if (typeof window !== "undefined") {
    const ms =
      (window as unknown as { MediaSource?: typeof MediaSource; ManagedMediaSource?: typeof MediaSource })
        .MediaSource ??
      (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
    if (ms && typeof ms.isTypeSupported === "function") {
      try {
        if (ms.isTypeSupported(mime)) return true;
      } catch {
        /* fallback */
      }
    }
  }
  if (video && typeof video.canPlayType === "function") {
    try {
      const res = video.canPlayType(mime);
      return res === "probably" || res === "maybe";
    } catch {
      return false;
    }
  }
  return false;
}

export function detectBrowserMediaCapabilities(): BrowserMediaCapabilities {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {
      mseSupported: false,
      nativeHlsSupported: false,
      hlsSupported: false,
      codecs: {
        h264: false,
        hevc: false,
        vp9: false,
        av1: false,
        aac: false,
        mp3: false,
        opus: false,
        ac3: false,
      },
    };
  }

  const video = document.createElement("video");
  const ms =
    (window as unknown as { MediaSource?: typeof MediaSource; ManagedMediaSource?: typeof MediaSource })
      .MediaSource ??
    (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;

  const mseSupported = Boolean(ms && typeof ms.isTypeSupported === "function");
  const nativeHlsSupported =
    typeof video.canPlayType === "function" &&
    (video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
      video.canPlayType("audio/mpegurl") !== "" ||
      video.canPlayType("application/x-mpegURL") !== "");

  const h264 = checkType(video, 'video/mp4; codecs="avc1.42E01E"');
  const hevc =
    checkType(video, 'video/mp4; codecs="hvc1.1.6.L93.B0"') ||
    checkType(video, 'video/mp4; codecs="hev1.1.6.L93.B0"');
  const vp9 = checkType(video, 'video/webm; codecs="vp9"');
  const av1 = checkType(video, 'video/mp4; codecs="av01.0.05M.08"');
  const aac = checkType(video, 'audio/mp4; codecs="mp4a.40.2"');
  const mp3 = checkType(video, "audio/mpeg");
  const opus = checkType(video, 'audio/webm; codecs="opus"');
  const ac3 =
    checkType(video, 'audio/mp4; codecs="ac-3"') ||
    checkType(video, 'audio/mp4; codecs="ec-3"');

  return {
    mseSupported,
    nativeHlsSupported,
    hlsSupported: mseSupported || nativeHlsSupported,
    codecs: { h264, hevc, vp9, av1, aac, mp3, opus, ac3 },
  };
}

export function inspectStreamFormat(rawUrl: string): StreamFormatInspection {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.toLowerCase();
    const extMatch = /\.([a-z0-9]{2,5})$/i.exec(path);
    const ext = extMatch ? extMatch[1].toLowerCase() : null;

    if (ext && ["avi", "wmv", "divx", "vob", "iso"].includes(ext)) {
      return {
        kind: "unsupported_container",
        extension: ext,
        reasonIfUnsupported: `Contêiner .${ext} não possui demuxer nativo nos navegadores web e exigiria transcodificação externa (FFmpeg) no servidor.`,
      };
    }

    if (ext && ["mp4", "m4v", "webm", "mov", "ogv"].includes(ext)) {
      return { kind: "video", extension: ext };
    }

    if (ext && ["mp3", "aac", "ogg", "oga", "opus", "flac", "wav", "m4a"].includes(ext)) {
      return { kind: "audio", extension: ext };
    }

    return { kind: "hls", extension: ext };
  } catch {
    return { kind: "hls", extension: null };
  }
}
