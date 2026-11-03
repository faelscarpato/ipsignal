/**
 * Fetch de playlist no servidor com proteção SSRF (sem dependências externas):
 * - DNS resolvido com lookup personalizado que só entrega ao socket endereços
 *   já validados como públicos (conexão AMARRADA a IP validado → anti-rebinding);
 * - redirects seguidos manualmente, cada hop revalidado pela política;
 * - limites de tempo, bytes e número de redirects;
 * - segredos da URL nunca aparecem em erros (redactUrl).
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { ImportErrorKind } from "@/lib/iptv/classify";
import { classifyImportHttpStatus } from "@/lib/iptv/classify";
import { redactUrl } from "@/lib/iptv/redact";
import { isPublicIp } from "./ip";
import { validateRedirectTarget, validateTargetUrl } from "./policy";

export interface SsrfFetchOk {
  ok: true;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  redirects: number;
  finalUrlRedacted: string;
}

export interface SsrfFetchErr {
  ok: false;
  kind: ImportErrorKind;
  message: string;
}

export type SsrfFetchResult = SsrfFetchOk | SsrfFetchErr;

type LookupArgs = [err: NodeJS.ErrnoException | null, address: string, family: number];
type LookupAllArgs = [err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]];
type LookupCb = (...args: LookupArgs | LookupAllArgs) => void;

/**
 * Lookup que nunca devolve IP privado ao socket (anti-rebinding: valida NO
 * MOMENTO da conexão). Node >= 20 chama com all:true (autoSelectFamily) —
 * honramos os dois formatos.
 */
function guardedLookup(hostname: string, options: unknown, cb: LookupCb): void {
  const wantAll = Boolean((options as { all?: boolean } | undefined)?.all);
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      if (wantAll) cb(err as NodeJS.ErrnoException, []);
      else cb(err as NodeJS.ErrnoException, "", 4);
      return;
    }
    const allowed = addresses.filter((a) => isPublicIp(a.address));
    if (allowed.length === 0) {
      const e = new Error("BLOCKED_PRIVATE_ADDRESS") as NodeJS.ErrnoException;
      e.code = "BLOCKED_PRIVATE_ADDRESS";
      if (wantAll) cb(e, []);
      else cb(e, "", 4);
      return;
    }
    // entrega SOMENTE endereços validados — fecha a janela de DNS rebinding
    if (wantAll) cb(null, allowed);
    else cb(null, allowed[0].address, allowed[0].family);
  });
}

interface SingleResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function singleRequest(
  url: URL,
  opts: { timeoutMs: number; maxBytes: number },
): Promise<SingleResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup as unknown as typeof dns.lookup,
        headers: {
          "User-Agent": "PlaylistTester/1.0 (+ferramenta local de validação de playlists)",
          Accept: "audio/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*",
        },
        timeout: opts.timeoutMs,
      },
      (res) => {
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > opts.maxBytes) {
          res.resume();
          req.destroy();
          reject(Object.assign(new Error("TOO_LARGE"), { code: "TOO_LARGE" }));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > opts.maxBytes) {
            req.destroy();
            reject(Object.assign(new Error("TOO_LARGE"), { code: "TOO_LARGE" }));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }));
    });
    req.on("error", reject);
    req.end();
  });
}

const MAX_REDIRECTS = 4;

export async function ssrfFetchPlaylist(
  rawUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SsrfFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;

  const first = validateTargetUrl(rawUrl);
  if (!first.ok) {
    return {
      ok: false,
      kind: first.reason.includes("http/https") ? "invalid_content" : "blocked_private",
      message: first.reason,
    };
  }

  let current: URL = first.url;
  let redirects = 0;

  for (;;) {
    let res: SingleResponse;
    try {
      res = await singleRequest(current, { timeoutMs, maxBytes });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code === "TIMEOUT" || code === "ECONNABORTED")
        return { ok: false, kind: "timeout", message: "Tempo limite esgotado ao buscar a playlist." };
      if (code === "TOO_LARGE")
        return { ok: false, kind: "too_large", message: "Playlist excede o limite de tamanho." };
      if (code === "BLOCKED_PRIVATE_ADDRESS")
        return {
          ok: false,
          kind: "blocked_private",
          message: `O host de ${redactUrl(current.toString())} resolve para endereço não público — bloqueado por segurança.`,
        };
      if (code === "ENOTFOUND" || code === "EAI_AGAIN")
        return { ok: false, kind: "network", message: "Host não encontrado (DNS)." };
      return { ok: false, kind: "network", message: `Falha de conexão (${code || "erro desconhecido"}).` };
    }

    if (res.status >= 300 && res.status < 400 && typeof res.headers.location === "string") {
      if (redirects >= MAX_REDIRECTS)
        return { ok: false, kind: "network", message: "Redirecionamentos demais." };
      const next = validateRedirectTarget(current, res.headers.location);
      if (!next.ok)
        return {
          ok: false,
          kind: "blocked_private",
          message: `Redirecionamento bloqueado: ${next.reason}.`,
        };
      current = next.url;
      redirects++;
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        kind: classifyImportHttpStatus(res.status),
        message: `O servidor respondeu HTTP ${res.status} para ${redactUrl(current.toString())}.`,
      };
    }

    const contentType = String(res.headers["content-type"] ?? "");
    return {
      ok: true,
      status: res.status,
      contentType,
      body: res.body.toString("utf8"),
      bytes: res.body.length,
      redirects,
      finalUrlRedacted: redactUrl(current.toString()),
    };
  }
}
