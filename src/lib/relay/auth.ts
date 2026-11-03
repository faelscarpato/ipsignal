/**
 * Controle de acesso e autorização do relay de mídia:
 * - Impede que /api/stream-relay funcione como proxy público aberto.
 * - Restringe o uso a requisições originadas pela própria aplicação
 *   (validação de Sec-Fetch-Site / Origin / Referer) e a fontes/URLs que o
 *   usuário configurou/importou para uso autorizado.
 * - Assina via HMAC-SHA256 tanto a sessão de fontes autorizadas quanto cada
 *   URL derivada reescrita em manifestos HLS (variantes, segmentos, chaves),
 *   permitindo que CDNs secundárias referenciadas por um manifesto autorizado
 *   funcionem sem abrir o relay para destinos arbitrários.
 */

import crypto from "node:crypto";
import { validateHttpUrl } from "@/lib/iptv/validate";
import { extractDirectiveHeaders, type ForwardedStreamHeaders } from "./directives";

export { extractDirectiveHeaders, type ForwardedStreamHeaders };

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const MAX_AUTHORIZED_ORIGINS = 5000;

interface RelayGlobalState {
  secret: Buffer;
  authorizedOrigins: Map<string, number>;
}

const globalForRelay = globalThis as unknown as { __sinalRelayState?: RelayGlobalState };

function getRelayState(): RelayGlobalState {
  if (!globalForRelay.__sinalRelayState) {
    const seed =
      process.env.RELAY_SECRET ||
      process.env.VERCEL_PROJECT_ID ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      "sinal-iptv-studio-relay-hmac-key";
    const secret = crypto.createHash("sha256").update(seed).digest();
    globalForRelay.__sinalRelayState = {
      secret,
      authorizedOrigins: new Map(),
    };
  }
  return globalForRelay.__sinalRelayState;
}

function hmacHex(payload: string): string {
  const { secret } = getRelayState();
  return crypto.createHmac("sha256", secret).update(payload).digest("hex").slice(0, 32);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

function pruneExpiredOrigins(now = Date.now()): void {
  const { authorizedOrigins } = getRelayState();
  if (authorizedOrigins.size <= MAX_AUTHORIZED_ORIGINS) return;
  for (const [origin, exp] of authorizedOrigins.entries()) {
    if (exp <= now) authorizedOrigins.delete(origin);
  }
  if (authorizedOrigins.size > MAX_AUTHORIZED_ORIGINS) {
    const firstKey = authorizedOrigins.keys().next().value;
    if (firstKey) authorizedOrigins.delete(firstKey);
  }
}

/**
 * Registra URLs/origens que o usuário importou ou configurou na aplicação
 * como fontes autorizadas para o relay e devolve um token de sessão assinado.
 */
export function authorizeRelaySources(
  urls: string[],
  ttlMs = DEFAULT_TTL_MS,
): { token: string; expiresAt: number; authorizedCount: number } {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const { authorizedOrigins } = getRelayState();
  pruneExpiredOrigins(now);

  let authorizedCount = 0;
  for (const raw of urls) {
    const check = validateHttpUrl(raw);
    if (!check.ok) continue;
    authorizedOrigins.set(check.url.origin.toLowerCase(), expiresAt);
    authorizedCount++;
  }

  const expStr = expiresAt.toString(36);
  const mac = hmacHex(`session|${expStr}`);
  return {
    token: `${expStr}.${mac}`,
    expiresAt,
    authorizedCount,
  };
}

/** Verifica se um token de sessão emitido por authorizeRelaySources é válido. */
export function verifySessionToken(
  token: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = parseInt(expStr, 36);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = hmacHex(`session|${expStr}`);
  return timingSafeEqualStr(sig, expected);
}

/**
 * Assina uma URL específica (usado tanto ao autorizar um canal quanto ao
 * reescrever referências internas de um manifesto HLS no servidor).
 */
export function signRelayTargetUrl(
  targetUrl: string,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): string {
  const exp = (now + ttlMs).toString(36);
  const mac = hmacHex(`url|${targetUrl}|${exp}`);
  return `${exp}.${mac}`;
}

/** Verifica a assinatura HMAC de uma URL específica. */
export function verifySignedTargetUrl(
  targetUrl: string,
  sigParam: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!sigParam || typeof sigParam !== "string") return false;
  const dot = sigParam.indexOf(".");
  if (dot <= 0) return false;
  const expStr = sigParam.slice(0, dot);
  const sig = sigParam.slice(dot + 1);
  const exp = parseInt(expStr, 36);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = hmacHex(`url|${targetUrl}|${expStr}`);
  return timingSafeEqualStr(sig, expected);
}

/** Verifica se a origem da URL alvo foi previamente autorizada pelo usuário. */
export function isOriginAuthorized(targetUrl: string, now = Date.now()): boolean {
  try {
    const u = new URL(targetUrl);
    const { authorizedOrigins } = getRelayState();
    const exp = authorizedOrigins.get(u.origin.toLowerCase());
    if (!exp) return false;
    if (exp <= now) {
      authorizedOrigins.delete(u.origin.toLowerCase());
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Constrói a URL do relay no servidor com assinatura HMAC embutida para a URL alvo.
 */
export function buildSignedRelayPath(
  targetUrl: string,
  opts?: { headers?: ForwardedStreamHeaders; ttlMs?: number; now?: number },
): string {
  const sig = signRelayTargetUrl(targetUrl, opts?.ttlMs, opts?.now);
  const params = new URLSearchParams();
  params.set("url", targetUrl);
  params.set("sig", sig);
  if (opts?.headers?.userAgent) params.set("ua", opts.headers.userAgent);
  if (opts?.headers?.referer) params.set("ref", opts.headers.referer);
  return `/api/stream-relay?${params.toString()}`;
}

/**
 * Valida se uma requisição HTTP foi iniciada pela própria aplicação (mesma origem)
 * e não por um site externo (proteção anti-hotlink / anti-CSRF / anti-proxy-aberto).
 */
export function verifySameOriginRequest(req: Request): { ok: true } | { ok: false; reason: string } {
  const secFetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return {
      ok: false,
      reason: "Requisição cross-site bloqueada: o relay só aceita chamadas da própria aplicação.",
    };
  }

  const reqUrl = new URL(req.url);
  const expectedHost = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? reqUrl.host).toLowerCase();

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      if (originHost !== expectedHost) {
        return {
          ok: false,
          reason: "Origem não autorizada para uso do relay.",
        };
      }
    } catch {
      return { ok: false, reason: "Cabeçalho Origin inválido." };
    }
  }

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      const refHost = new URL(referer).host.toLowerCase();
      if (refHost !== expectedHost) {
        return {
          ok: false,
          reason: "Referer externo não autorizado para uso do relay.",
        };
      }
    } catch {
      return { ok: false, reason: "Cabeçalho Referer inválido." };
    }
  }

  return { ok: true };
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export const RELAY_COOKIE_NAME = "sinal_relay_token";

/**
 * Verifica se uma chamada GET/HEAD ao relay está devidamente autorizada:
 * 1) Deve respeitar a política de mesma origem (Sec-Fetch-Site / Origin / Referer).
 * 2) Deve possuir assinatura explícita (`sig`) válida para a `targetUrl` (ex.: recursos HLS
 *    reescritos ou URLs assinadas pela sessão) OU um token de sessão válido (`token`,
 *    header `x-sinal-relay-token` ou cookie `sinal_relay_token`) combinado com uma origem
 *    previamente autorizada pelo usuário.
 */
export function verifyRelayAccess(
  req: Request,
  targetUrl: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const sameOrigin = verifySameOriginRequest(req);
  if (!sameOrigin.ok) return sameOrigin;

  const reqUrl = new URL(req.url);
  const sig = reqUrl.searchParams.get("sig");
  if (sig && verifySignedTargetUrl(targetUrl, sig, now)) {
    return { ok: true };
  }

  const token =
    reqUrl.searchParams.get("token") ??
    req.headers.get("x-sinal-relay-token") ??
    readCookie(req.headers.get("cookie"), RELAY_COOKIE_NAME);

  if (verifySessionToken(token, now) && isOriginAuthorized(targetUrl, now)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      "Acesso ao relay negado: fonte não autorizada pela sessão da aplicação ou token ausente/expirado.",
  };
}

/** Limpa fontes autorizadas (usado em testes e no encerramento de sessão). */
export function clearAuthorizedRelaySources(): void {
  getRelayState().authorizedOrigins.clear();
}
