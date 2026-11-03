/**
 * Classificação PURA de erros/evidências em estados de teste.
 * Separada do hls.js para ser 100% testável em Node (sem navegador).
 *
 * Regra de ouro: o estado "playing" exige evidência real de mídia
 * (fragmento anexado ao buffer do player ou evento 'playing'/'loadeddata'
 * do elemento de vídeo). Manifesto baixado ou HTTP 200, sozinhos, nunca bastam.
 */

import type { TestState } from "./types";

export type RelayErrorKind =
  | "import_error"
  | "network_error"
  | "timeout"
  | "auth_failed"
  | "blocked_private"
  | "manifest_invalid"
  | "codec_unsupported"
  | "unavailable"
  | "unknown_error";

export interface HlsErrorInfo {
  /** ErrorTypes do hls.js: "networkError" | "mediaError" | "otherError". */
  type: string;
  /** ErrorDetails do hls.js (ex.: "manifestLoadError", "fragLoadTimeOut"). */
  details: string;
  /** Código HTTP quando a resposta chegou; 0 quando a rede falhou antes (CORS/DNS). */
  responseCode: number | null;
  fatal: boolean;
  /** true quando o erro é um TypeError de fetch (indício de bloqueio CORS direto). */
  isFetchTypeError?: boolean;
  /** Causa específica reportada pelo relay de mídia (header X-Relay-Error-Kind). */
  relayErrorKind?: RelayErrorKind | string | null;
  /** true quando a requisição passou pelo relay integrado da aplicação. */
  viaRelay?: boolean;
}

export function classifyRelayErrorKind(kind: string | null | undefined): TestState | null {
  switch (kind) {
    case "import_error":
      return "import_error";
    case "network_error":
      return "network_error";
    case "timeout":
      return "timeout";
    case "auth_failed":
    case "blocked_private":
      return "auth_failed";
    case "manifest_invalid":
      return "manifest_invalid";
    case "codec_unsupported":
      return "codec_unsupported";
    case "unavailable":
      return "unavailable";
    case "unknown_error":
      return "undetermined";
    default:
      return null;
  }
}

export function classifyHttpCode(code: number, relayErrorKind?: string | null): TestState {
  const fromRelay = classifyRelayErrorKind(relayErrorKind);
  if (fromRelay) return fromRelay;
  if (code === 401 || code === 403 || code === 422) return "auth_failed";
  if (code === 408 || code === 504) return "timeout";
  if (code === 502) return "network_error";
  if (code >= 400) return "unavailable";
  return "undetermined";
}

export function classifyHlsError(info: HlsErrorInfo): TestState {
  const { type, details, responseCode, relayErrorKind, viaRelay } = info;
  const d = details.toLowerCase();

  // 0) Se o relay informou a causa exata no cabeçalho/resposta, prioriza.
  const explicitRelay = classifyRelayErrorKind(relayErrorKind);
  if (explicitRelay) return explicitRelay;

  // 1) Resposta HTTP com erro tem prioridade (401/403 ≠ 404 ≠ 502 ≠ 504...).
  if (typeof responseCode === "number" && responseCode >= 400) {
    return classifyHttpCode(responseCode, relayErrorKind);
  }

  // 2) Causas específicas de timeout, manifesto e codecs antes do genérico de rede.
  if (d.includes("timeout")) return "timeout";
  if (d.includes("manifestincompatiblecodecs") || d.includes("bufferaddcodec") || d.includes("codec"))
    return "codec_unsupported";
  if (d.includes("keysystem") || d.includes("license") || d.includes("drm"))
    return "codec_unsupported";
  if (d.includes("manifestparsing") || d.includes("manifest_parse")) return "manifest_invalid";
  if (d.includes("levelempty")) return "manifest_invalid";
  if (d.includes("bufferappend") || d.includes("fragparsing") || d.includes("fragdecrypt"))
    return "codec_unsupported";

  // 3) Rede falhou sem resposta HTTP:
  //    - Sem relay (direto no browser): bloqueio de CORS (ou queda antes dos headers).
  //    - Com relay (same-origin): falha de rede com o serviço ou conexão interrompida.
  if (responseCode === 0 || responseCode === null) {
    if (type === "networkError" || d.includes("loaderror") || d.includes("network")) {
      return viaRelay ? "network_error" : "blocked_cors";
    }
  }

  if (type === "mediaError") return "codec_unsupported";
  return "undetermined";
}

/** Evidências coletadas durante um teste de canal. */
export interface StreamEvidence {
  /** Manifesto principal baixado e analisado. */
  manifestParsed: boolean;
  /** Pelo menos uma playlist de variante (nível) carregada. */
  levelLoaded: boolean;
  /** Algum fragmento de mídia foi baixado. */
  fragLoaded: boolean;
  /** Fragmento anexado ao MediaSource buffer OU evento 'playing'/'loadeddata'. */
  playbackEvidence: boolean;
  /** O teste esgotou o tempo limite sem concluir o playback. */
  timedOut?: boolean;
}

/**
 * Decide o estado final ao encerrar o teste (timeout ou término).
 * Garante: sem evidência de mídia, NUNCA retorna "playing".
 */
export function decideOutcome(
  ev: StreamEvidence,
  classifiedError: TestState | null,
): TestState {
  if (ev.playbackEvidence) return "playing";
  if (classifiedError && classifiedError !== "undetermined") return classifiedError;
  if (ev.manifestParsed) return "reachable_unconfirmed";
  if (ev.timedOut) return "timeout";
  if (classifiedError) return classifiedError;
  return "undetermined";
}

/* ------------------------- importação por URL ------------------------- */

export type ImportErrorKind =
  | "cors"
  | "timeout"
  | "aborted"
  | "auth"
  | "http_error"
  | "not_found"
  | "too_large"
  | "invalid_content"
  | "network"
  | "blocked_private";

export function classifyImportHttpStatus(status: number): ImportErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 413) return "too_large";
  if (status === 422) return "blocked_private";
  return "http_error";
}

/**
 * Erro de fetch no navegador: TypeError sem resposta = rede falhou antes de
 * qualquer resposta HTTP. Na prática isso é CORS na maioria dos casos, mas
 * também pode ser DNS/conexão.
 */
export function classifyImportFetchError(err: unknown, timedOut: boolean): ImportErrorKind {
  if (timedOut) return "timeout";
  if (err instanceof DOMException && err.name === "AbortError") return "aborted";
  if (err instanceof Error && err.name === "AbortError") return "aborted";
  if (err instanceof TypeError) return "cors";
  return "network";
}

export const IMPORT_ERROR_MESSAGES: Record<ImportErrorKind, { title: string; hint: string }> = {
  cors: {
    title: "Leitura direta bloqueada pelo navegador (CORS)",
    hint: "A origem não permite leitura direta por outros sites (CORS). O aplicativo pode buscar a lista pelo serviço integrado com validação SSRF, ou você pode importar o arquivo localmente.",
  },
  timeout: {
    title: "Tempo limite esgotado (Timeout)",
    hint: "O servidor demorou demais para responder. Tente novamente ou verifique se o endereço está correto.",
  },
  aborted: {
    title: "Importação cancelada",
    hint: "A busca foi interrompida por você. A playlist anterior foi preservada.",
  },
  auth: {
    title: "Acesso negado (401/403)",
    hint: "O servidor exige autenticação ou a URL expirou. Verifique as credenciais com o provedor.",
  },
  http_error: {
    title: "Origem indisponível (erro HTTP)",
    hint: "O endereço respondeu com um código de erro HTTP. Confira se a URL da playlist está ativa.",
  },
  not_found: {
    title: "Endereço não encontrado (404)",
    hint: "Não há playlist nesse endereço. Verifique a URL informada.",
  },
  too_large: {
    title: "Playlist grande demais",
    hint: "O conteúdo excede o limite aceito. Baixe o arquivo e tente importá-lo localmente.",
  },
  invalid_content: {
    title: "Erro de importação: conteúdo não é M3U válido",
    hint: "O endereço respondeu, mas o conteúdo não contém canais M3U (#EXTM3U/#EXTINF).",
  },
  network: {
    title: "Falha de rede",
    hint: "Não foi possível alcançar o servidor (DNS ou conexão recusada). Confira sua conexão e o endereço.",
  },
  blocked_private: {
    title: "Acesso negado: destino interno bloqueado",
    hint: "O serviço aceita apenas destinos públicos da internet. Endereços locais/privados são bloqueados (proteção SSRF).",
  },
};
