/**
 * /api/stream-relay — Relay de mídia integrado ao aplicativo.
 *
 * - POST: autoriza URLs/origens configuradas pelo usuário na sessão atual e
 *   devolve token de sessão + URL assinada com HMAC para reprodução/teste.
 * - GET / HEAD: encaminha manifestos HLS (com reescrita completa de referências)
 *   e streams/segmentos de mídia de forma incremental (ReadableStream),
 *   repassando Range/206 Partial Content, validando SSRF/DNS/redirects e
 *   cancelando conexões upstream assim que o cliente desconecta.
 */

import { NextResponse } from "next/server";
import { classifyRelayErrorKind } from "@/lib/iptv/classify";
import { redactText, redactUrl } from "@/lib/iptv/redact";
import { validateHttpUrl } from "@/lib/iptv/validate";
import {
  authorizeRelaySources,
  buildSignedRelayPath,
  extractDirectiveHeaders,
  RELAY_COOKIE_NAME,
  verifyRelayAccess,
  verifySameOriginRequest,
  type ForwardedStreamHeaders,
} from "@/lib/relay/auth";
import { openRelayStream } from "@/lib/relay/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const sameOrigin = verifySameOriginRequest(req);
  if (!sameOrigin.ok) {
    return NextResponse.json(
      { ok: false, kind: "auth_failed", state: "auth_failed", message: sameOrigin.reason },
      { status: 403, headers: { "X-Relay-Error-Kind": "auth_failed" } },
    );
  }

  let body: { urls?: unknown; url?: unknown; directives?: unknown };
  try {
    body = (await req.json()) as { urls?: unknown; url?: unknown; directives?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, kind: "import_error", state: "import_error", message: "Corpo JSON inválido." },
      { status: 400, headers: { "X-Relay-Error-Kind": "import_error" } },
    );
  }

  const urls: string[] = [];
  if (typeof body.url === "string" && body.url.trim()) {
    urls.push(body.url.trim());
  }
  if (Array.isArray(body.urls)) {
    for (const u of body.urls.slice(0, 20000)) {
      if (typeof u === "string" && u.trim()) urls.push(u.trim());
    }
  }

  const directives = Array.isArray(body.directives)
    ? body.directives.filter((d): d is string => typeof d === "string").slice(0, 25)
    : undefined;

  const auth = authorizeRelaySources(urls);
  let relayUrl: string | undefined;

  if (typeof body.url === "string" && body.url.trim()) {
    const check = validateHttpUrl(body.url.trim());
    if (!check.ok) {
      return NextResponse.json(
        {
          ok: false,
          kind: "import_error",
          state: "import_error",
          message: redactText(check.reason),
        },
        { status: 422, headers: { "X-Relay-Error-Kind": "import_error" } },
      );
    }
    const headers = extractDirectiveHeaders(directives);
    relayUrl = buildSignedRelayPath(check.url.toString(), { headers });
  }

  const res = NextResponse.json({
    ok: true,
    token: auth.token,
    expiresAt: auth.expiresAt,
    authorizedCount: auth.authorizedCount,
    relayUrl,
  });

  res.cookies.set(RELAY_COOKIE_NAME, auth.token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/api/stream-relay",
    maxAge: 6 * 60 * 60,
  });

  return res;
}

async function handleStreamRequest(req: Request, method: "GET" | "HEAD"): Promise<Response> {
  const reqUrl = new URL(req.url);
  const targetUrl = reqUrl.searchParams.get("url")?.trim() ?? "";
  const probe = reqUrl.searchParams.get("probe") === "1";

  if (!targetUrl || targetUrl.length > 2048) {
    return NextResponse.json(
      {
        ok: false,
        kind: "import_error",
        state: "import_error",
        message: "URL de destino ausente ou inválida.",
      },
      {
        status: 400,
        headers: {
          "X-Relay-Error-Kind": "import_error",
          "X-Relay-Error-State": "import_error",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const access = verifyRelayAccess(req, targetUrl);
  if (!access.ok) {
    return NextResponse.json(
      {
        ok: false,
        kind: "auth_failed",
        state: "auth_failed",
        message: access.reason,
      },
      {
        status: 403,
        headers: {
          "X-Relay-Error-Kind": "auth_failed",
          "X-Relay-Error-State": "auth_failed",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const forwardedHeaders: ForwardedStreamHeaders = {};
  const ua = reqUrl.searchParams.get("ua");
  const ref = reqUrl.searchParams.get("ref");
  if (ua) forwardedHeaders.userAgent = ua.replace(/[\r\n\0]/g, "").slice(0, 256);
  if (ref && validateHttpUrl(ref).ok) forwardedHeaders.referer = ref;

  const result = await openRelayStream(targetUrl, {
    method,
    range: req.headers.get("range"),
    ifRange: req.headers.get("if-range"),
    headers: forwardedHeaders,
    probeOnly: probe,
    signal: req.signal,
  });

  if (!result.ok) {
    const state = classifyRelayErrorKind(result.kind) ?? "undetermined";
    return NextResponse.json(
      {
        ok: false,
        kind: result.kind,
        state,
        status: result.status,
        message: redactText(result.message),
      },
      {
        status: result.status,
        headers: {
          "X-Relay-Error-Kind": result.kind,
          "X-Relay-Error-State": state,
          "Cache-Control": "no-store",
        },
      },
    );
  }

  if (result.mode === "probe") {
    return NextResponse.json(
      {
        ok: true,
        status: result.status,
        contentType: result.contentType,
        isHls: result.isHls,
        finalUrl: redactUrl(result.finalUrl),
        redirects: result.redirects,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "X-Relay-Mode": "probe",
        },
      },
    );
  }

  if (result.mode === "manifest") {
    return new Response(result.manifest, {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "no-store",
        "X-Relay-Mode": "manifest",
      },
    });
  }

  const responseHeaders = new Headers({
    "Content-Type": result.contentType,
    "Cache-Control": "no-store",
    "X-Relay-Mode": "stream",
  });
  if (result.contentLength) responseHeaders.set("Content-Length", result.contentLength);
  if (result.contentRange) responseHeaders.set("Content-Range", result.contentRange);
  if (result.acceptRanges) responseHeaders.set("Accept-Ranges", result.acceptRanges);

  return new Response(result.stream, {
    status: result.status,
    headers: responseHeaders,
  });
}

export async function GET(req: Request) {
  return handleStreamRequest(req, "GET");
}

export async function HEAD(req: Request) {
  return handleStreamRequest(req, "HEAD");
}
