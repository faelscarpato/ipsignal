import { validateHttpUrl } from "@/lib/iptv/validate";

export interface ForwardedStreamHeaders {
  userAgent?: string;
  referer?: string;
}

/**
 * Extrai cabeçalhos seguros configurados em diretivas #EXTVLCOPT do canal.
 * Puro (compatível com navegador e Node).
 */
export function extractDirectiveHeaders(directives?: readonly string[]): ForwardedStreamHeaders {
  const out: ForwardedStreamHeaders = {};
  if (!directives || directives.length === 0) return out;
  for (const raw of directives) {
    const line = raw.trim();
    if (!line.toUpperCase().startsWith("#EXTVLCOPT:")) continue;
    const body = line.slice(11).trim();
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim().toLowerCase();
    const val = body
      .slice(eq + 1)
      .replace(/[\r\n\0]/g, "")
      .trim()
      .slice(0, 256);
    if (!val) continue;
    if (key === "http-user-agent") {
      out.userAgent = val;
    } else if (key === "http-referrer" || key === "http-referer") {
      const check = validateHttpUrl(val);
      if (check.ok) out.referer = check.url.toString();
    }
  }
  return out;
}
