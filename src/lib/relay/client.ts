/**
 * Cliente do relay de mídia no navegador:
 * - Gerencia o token de sessão emitido por POST /api/stream-relay para as fontes
 *   que o usuário importou ou adicionou;
 * - Constrói URLs do relay (/api/stream-relay?url=...&token=...) compartilhadas
 *   entre o testador (tester.ts) e o player (PlayerDialog.tsx).
 */

import { extractDirectiveHeaders } from "./directives";

let cachedToken: string | null = null;
let cachedExpiresAt = 0;
const authorizedSet = new Set<string>();

function extractOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin.toLowerCase();
  } catch {
    return null;
  }
}

export function getCachedRelayToken(): string | null {
  if (cachedToken && Date.now() < cachedExpiresAt - 60_000) {
    return cachedToken;
  }
  return null;
}

/**
 * Registra um conjunto de URLs (da playlist importada ou canal adicionado)
 * junto ao servidor do aplicativo para uso autorizado no relay.
 */
export async function ensureRelayAuthorized(
  urls: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  if (typeof window === "undefined") return null;

  const validUrls = urls.filter((u) => /^https?:\/\//i.test(u.trim()));
  if (validUrls.length === 0) return getCachedRelayToken();

  const token = getCachedRelayToken();
  const allAlreadyAuthorized =
    Boolean(token) &&
    validUrls.every((u) => {
      const origin = extractOrigin(u);
      return origin ? authorizedSet.has(origin) : false;
    });

  if (allAlreadyAuthorized && token) {
    return token;
  }

  try {
    const res = await fetch("/api/stream-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: validUrls }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      ok?: boolean;
      token?: string;
      expiresAt?: number;
    };
    if (data.ok && data.token) {
      cachedToken = data.token;
      cachedExpiresAt = data.expiresAt ?? Date.now() + 3600_000;
      for (const u of validUrls) {
        const origin = extractOrigin(u);
        if (origin) authorizedSet.add(origin);
      }
      return data.token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Solicita ao servidor uma URL de relay assinada com HMAC para um canal específico
 * (ou constrói com o token de sessão já ativo).
 */
export async function resolveChannelRelayUrl(
  url: string,
  directives?: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const token = await ensureRelayAuthorized([url], signal);
  const headers = extractDirectiveHeaders(directives);
  const params = new URLSearchParams();
  params.set("url", url);
  if (token) params.set("token", token);
  if (headers.userAgent) params.set("ua", headers.userAgent);
  if (headers.referer) params.set("ref", headers.referer);
  return `/api/stream-relay?${params.toString()}`;
}

export function resetClientRelaySession(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
  authorizedSet.clear();
}
