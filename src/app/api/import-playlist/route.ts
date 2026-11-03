/**
 * POST /api/import-playlist — busca de playlist PELO SERVIDOR (opt-in).
 *
 * Só é chamado quando o usuário autoriza explicitamente após o navegador
 * ser bloqueado por CORS. Não é um proxy de vídeo: baixa apenas o texto
 * da playlist, com proteção SSRF (src/lib/ssrf), limites de tempo e tamanho,
 * e nunca registra segredos em log.
 */

import { NextResponse } from "next/server";
import { LIMITS } from "@/lib/m3u/parse";
import { redactText, redactUrl } from "@/lib/iptv/redact";
import { ssrfFetchPlaylist } from "@/lib/ssrf/fetch";
import { validateTargetUrl } from "@/lib/ssrf/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function contentLooksLikePlaylist(text: string): boolean {
  const head = text.slice(0, 64 * 1024);
  return head.includes("#EXTM3U") || head.includes("#EXTINF");
}

export async function POST(req: Request) {
  let url: string;
  try {
    const body = (await req.json()) as { url?: unknown };
    if (typeof body.url !== "string" || body.url.length > 2048 || !body.url.trim()) {
      return NextResponse.json(
        { ok: false, kind: "network", message: "URL ausente ou inválida." },
        { status: 400 },
      );
    }
    url = body.url;
  } catch {
    return NextResponse.json(
      { ok: false, kind: "network", message: "Corpo da requisição inválido." },
      { status: 400 },
    );
  }

  const verdict = validateTargetUrl(url);
  if (!verdict.ok) {
    return NextResponse.json(
      {
        ok: false,
        kind: verdict.reason.includes("http/https") ? "network" : "blocked_private",
        message: redactText(verdict.reason),
      },
      { status: 422 },
    );
  }

  const res = await ssrfFetchPlaylist(url, {
    timeoutMs: 15000,
    maxBytes: Math.min(LIMITS.maxTextBytes, 10 * 1024 * 1024),
  });

  if (!res.ok) {
    return NextResponse.json(
      { ok: false, kind: res.kind, message: redactText(res.message) },
      { status: res.kind === "blocked_private" ? 422 : 502 },
    );
  }

  if (!contentLooksLikePlaylist(res.body)) {
    return NextResponse.json(
      {
        ok: false,
        kind: "invalid_content",
        message: `O conteúdo de ${redactUrl(url)} não é uma playlist M3U (#EXTM3U/#EXTINF ausentes).`,
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ok: true,
    content: res.body,
    bytes: res.bytes,
    redirects: res.redirects,
    from: res.finalUrlRedacted,
  });
}
