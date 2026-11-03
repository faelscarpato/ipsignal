/**
 * Validação de URLs e textos vindos da playlist/usuário (lado do navegador).
 * Regra: somente http/https são aceitos para fontes remotas e streams.
 * (Sem escapes de controle em regex — comparações por charCode, explícitas.)
 */

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export const MAX_URL_LENGTH = 2048;
export const MAX_NAME_LENGTH = 300;
export const MAX_GROUP_LENGTH = 120;

/** true se houver espaço ou caractere de controle (código <= 32). */
function hasForbiddenUrlChars(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) <= 32) return true;
  }
  return false;
}

/** true se o caractere for de controle: C0 (0-31), DEL (127) ou C1 (128-159). */
function isControlChar(code: number): boolean {
  return code < 32 || (code >= 127 && code <= 159);
}

/** Remove caracteres de controle e limita o comprimento de textos de exibição. */
export function stripControlChars(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (!isControlChar(raw.charCodeAt(i))) out += raw[i];
  }
  return out;
}

export function validateHttpUrl(raw: string): UrlCheck {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "URL vazia" };
  if (input.length > MAX_URL_LENGTH)
    return { ok: false, reason: `URL excede ${MAX_URL_LENGTH} caracteres` };
  if (hasForbiddenUrlChars(input))
    return { ok: false, reason: "URL contém espaços ou caracteres de controle" };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "URL inválida" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: `Esquema "${url.protocol.replace(":", "")}" não é permitido — apenas http/https`,
    };
  }
  if (!url.hostname) return { ok: false, reason: "URL sem host" };
  return { ok: true, url };
}

export function validateLogoUrl(raw: string): UrlCheck {
  return validateHttpUrl(raw);
}

export function sanitizeDisplayText(raw: string, max = MAX_NAME_LENGTH): string {
  return stripControlChars(raw).trim().slice(0, max);
}

export function sanitizeGroup(raw: string): string {
  return sanitizeDisplayText(raw, MAX_GROUP_LENGTH);
}

/** fnv1a-32 — id estável e determinístico a partir de url+índice. */
export function makeChannelId(index: number, url: string): string {
  let h = 0x811c9dc5;
  const s = `${url}\n`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `c${(h >>> 0).toString(16)}_${index.toString(36)}`;
}

export function makeManualId(seq: number): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}_${seq.toString(36)}`;
  return `m_${rnd}`;
}
