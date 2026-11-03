/**
 * Parser M3U/M3U8 (#EXTM3U/#EXTINF) tolerante a falhas.
 *
 * Referências: estrutura #EXTINF com atributos entre aspas seguidos de vírgula
 * e nome (tvg-id, tvg-name, tvg-logo, group-title...). Ver resumo final para links.
 *
 * Princípios:
 * - nunca descartar entradas válidas por causa de vizinhas malformadas;
 * - registrar um problema por linha, sem interromper o parsing;
 * - preservar atributos desconhecidos para a exportação;
 * - limites rígidos de tamanho, entradas e tempo (defesa contra abuso);
 * - URLs aceitas apenas em http/https; demais esquemas viram problema por entrada.
 */

import type { Channel } from "@/lib/iptv/types";
import {
  makeChannelId,
  sanitizeDisplayText,
  sanitizeGroup,
  stripControlChars,
  validateHttpUrl,
} from "@/lib/iptv/validate";

export const LIMITS = {
  /** Tamanho máximo do CONTEÚDO já decodificado (15 MB de texto). */
  maxTextBytes: 15 * 1024 * 1024,
  /** Texto colado manualmente é mais restrito: 3 MB. */
  maxPasteBytes: 3 * 1024 * 1024,
  maxEntries: 20000,
  maxLineLength: 16384,
  maxAttrValueLength: 2048,
  maxDirectivesPerEntry: 25,
  maxParseMs: 8000,
} as const;

/** Diretivas consideradas seguras para preservar e reexportar (só texto M3U). */
const SAFE_DIRECTIVE_PREFIXES = ["#EXTVLCOPT:", "#KODIPROP:"] as const;

export interface ParseIssue {
  line: number;
  severity: "error" | "warning";
  message: string;
  /** Início da linha (sanitizado e truncado) para contexto na UI. */
  snippet?: string;
}

export interface ParseResult {
  ok: boolean;
  /** Erros graves que inviabilizam a importação (ex.: conteúdo não-M3U). */
  fatal: string | null;
  channels: Channel[];
  issues: ParseIssue[];
  /** Atributos do cabeçalho #EXTM3U (url-tvg, x-tvg-url e desconhecidos). */
  headerAttrs: Record<string, string>;
  truncated: boolean;
  stats: {
    totalLines: number;
    entries: number;
    droppedEntries: number;
    parseMs: number;
  };
}

interface PendingEntry {
  line: number;
  duration: string | null;
  name: string;
  attrs: Record<string, string>;
  directives: string[];
  groupOverride: string | null;
}

const KNOWN_ATTRS = new Set([
  "tvg-id",
  "tvg-name",
  "tvg-logo",
  "tvg-chno",
  "group-title",
]);

function snippetOf(line: string): string {
  return stripControlChars(line).slice(0, 80) + (line.length > 80 ? "…" : "");
}

interface ExtinfScan {
  duration: string | null;
  attrs: Record<string, string>;
  name: string;
  malformed: boolean;
}

/**
 * Varre `#EXTINF:<dur> <attrs>,<nome>` sem regex ingênua: atributos entre
 * aspas podem conter vírgulas, então a vírgula do nome só é buscada depois
 * que todos os pares chave="valor" foram consumidos.
 */
export function scanExtinf(body: string): ExtinfScan {
  let i = 0;
  const n = body.length;
  let malformed = false;

  // duração
  while (i < n && body[i] === " ") i++;
  let duration: string | null = null;
  const durMatch = /^-?\d+(?:\.\d+)?/.exec(body.slice(i, i + 16));
  if (durMatch) {
    duration = durMatch[0];
    i += durMatch[0].length;
  }

  const attrs: Record<string, string> = {};
  let name = "";

  // pares chave="valor"
  for (;;) {
    while (i < n && (body[i] === " " || body[i] === "\t")) i++;
    if (i >= n) break;
    if (body[i] === ",") {
      name = body.slice(i + 1);
      break;
    }
    const keyMatch = /^[\w-]+/.exec(body.slice(i, i + 64));
    if (!keyMatch) {
      // não é atributo: trata o resto a partir da próxima vírgula como nome
      const comma = body.indexOf(",", i);
      if (comma === -1) {
        name = body.slice(i);
      } else {
        name = body.slice(comma + 1);
      }
      malformed = true;
      break;
    }
    const key = keyMatch[0].toLowerCase();
    i += keyMatch[0].length;
    if (body[i] !== "=" || body[i + 1] !== '"') {
      // chave sem valor entre aspas: pula até espaço/ vírgula
      const comma = body.indexOf(",", i);
      malformed = true;
      if (comma === -1) {
        name = body.slice(i);
        i = n;
      } else {
        name = body.slice(comma + 1);
        i = n;
      }
      break;
    }
    i += 2; // pula ="
    const end = body.indexOf('"', i);
    if (end === -1) {
      attrs[key] = body.slice(i, i + LIMITS.maxAttrValueLength);
      malformed = true;
      i = n;
      break;
    }
    attrs[key] = body.slice(i, Math.min(end, i + LIMITS.maxAttrValueLength));
    i = end + 1;
  }

  return { duration, attrs, name, malformed };
}

function deriveNameFromUrl(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? url.hostname;
  const cleaned = last.replace(/\.(m3u8?|ts|mp4|mp3|aac|ogg)$/i, "");
  return sanitizeDisplayText(decodeURIComponentSafe(cleaned) || url.hostname, 120);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseM3U(input: string, opts?: { maxTextBytes?: number }): ParseResult {
  const startedAt = Date.now();
  const issues: ParseIssue[] = [];
  const channels: Channel[] = [];
  const headerAttrs: Record<string, string> = {};
  let dropped = 0;
  let truncated = false;

  const byteCap = opts?.maxTextBytes ?? LIMITS.maxTextBytes;
  if (input.length > byteCap) {
    return {
      ok: false,
      fatal: `Conteúdo excede o limite de ${Math.round(byteCap / 1024 / 1024)} MB.`,
      channels: [],
      issues: [],
      headerAttrs: {},
      truncated: false,
      stats: { totalLines: 0, entries: 0, droppedEntries: 0, parseMs: 0 },
    };
  }

  // BOM (U+FEFF) e normalização de quebras de linha (CRLF/CR → LF)
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  let sawHeader = false;
  let sawAnyTag = false;
  let pending: PendingEntry | null = null;
  let entryIndex = 0;

  const flushOrphan = (lineNo: number) => {
    if (pending) {
      issues.push({
        line: pending.line,
        severity: "warning",
        message: `Linha #EXTINF na linha ${pending.line} ficou sem URL correspondente e foi ignorada.`,
        snippet: snippetOf(lines[pending.line - 1] ?? ""),
      });
      dropped++;
    }
    pending = null;
    void lineNo;
  };

  for (let li = 0; li < lines.length; li++) {
    const lineNo = li + 1;
    if (lineNo % 2000 === 0 && Date.now() - startedAt > LIMITS.maxParseMs) {
      truncated = true;
      issues.push({
        line: lineNo,
        severity: "error",
        message: "Tempo máximo de parsing excedido — arquivo processado parcialmente.",
      });
      break;
    }

    let line = lines[li];
    if (line.length > LIMITS.maxLineLength) {
      issues.push({
        line: lineNo,
        severity: "warning",
        message: `Linha muito longa (>${LIMITS.maxLineLength} caracteres), truncada.`,
      });
      line = line.slice(0, LIMITS.maxLineLength);
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("#")) {
      const upper = trimmed.toUpperCase();

      if (upper.startsWith("#EXTM3U")) {
        sawHeader = true;
        sawAnyTag = true;
        // atributos de cabeçalho (url-tvg / x-tvg-url / desconhecidos)
        const scanned = scanExtinf(trimmed.slice(7));
        for (const [k, v] of Object.entries(scanned.attrs)) {
          headerAttrs[k] = stripControlChars(v).slice(0, LIMITS.maxAttrValueLength);
        }
        continue;
      }

      if (upper.startsWith("#EXTINF:")) {
        sawAnyTag = true;
        if (pending) flushOrphan(lineNo);
        const scanned = scanExtinf(trimmed.slice(8));
        const attrs: Record<string, string> = {};
        let name = sanitizeDisplayText(scanned.name);
        pending = {
          line: lineNo,
          duration: scanned.duration,
          name,
          attrs,
          directives: [],
          groupOverride: null,
        };
        for (const [k, v] of Object.entries(scanned.attrs)) {
          pending.attrs[k] = stripControlChars(v).slice(0, LIMITS.maxAttrValueLength);
        }
        if (scanned.malformed) {
          issues.push({
            line: lineNo,
            severity: "warning",
            message: "Linha #EXTINF com atributos malformados — recuperado o possível.",
            snippet: snippetOf(trimmed),
          });
        }
        continue;
      }

      if (upper.startsWith("#EXTGRP:")) {
        sawAnyTag = true;
        const g = sanitizeGroup(trimmed.slice(8));
        if (pending) pending.groupOverride = g;
        else {
          issues.push({
            line: lineNo,
            severity: "warning",
            message: "#EXTGRP sem #EXTINF anterior — ignorado.",
            snippet: snippetOf(trimmed),
          });
        }
        continue;
      }

      if (SAFE_DIRECTIVE_PREFIXES.some((p) => upper.startsWith(p))) {
        sawAnyTag = true;
        if (pending && pending.directives.length < LIMITS.maxDirectivesPerEntry) {
          pending.directives.push(stripControlChars(trimmed).slice(0, 512));
        } else if (!pending) {
          issues.push({
            line: lineNo,
            severity: "warning",
            message: "Diretiva extra sem canal associado — ignorada.",
            snippet: snippetOf(trimmed),
          });
        }
        continue;
      }

      // outras diretivas (#EXT-X-..., comentários) são ignoradas com segurança
      continue;
    }

    // linha não-comentário: candidata a URL
    if (entryIndex >= LIMITS.maxEntries) {
      truncated = true;
      issues.push({
        line: lineNo,
        severity: "error",
        message: `Limite de ${LIMITS.maxEntries} canais atingido — entradas restantes ignoradas.`,
      });
      break;
    }

    const check = validateHttpUrl(trimmed);
    if (!check.ok) {
      issues.push({
        line: lineNo,
        severity: "error",
        message: `${pending ? "Canal descartado" : "Linha ignorada"}: ${check.reason}.`,
        snippet: snippetOf(trimmed),
      });
      if (pending) dropped++;
      pending = null;
      continue;
    }

    const attrs = pending?.attrs ?? {};
    const groupRaw = pending?.groupOverride ?? attrs["group-title"] ?? null;
    const tvgName = attrs["tvg-name"] ? sanitizeDisplayText(attrs["tvg-name"], 300) : null;
    let name = pending?.name || tvgName || deriveNameFromUrl(check.url);

    if (!pending) {
      issues.push({
        line: lineNo,
        severity: "warning",
        message: "URL sem #EXTINF anterior — canal criado com nome derivado do endereço.",
        snippet: snippetOf(trimmed),
      });
    }

    const extras: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (!KNOWN_ATTRS.has(k)) extras[k] = v;
    }

    channels.push({
      id: makeChannelId(entryIndex, trimmed),
      index: entryIndex,
      name,
      url: trimmed,
      tvgId: attrs["tvg-id"] ? sanitizeDisplayText(attrs["tvg-id"], 200) : null,
      tvgName,
      tvgLogo: attrs["tvg-logo"] ? stripControlChars(attrs["tvg-logo"]).trim() : null,
      group: groupRaw ? sanitizeGroup(groupRaw) : null,
      duration: pending?.duration ?? null,
      attrs: extras,
      directives: pending?.directives ?? [],
      disabled: false,
      deleted: false,
      manual: false,
    });
    entryIndex++;
    pending = null;
    name = "";
  }

  flushOrphan(lines.length);

  const parseMs = Date.now() - startedAt;

  if (!sawHeader && !sawAnyTag && channels.length === 0) {
    return {
      ok: false,
      fatal:
        "O conteúdo não parece uma playlist M3U: cabeçalho #EXTM3U ausente e nenhum canal encontrado.",
      channels: [],
      issues,
      headerAttrs: {},
      truncated,
      stats: { totalLines: lines.length, entries: 0, droppedEntries: dropped, parseMs },
    };
  }

  if (!sawHeader && sawAnyTag) {
    issues.unshift({
      line: 1,
      severity: "warning",
      message: "Cabeçalho #EXTM3U ausente — parsing tolerante aplicado.",
    });
  }

  if (channels.length === 0) {
    return {
      ok: false,
      fatal: "Nenhum canal válido encontrado. Verifique os problemas por linha abaixo.",
      channels: [],
      issues,
      headerAttrs,
      truncated,
      stats: { totalLines: lines.length, entries: 0, droppedEntries: dropped, parseMs },
    };
  }

  return {
    ok: true,
    fatal: null,
    channels,
    issues,
    headerAttrs,
    truncated,
    stats: {
      totalLines: lines.length,
      entries: channels.length,
      droppedEntries: dropped,
      parseMs,
    },
  };
}

/** Decodifica um arquivo respeitando limite de bytes antes de parsear. */
export async function readPlaylistFile(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(
      `Arquivo excede o limite de ${Math.round(maxBytes / 1024 / 1024)} MB (recebido: ${(file.size / 1024 / 1024).toFixed(1)} MB).`,
    );
  }
  const buf = await file.arrayBuffer();
  // UTF-8 com tolerância, o M3U de IPTV quase sempre é UTF-8
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}
