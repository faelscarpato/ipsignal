/**
 * Política de destinos para a busca de playlist NO SERVIDOR (rota opt-in).
 * Validação sintática + denylist de hosts internos + allowlist de portas.
 * A checagem de DNS/IP acontece de novo NO MOMENTO DA CONEXÃO (lookup
 * guardado em fetch.ts) para fechar a janela de DNS rebinding, e cada hop
 * de redirecionamento passa por esta mesma validação.
 */

import { isIP } from "node:net";
import { isPublicIp } from "./ip";

export type PolicyVerdict = { ok: true; url: URL } | { ok: false; reason: string };

const ALLOWED_PORTS = new Set(["80", "443"]);
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.amazonaws.com",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp"];

export function validateTargetUrl(raw: string): PolicyVerdict {
  const input = raw.trim();
  if (!input || input.length > 2048) return { ok: false, reason: "URL vazia ou longa demais" };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "URL inválida" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Somente http/https são permitidos" };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "Host ausente" };

  if (url.port && !ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: "Porta não permitida (apenas 80/443)" };
  }

  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "Host local/interno bloqueado" };
  }

  // Literal de IP (IPv4 ou IPv6): checagem imediata.
  // WHATWG URL mantém os colchetes em hostname IPv6 ("[::1]") — removemos antes.
  const hostBare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(hostBare)) {
    if (!isPublicIp(hostBare)) {
      return { ok: false, reason: "Endereço de IP não público bloqueado" };
    }
  }

  return { ok: true, url };
}

/** Valida o destino de um redirect HTTP relativo à URL atual. */
export function validateRedirectTarget(current: URL, location: string): PolicyVerdict {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return { ok: false, reason: "Redirecionamento inválido" };
  }
  return validateTargetUrl(next.toString());
}
