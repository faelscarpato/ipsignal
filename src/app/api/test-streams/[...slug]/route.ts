/**
 * /api/test-streams/[...slug] — Fixtures locais determinísticas para testes
 * de fluxo completo no navegador (Claramente diferenciadas de streams reais).
 *
 * Rotas disponíveis:
 * - /api/test-streams/live-tone.wav          → Áudio PCM válido com suporte a Range/206 (reproduz em <video>)
 * - /api/test-streams/unconfirmed/index.m3u8 → Manifesto HLS válido cujo segmento demora (reachable_unconfirmed)
 * - /api/test-streams/invalid/index.m3u8     → Responde 200 com HTML em vez de M3U8 (manifest_invalid)
 * - /api/test-streams/auth-denied/index.m3u8 → Responde 403 Forbidden (auth_failed)
 * - /api/test-streams/offline/index.m3u8     → Responde 404 Not Found (unavailable)
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function generateSineWavBuffer(durationSec = 2, sampleRate = 8000, freqHz = 440): Buffer {
  const numSamples = durationSec * sampleRate;
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format = 1
  buf.writeUInt16LE(1, 22); // Mono = 1
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  buf.writeUInt16LE(2, 32); // Block align
  buf.writeUInt16LE(16, 34); // Bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 12000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

const WAV_FIXTURE = generateSineWavBuffer(3, 8000, 440);

export async function GET(
  req: Request,
  context: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await context.params;
  const path = slug.join("/");

  if (path === "live-tone.wav") {
    const range = req.headers.get("range");
    if (range && range.startsWith("bytes=")) {
      const [startStr, endStr] = range.slice(6).split("-");
      const start = Math.max(0, parseInt(startStr || "0", 10) || 0);
      const end = endStr
        ? Math.min(WAV_FIXTURE.length - 1, parseInt(endStr, 10))
        : WAV_FIXTURE.length - 1;
      const slice = WAV_FIXTURE.subarray(start, end + 1);
      return new Response(new Uint8Array(slice), {
        status: 206,
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": String(slice.length),
          "Content-Range": `bytes ${start}-${end}/${WAV_FIXTURE.length}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
    }
    return new Response(new Uint8Array(WAV_FIXTURE), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(WAV_FIXTURE.length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }

  if (path === "unconfirmed/index.m3u8") {
    const manifest = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXTINF:4.0,",
      "stalled-segment.ts",
    ].join("\n");
    return new Response(manifest, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (path === "unconfirmed/stalled-segment.ts") {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 25000);
      req.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
    return new Response("Timeout segment", { status: 504 });
  }

  if (path === "invalid/index.m3u8") {
    return new Response("<!doctype html><html><body>Página HTML inválida</body></html>", {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (path === "auth-denied/index.m3u8") {
    return NextResponse.json(
      { ok: false, message: "Token de acesso inválido ou expirado (fixture local)." },
      { status: 403 },
    );
  }

  return NextResponse.json(
    { ok: false, message: "Stream fixture não encontrado (404)." },
    { status: 404 },
  );
}
