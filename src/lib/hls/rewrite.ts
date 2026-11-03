/**
 * Tratamento e reescrita de manifestos HLS (M3U8 — RFC 8216):
 * - suporta Master Playlists (#EXT-X-STREAM-INF, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF)
 *   e Media/Variant Playlists (#EXTINF, #EXT-X-KEY, #EXT-X-MAP, #EXT-X-PART, #EXT-X-PRELOAD-HINT);
 * - resolve URLs relativas, subpastas (./, ../), caminhos absolutos (/path) e query params
 *   contra a URL final do manifesto (após redirecionamentos);
 * - reescreve tanto linhas de URI quanto atributos URI="..." dentro de tags #EXT-X-*
 *   para passarem pelo relay de mídia da aplicação;
 * - preserva integralmente byte ranges (#EXT-X-BYTERANGE), metadados de codec,
 *   sequências e chaves data: inline.
 */

export type HlsResourceKind = "manifest" | "segment" | "key" | "map";

export type RelayUrlBuilder = (resolvedUrl: string, kind: HlsResourceKind) => string;

const URI_ATTR_RE = /\bURI="([^"]+)"/g;

/**
 * Verifica se o texto (ou primeiros bytes decodificados) começa com #EXTM3U
 * (ignorando BOM UTF-8 e espaços iniciais).
 */
export function looksLikeHlsManifest(text: string): boolean {
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.trimStart();
  return s.startsWith("#EXTM3U");
}

/**
 * Verifica se um manifesto #EXTM3U é estruturalmente válido para HLS
 * (possui ao menos uma variante #EXT-X-STREAM-INF, #EXT-X-MEDIA, ou segmento #EXTINF / #EXT-X-PART).
 */
export function isPlayableHlsManifest(text: string): boolean {
  if (!looksLikeHlsManifest(text)) return false;
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const lines = s.replace(/\r\n?/g, "\n").split("\n");
  let hasHlsTag = false;
  let hasResourceRef = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const upper = line.toUpperCase();
      if (
        upper.startsWith("#EXT-X-STREAM-INF") ||
        upper.startsWith("#EXTINF") ||
        upper.startsWith("#EXT-X-TARGETDURATION") ||
        upper.startsWith("#EXT-X-MEDIA") ||
        upper.startsWith("#EXT-X-PART")
      ) {
        hasHlsTag = true;
      }
      if (/\bURI="([^"]+)"/i.test(line)) {
        hasResourceRef = true;
      }
    } else {
      hasResourceRef = true;
    }
  }
  return hasHlsTag && hasResourceRef;
}

/**
 * Resolve uma referência (relativa ou absoluta) contra a URL base do manifesto.
 * Retorna null se a URL resultante não for http: ou https:.
 */
export function resolveHlsReference(ref: string, baseUrl: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  // Rejeita esquemas explícitos que não sejam http/https
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

function classifyTagUriKind(upperLine: string): HlsResourceKind {
  if (upperLine.startsWith("#EXT-X-KEY") || upperLine.startsWith("#EXT-X-SESSION-KEY")) {
    return "key";
  }
  if (upperLine.startsWith("#EXT-X-MAP")) {
    return "map";
  }
  if (
    upperLine.startsWith("#EXT-X-MEDIA") ||
    upperLine.startsWith("#EXT-X-I-FRAME-STREAM-INF") ||
    upperLine.startsWith("#EXT-X-RENDITION-REPORT")
  ) {
    return "manifest";
  }
  return "segment";
}

/**
 * Reescreve todas as referências de um manifesto HLS (master ou media/variant)
 * para passarem pelo relay de mídia.
 */
export function rewriteHlsManifest(
  manifestText: string,
  baseUrl: string,
  buildRelayUrl: RelayUrlBuilder,
): string {
  let text = manifestText;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  let expectVariantUri = false;
  const out: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      out.push(rawLine);
      continue;
    }

    if (trimmed.startsWith("#")) {
      const upper = trimmed.toUpperCase();
      if (upper.startsWith("#EXT-X-STREAM-INF")) {
        expectVariantUri = true;
      }

      // Reescreve atributos URI="..." em tags #EXT-X-*
      if (trimmed.includes('URI="')) {
        const attrKind = classifyTagUriKind(upper);
        const rewrittenTag = trimmed.replace(URI_ATTR_RE, (fullMatch, uriValue: string) => {
          const val = uriValue.trim();
          // Chaves inline data: permanecem intactas
          if (/^data:/i.test(val)) return fullMatch;
          const resolved = resolveHlsReference(val, baseUrl);
          if (!resolved) return fullMatch;
          return `URI="${buildRelayUrl(resolved, attrKind)}"`;
        });
        out.push(rewrittenTag);
      } else {
        out.push(trimmed);
      }
      continue;
    }

    // Linha de recurso (variante de master playlist ou segmento de media playlist)
    const kind: HlsResourceKind = expectVariantUri || /\.m3u8?(\?|$)/i.test(trimmed) ? "manifest" : "segment";
    expectVariantUri = false;

    const resolved = resolveHlsReference(trimmed, baseUrl);
    if (!resolved) {
      // Esquema proibido ou inválido: comenta a linha para não acionar requisição insegura
      out.push(`# [bloqueado pelo relay: referência inválida]`);
      continue;
    }

    out.push(buildRelayUrl(resolved, kind));
  }

  return out.join("\n");
}
