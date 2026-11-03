/**
 * Relay de mídia incremental com proteção SSRF:
 * - Valida URL inicial, protocolo (http/https), host, IPv4/IPv6 e DNS no momento da conexão.
 * - Segue redirects manualmente (máx. 5 hops), revalidando cada destino contra SSRF.
 * - Repassa cabeçalhos Range / If-Range e devolve 206 Partial Content + Content-Range.
 * - Detecta manifestos HLS (#EXTM3U) e reescreve todas as referências (master, variantes,
 *   caminhos relativos, query params, segmentos, #EXT-X-MAP, #EXT-X-KEY) para passarem pelo relay.
 * - Faz streaming incremental de mídia binária via ReadableStream com controle de backpressure,
 *   SEM baixar o vídeo inteiro para memória ou disco.
 * - Encerra imediatamente o socket upstream quando o cliente aborta a requisição
 *   (fechar player, parar teste ou timeout).
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { RelayErrorKind } from "@/lib/iptv/classify";
import { redactUrl } from "@/lib/iptv/redact";
import { isPlayableHlsManifest, looksLikeHlsManifest, rewriteHlsManifest } from "@/lib/hls/rewrite";
import { buildSignedRelayPath, type ForwardedStreamHeaders } from "@/lib/relay/auth";
import { isPublicIp } from "@/lib/ssrf/ip";
import { validateRedirectTarget, validateTargetUrl, type PolicyVerdict } from "@/lib/ssrf/policy";

export const MAX_RELAY_REDIRECTS = 5;
export const MAX_MANIFEST_BYTES = 5 * 1024 * 1024; // 5 MB máx para texto de manifesto M3U8
export const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
export const PEEK_BYTES = 2048;

export interface RelayStreamOptions {
  method?: "GET" | "HEAD";
  range?: string | null;
  ifRange?: string | null;
  headers?: ForwardedStreamHeaders;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Usado apenas no modo diagnóstico (probe=1) para inspecionar cabeçalhos/início e fechar. */
  probeOnly?: boolean;
  /**
   * Exclusivo para testes automatizados com servidor HTTP local de fixture.
   * Nunca é exposto por parâmetros HTTP.
   */
  _testAllowLoopback?: boolean;
}

export type RelayStreamResult =
  | {
      ok: true;
      mode: "manifest";
      status: number;
      contentType: string;
      manifest: string;
      finalUrl: string;
      redirects: number;
    }
  | {
      ok: true;
      mode: "stream";
      status: number;
      contentType: string;
      contentLength?: string;
      contentRange?: string;
      acceptRanges?: string;
      stream: ReadableStream<Uint8Array>;
      finalUrl: string;
      redirects: number;
    }
  | {
      ok: true;
      mode: "probe";
      status: number;
      contentType: string;
      isHls: boolean;
      finalUrl: string;
      redirects: number;
    }
  | {
      ok: false;
      status: number;
      kind: RelayErrorKind;
      message: string;
    };

type LookupArgs = [err: NodeJS.ErrnoException | null, address: string, family: number];
type LookupAllArgs = [err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]];
type LookupCb = (...args: LookupArgs | LookupAllArgs) => void;

function createGuardedLookup(allowLoopback: boolean) {
  return function guardedLookup(hostname: string, options: unknown, cb: LookupCb): void {
    const wantAll = Boolean((options as { all?: boolean } | undefined)?.all);
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        if (wantAll) cb(err as NodeJS.ErrnoException, []);
        else cb(err as NodeJS.ErrnoException, "", 4);
        return;
      }
      const allowed = addresses.filter((a) =>
        allowLoopback && (a.address === "127.0.0.1" || a.address === "::1")
          ? true
          : isPublicIp(a.address),
      );
      if (allowed.length === 0) {
        const e = new Error("BLOCKED_PRIVATE_ADDRESS") as NodeJS.ErrnoException;
        e.code = "BLOCKED_PRIVATE_ADDRESS";
        if (wantAll) cb(e, []);
        else cb(e, "", 4);
        return;
      }
      if (wantAll) cb(null, allowed);
      else cb(null, allowed[0].address, allowed[0].family);
    });
  };
}

function validateRelayTarget(
  rawUrl: string,
  allowLoopback: boolean,
): PolicyVerdict {
  if (allowLoopback) {
    try {
      const u = new URL(rawUrl.trim());
      if (
        (u.protocol === "http:" || u.protocol === "https:") &&
        (u.hostname === "127.0.0.1" || u.hostname === "[::1]") &&
        u.searchParams.get("ssrf_block") !== "1"
      ) {
        return { ok: true, url: u };
      }
    } catch {
      /* fallback para validação padrão */
    }
  }
  return validateTargetUrl(rawUrl);
}

function validateRelayRedirect(
  current: URL,
  location: string,
  allowLoopback: boolean,
): PolicyVerdict {
  if (allowLoopback) {
    try {
      const next = new URL(location, current);
      // Permite que o teste simule redirecionamento para IP privado bloqueado (ex.: 10.0.0.1, 169.254.169.254, localhost)
      if (
        (next.hostname === "127.0.0.1" || next.hostname === "[::1]") &&
        next.searchParams.get("ssrf_block") !== "1"
      ) {
        return { ok: true, url: next };
      }
    } catch {
      return { ok: false, reason: "Redirecionamento inválido" };
    }
  }
  return validateRedirectTarget(current, location);
}

interface UpstreamHop {
  req: http.ClientRequest;
  res: http.IncomingMessage;
}

function openSingleHop(
  url: URL,
  opts: {
    method: "GET" | "HEAD";
    range?: string | null;
    ifRange?: string | null;
    headers?: ForwardedStreamHeaders;
    timeoutMs: number;
    signal?: AbortSignal;
    allowLoopback: boolean;
  },
): Promise<UpstreamHop> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(Object.assign(new Error("ABORTED"), { code: "ABORTED" }));
      return;
    }

    const mod = url.protocol === "https:" ? https : http;
    const reqHeaders: Record<string, string> = {
      "User-Agent":
        opts.headers?.userAgent ||
        "SinalStreamRelay/1.0 (Mozilla/5.0 compatible; Web IPTV Player)",
      Accept:
        "application/vnd.apple.mpegurl, application/x-mpegurl, audio/mpegurl, video/mp2t, video/mp4, */*",
      "Accept-Encoding": "identity",
    };

    if (opts.range && /^bytes=\d*-\d*(,\s*\d*-\d*)*$/.test(opts.range.trim())) {
      reqHeaders["Range"] = opts.range.trim();
    }
    if (opts.ifRange) {
      reqHeaders["If-Range"] = opts.ifRange.replace(/[\r\n]/g, "").slice(0, 128);
    }
    if (opts.headers?.referer) {
      reqHeaders["Referer"] = opts.headers.referer;
    }

    const req = mod.request(
      url,
      {
        method: opts.method,
        lookup: createGuardedLookup(opts.allowLoopback) as unknown as typeof dns.lookup,
        headers: reqHeaders,
        timeout: opts.timeoutMs,
      },
      (res) => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({ req, res });
      },
    );

    const onAbort = () => {
      req.destroy(Object.assign(new Error("ABORTED"), { code: "ABORTED" }));
      reject(Object.assign(new Error("ABORTED"), { code: "ABORTED" }));
    };

    opts.signal?.addEventListener("abort", onAbort, { once: true });

    req.on("timeout", () => {
      opts.signal?.removeEventListener("abort", onAbort);
      req.destroy(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }));
    });

    req.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    req.end();
  });
}

function looksLikeHtmlDocument(text: string): boolean {
  const s = text.trimStart().slice(0, 256).toLowerCase();
  return s.startsWith("<!doctype html") || s.startsWith("<html") || s.startsWith("<head");
}

function isLikelyManifestContentType(ct: string, url: URL): boolean {
  const lower = ct.toLowerCase();
  if (
    lower.includes("mpegurl") ||
    lower.includes("m3u")
  ) {
    return true;
  }
  const path = url.pathname.toLowerCase();
  if (path.endsWith(".m3u8") || path.endsWith(".m3u")) {
    return true;
  }
  return false;
}

function isBinaryMediaContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return (
    lower.startsWith("video/") ||
    lower.startsWith("audio/") ||
    lower.includes("iso.segment") ||
    lower.includes("mp2t") ||
    lower.includes("mp4") ||
    lower.includes("webm") ||
    lower.includes("ogg") ||
    lower.includes("aac") ||
    lower.includes("mpeg")
  ) && !lower.includes("mpegurl");
}

/**
 * Lê apenas os primeiros bytes da resposta para decidir se o conteúdo é um
 * manifesto #EXTM3U, uma página HTML de erro, ou um fluxo binário de mídia.
 */
function peekInitialBytes(
  req: http.ClientRequest,
  res: http.IncomingMessage,
  maxPeek: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const timer = setTimeout(() => {
      finishErr(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      res.removeListener("data", onData);
      res.removeListener("end", onEnd);
      res.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    const finishOk = (buf: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buf);
    };

    const finishErr = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      res.destroy();
      req.destroy();
      reject(err);
    };

    const onAbort = () => finishErr(Object.assign(new Error("ABORTED"), { code: "ABORTED" }));
    const onError = (err: Error) => finishErr(err);
    const onEnd = () => finishOk(Buffer.concat(chunks));
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxPeek) {
        res.pause();
        finishOk(Buffer.concat(chunks));
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    res.on("data", onData);
    res.on("end", onEnd);
    res.on("error", onError);
  });
}

function readRemainingManifest(
  req: http.ClientRequest,
  res: http.IncomingMessage,
  initial: Buffer,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (res.complete) {
      resolve(initial.toString("utf8"));
      return;
    }
    const chunks: Buffer[] = [initial];
    let total = initial.length;
    let settled = false;

    const timer = setTimeout(() => {
      finishErr(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      res.removeListener("data", onData);
      res.removeListener("end", onEnd);
      res.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    const finishErr = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      res.destroy();
      req.destroy();
      reject(err);
    };

    const onAbort = () => finishErr(Object.assign(new Error("ABORTED"), { code: "ABORTED" }));
    const onError = (err: Error) => finishErr(err);
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finishErr(Object.assign(new Error("TOO_LARGE"), { code: "TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    res.on("data", onData);
    res.on("end", onEnd);
    res.on("error", onError);
    res.resume();
  });
}

function createIncrementalReadableStream(
  req: http.ClientRequest,
  res: http.IncomingMessage,
  initialChunk: Buffer,
  timeoutMs: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const destroyUpstream = () => {
    if (closed) return;
    closed = true;
    clearIdle();
    signal?.removeEventListener("abort", destroyUpstream);
    try {
      res.destroy();
    } catch {
      /* noop */
    }
    try {
      req.destroy();
    } catch {
      /* noop */
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const resetIdle = () => {
        clearIdle();
        idleTimer = setTimeout(() => {
          destroyUpstream();
          try {
            controller.error(new Error("STREAM_IDLE_TIMEOUT"));
          } catch {
            /* noop */
          }
        }, timeoutMs);
      };

      if (signal?.aborted) {
        destroyUpstream();
        controller.close();
        return;
      }
      signal?.addEventListener("abort", () => {
        destroyUpstream();
        try {
          controller.close();
        } catch {
          /* noop */
        }
      }, { once: true });

      if (initialChunk.length > 0) {
        controller.enqueue(new Uint8Array(initialChunk));
      }

      if (res.complete) {
        closed = true;
        clearIdle();
        controller.close();
        return;
      }

      resetIdle();

      res.on("data", (chunk: Buffer) => {
        if (closed) return;
        resetIdle();
        try {
          controller.enqueue(new Uint8Array(chunk));
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            res.pause();
          }
        } catch {
          destroyUpstream();
        }
      });

      res.on("end", () => {
        if (closed) return;
        closed = true;
        clearIdle();
        try {
          controller.close();
        } catch {
          /* noop */
        }
      });

      res.on("error", (err) => {
        if (closed) return;
        destroyUpstream();
        try {
          controller.error(err);
        } catch {
          /* noop */
        }
      });

      res.resume();
    },
    pull() {
      if (!closed) {
        res.resume();
      }
    },
    cancel() {
      destroyUpstream();
    },
  });
}

function mapNetworkError(err: unknown, targetUrl: string): RelayStreamResult {
  const code = (err as NodeJS.ErrnoException)?.code ?? "";
  if (code === "TIMEOUT" || code === "ETIMEDOUT" || code === "ECONNABORTED") {
    return {
      ok: false,
      status: 504,
      kind: "timeout",
      message: `Tempo limite esgotado ao conectar a ${redactUrl(targetUrl)}.`,
    };
  }
  if (code === "BLOCKED_PRIVATE_ADDRESS") {
    return {
      ok: false,
      status: 422,
      kind: "blocked_private",
      message: `O host de ${redactUrl(targetUrl)} resolve para endereço privado/interno — bloqueado por segurança (SSRF).`,
    };
  }
  if (code === "TOO_LARGE") {
    return {
      ok: false,
      status: 422,
      kind: "manifest_invalid",
      message: "O manifesto excede o limite seguro de tamanho.",
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      ok: false,
      status: 502,
      kind: "network_error",
      message: `Falha de DNS: não foi possível resolver o host de ${redactUrl(targetUrl)}.`,
    };
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return {
      ok: false,
      status: 502,
      kind: "network_error",
      message: `Falha de rede (${code}) ao conectar a ${redactUrl(targetUrl)}.`,
    };
  }
  return {
    ok: false,
    status: 502,
    kind: "network_error",
    message: `Falha de conexão com a origem (${code || "erro de rede"}).`,
  };
}

export async function openRelayStream(
  rawUrl: string,
  opts: RelayStreamOptions = {},
): Promise<RelayStreamResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const method = opts.method ?? "GET";
  const allowLoopback = Boolean(opts._testAllowLoopback);

  const initialVerdict = validateRelayTarget(rawUrl, allowLoopback);
  if (!initialVerdict.ok) {
    const isSchemeOrFormat =
      initialVerdict.reason.includes("http/https") ||
      initialVerdict.reason.includes("URL") ||
      initialVerdict.reason.includes("Host ausente");
    return {
      ok: false,
      status: 422,
      kind: isSchemeOrFormat ? "import_error" : "blocked_private",
      message: initialVerdict.reason,
    };
  }

  let current: URL = initialVerdict.url;
  let redirects = 0;

  for (;;) {
    let hop: UpstreamHop;
    try {
      hop = await openSingleHop(current, {
        method,
        range: opts.range,
        ifRange: opts.ifRange,
        headers: opts.headers,
        timeoutMs,
        signal: opts.signal,
        allowLoopback,
      });
    } catch (err) {
      return mapNetworkError(err, current.toString());
    }

    const { req, res } = hop;
    const status = res.statusCode ?? 0;

    // Tratamento manual de redirects com revalidação SSRF a cada hop
    if (status >= 300 && status < 400 && typeof res.headers.location === "string") {
      res.resume();
      req.destroy();
      if (redirects >= MAX_RELAY_REDIRECTS) {
        return {
          ok: false,
          status: 502,
          kind: "network_error",
          message: `Redirecionamentos em excesso (>${MAX_RELAY_REDIRECTS}) em ${redactUrl(current.toString())}.`,
        };
      }
      const next = validateRelayRedirect(current, res.headers.location, allowLoopback);
      if (!next.ok) {
        return {
          ok: false,
          status: 422,
          kind: "blocked_private",
          message: `Redirecionamento bloqueado: ${next.reason}.`,
        };
      }
      current = next.url;
      redirects++;
      continue;
    }

    // Erros HTTP da origem
    if (status < 200 || status >= 300) {
      res.resume();
      req.destroy();
      if (status === 401 || status === 403) {
        return {
          ok: false,
          status,
          kind: "auth_failed",
          message: `Acesso negado pela origem (HTTP ${status}) em ${redactUrl(current.toString())}.`,
        };
      }
      if (status === 408 || status === 504) {
        return {
          ok: false,
          status: 504,
          kind: "timeout",
          message: `A origem excedeu o tempo limite (HTTP ${status}).`,
        };
      }
      return {
        ok: false,
        status: status >= 400 && status < 600 ? status : 502,
        kind: "unavailable",
        message: `A origem respondeu HTTP ${status} para ${redactUrl(current.toString())}.`,
      };
    }

    const rawContentType = String(res.headers["content-type"] ?? "application/octet-stream");

    if (method === "HEAD") {
      res.resume();
      req.destroy();
      return {
        ok: true,
        mode: "probe",
        status,
        contentType: rawContentType,
        isHls: isLikelyManifestContentType(rawContentType, current),
        finalUrl: current.toString(),
        redirects,
      };
    }

    // Inspeciona os primeiros bytes para distinguir manifesto HLS (#EXTM3U), HTML inválido ou mídia binária
    let initialChunk: Buffer;
    try {
      initialChunk = await peekInitialBytes(req, res, PEEK_BYTES, timeoutMs, opts.signal);
    } catch (err) {
      return mapNetworkError(err, current.toString());
    }

    const initialText = initialChunk.toString("utf8");
    const isHls = looksLikeHlsManifest(initialText);

    if (opts.probeOnly) {
      res.destroy();
      req.destroy();
      if (looksLikeHtmlDocument(initialText)) {
        return {
          ok: false,
          status: 422,
          kind: "manifest_invalid",
          message: "O endereço retornou uma página HTML em vez de uma transmissão de mídia.",
        };
      }
      return {
        ok: true,
        mode: "probe",
        status,
        contentType: rawContentType,
        isHls,
        finalUrl: current.toString(),
        redirects,
      };
    }

    // Se o servidor devolveu uma página HTML quando esperávamos manifesto ou stream
    if (looksLikeHtmlDocument(initialText)) {
      res.destroy();
      req.destroy();
      return {
        ok: false,
        status: 422,
        kind: "manifest_invalid",
        message: "O endereço retornou uma página HTML em vez de um manifesto ou stream de mídia válido.",
      };
    }

    // Se a URL/Content-Type prometia ser M3U8 mas o conteúdo não começa com #EXTM3U e não é mídia binária
    if (!isHls && isLikelyManifestContentType(rawContentType, current) && !isBinaryMediaContentType(rawContentType)) {
      // Verifica se começa com sync byte MPEG-TS (0x47) ou caixa fMP4/MP4 ('ftyp'/'styp'/'moof')
      const isTsSync = initialChunk.length > 0 && initialChunk[0] === 0x47;
      const boxType = initialChunk.length >= 8 ? initialChunk.subarray(4, 8).toString("ascii") : "";
      const isMp4Box = boxType === "ftyp" || boxType === "styp" || boxType === "moof" || boxType === "free";
      if (!isTsSync && !isMp4Box) {
        res.destroy();
        req.destroy();
        return {
          ok: false,
          status: 422,
          kind: "manifest_invalid",
          message: "O conteúdo recebido não é um manifesto HLS (#EXTM3U) válido.",
        };
      }
    }

    if (isHls) {
      let fullManifest: string;
      try {
        fullManifest = await readRemainingManifest(
          req,
          res,
          initialChunk,
          MAX_MANIFEST_BYTES,
          timeoutMs,
          opts.signal,
        );
      } catch (err) {
        return mapNetworkError(err, current.toString());
      }

      if (!isPlayableHlsManifest(fullManifest)) {
        return {
          ok: false,
          status: 422,
          kind: "manifest_invalid",
          message: "O manifesto HLS está vazio ou não contém variantes/segmentos reproduzíveis.",
        };
      }

      const finalBaseUrl = current.toString();
      const rewritten = rewriteHlsManifest(fullManifest, finalBaseUrl, (resolvedUrl) =>
        buildSignedRelayPath(resolvedUrl, { headers: opts.headers }),
      );

      return {
        ok: true,
        mode: "manifest",
        status: 200,
        contentType: "application/vnd.apple.mpegurl; charset=utf-8",
        manifest: rewritten,
        finalUrl: finalBaseUrl,
        redirects,
      };
    }

    // Stream binário (segmento .ts/.m4s/.aac ou arquivo/stream direto .mp4/.webm/.mp3)
    const stream = createIncrementalReadableStream(req, res, initialChunk, timeoutMs, opts.signal);
    const contentLength =
      typeof res.headers["content-length"] === "string" ? res.headers["content-length"] : undefined;
    const contentRange =
      typeof res.headers["content-range"] === "string" ? res.headers["content-range"] : undefined;
    const acceptRanges =
      typeof res.headers["accept-ranges"] === "string" ? res.headers["accept-ranges"] : "bytes";

    return {
      ok: true,
      mode: "stream",
      status,
      contentType: rawContentType,
      contentLength,
      contentRange,
      acceptRanges,
      stream,
      finalUrl: current.toString(),
      redirects,
    };
  }
}
