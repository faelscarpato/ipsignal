/**
 * Exporta a lista de trabalho como M3U (#EXTM3U + #EXTINF por canal).
 * - Metadados válidos são preservados (tvg-*, group-title, attrs desconhecidos,
 *   diretivas seguras #EXTVLCOPT/#KODIPROP).
 * - Canais excluídos NUNCA são exportados; desativados são omitidos por
 *   padrão (opção explícita para incluir).
 * - Valores são higienizados: aspas e caracteres de controle removidos para
 *   não quebrar o formato; textos permanecem literais (sem execução).
 */

import type { Channel } from "@/lib/iptv/types";
import { stripControlChars, validateHttpUrl } from "@/lib/iptv/validate";

export interface ExportResult {
  ok: boolean;
  content: string;
  exportedCount: number;
  omittedDisabled: number;
  omittedDeleted: number;
  reason?: string;
}

const ATTR_KEY_RE = /^[a-z0-9][a-z0-9-]{0,40}$/i;

function cleanAttrValue(v: string): string {
  return stripControlChars(v).replace(/"/g, "'").trim().slice(0, 1024);
}

function cleanLineText(v: string): string {
  // 1) quebra de linha vira espaço ANTES de stripControlChars removê-las,
  // 2) demais controles removidos — nomes mantêm aspas (válidas após a vírgula).
  return stripControlChars(v.replace(/[\r\n]+/g, " ")).trim();
}

export function sanitizeAttrValue(v: string): string {
  return cleanAttrValue(v);
}

export function buildM3U(
  channels: Channel[],
  headerAttrs: Record<string, string>,
  opts: { includeDisabled: boolean },
): ExportResult {
  const exportable = channels.filter((c) => !c.deleted);
  const omittedDeleted = channels.length - exportable.length;
  const included = opts.includeDisabled ? exportable : exportable.filter((c) => !c.disabled);
  const omittedDisabled = exportable.length - included.length;

  if (included.length === 0) {
    return {
      ok: false,
      content: "",
      exportedCount: 0,
      omittedDisabled,
      omittedDeleted,
      reason: "Nenhum canal disponível para exportar com as opções atuais.",
    };
  }

  const lines: string[] = [];
  const headerParts: string[] = [];
  for (const key of ["url-tvg", "x-tvg-url", "catchup", "catchup-days"] as const) {
    const v = headerAttrs[key];
    if (!v) continue;
    const cleaned = cleanAttrValue(v);
    if (key.endsWith("url") || key === "url-tvg" || key === "x-tvg-url") {
      if (!validateHttpUrl(cleaned).ok) continue; // só URLs http/https válidas no cabeçalho
    }
    if (ATTR_KEY_RE.test(key)) headerParts.push(`${key}="${cleaned}"`);
  }
  lines.push(headerParts.length ? `#EXTM3U ${headerParts.join(" ")}` : "#EXTM3U");

  for (const ch of [...included].sort((a, b) => a.index - b.index)) {
    const attrs: string[] = [];
    const push = (k: string, v: string | null) => {
      if (v && ATTR_KEY_RE.test(k)) attrs.push(`${k}="${cleanAttrValue(v)}"`);
    };
    push("tvg-id", ch.tvgId);
    push("tvg-name", ch.tvgName);
    push("tvg-logo", ch.tvgLogo);
    push("group-title", ch.group);
    for (const [k, v] of Object.entries(ch.attrs)) push(k, v);
    const duration = ch.duration ?? "-1";
    const name = cleanLineText(ch.name) || cleanLineText(ch.tvgName ?? "") || "Canal sem nome";
    lines.push(`#EXTINF:${duration}${attrs.length ? " " + attrs.join(" ") : ""},${name}`);
    for (const d of ch.directives) {
      const clean = cleanLineText(d);
      if (clean.startsWith("#EXTVLCOPT:") || clean.startsWith("#KODIPROP:")) lines.push(clean);
    }
    lines.push(ch.url);
  }

  return {
    ok: true,
    content: lines.join("\n") + "\n",
    exportedCount: included.length,
    omittedDisabled,
    omittedDeleted,
  };
}
