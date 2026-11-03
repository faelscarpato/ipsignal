import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as relayGET, POST as relayPOST } from "@/app/api/stream-relay/route";
import {
  authorizeRelaySources,
  buildSignedRelayPath,
  clearAuthorizedRelaySources,
  verifyRelayAccess,
} from "./auth";
import { openRelayStream } from "./stream";

let server: http.Server;
let baseUrl = "";
let activeStreamAborted = false;

const SEGMENT_BYTES = Buffer.alloc(128);
SEGMENT_BYTES[0] = 0x47; // MPEG-TS sync byte
for (let i = 1; i < 128; i++) SEGMENT_BYTES[i] = i & 0xff;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");

    if (u.pathname === "/live/master.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(
        [
          "#EXTM3U",
          "#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720",
          "variants/720p.m3u8?token=abc123",
        ].join("\n"),
      );
      return;
    }

    if (u.pathname === "/live/variants/720p.m3u8") {
      if (u.searchParams.get("token") !== "abc123") {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Missing token");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(
        [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          "#EXT-X-TARGETDURATION:4",
          '#EXT-X-MAP:URI="../init.mp4"',
          "#EXTINF:4.0,",
          "../segments/seg01.ts?seq=1",
          "#EXT-X-ENDLIST",
        ].join("\n"),
      );
      return;
    }

    if (u.pathname === "/live/segments/seg01.ts") {
      const range = req.headers["range"];
      if (range && range.startsWith("bytes=")) {
        const [startStr, endStr] = range.slice(6).split("-");
        const start = parseInt(startStr, 10) || 0;
        const end = endStr ? parseInt(endStr, 10) : SEGMENT_BYTES.length - 1;
        const slice = SEGMENT_BYTES.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "video/mp2t",
          "Content-Length": String(slice.length),
          "Content-Range": `bytes ${start}-${end}/${SEGMENT_BYTES.length}`,
          "Accept-Ranges": "bytes",
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Content-Length": String(SEGMENT_BYTES.length),
        "Accept-Ranges": "bytes",
      });
      res.end(SEGMENT_BYTES);
      return;
    }

    if (u.pathname === "/redirect-to-master") {
      res.writeHead(302, { Location: "/live/master.m3u8" });
      res.end();
      return;
    }

    if (u.pathname === "/redirect-to-internal") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }

    if (u.pathname === "/redirect-to-loopback-blocked") {
      res.writeHead(302, { Location: `${baseUrl}/live/master.m3u8?ssrf_block=1` });
      res.end();
      return;
    }

    if (u.pathname === "/slow-timeout") {
      // Não responde dentro do timeout
      const timer = setTimeout(() => {
        res.writeHead(200);
        res.end("tarde demais");
      }, 2000);
      req.on("close", () => clearTimeout(timer));
      return;
    }

    if (u.pathname === "/infinite-stream.ts") {
      activeStreamAborted = false;
      res.writeHead(200, { "Content-Type": "video/mp2t" });
      res.write(SEGMENT_BYTES);
      const interval = setInterval(() => {
        if (!res.writableEnded) res.write(SEGMENT_BYTES);
      }, 30);
      req.on("close", () => {
        activeStreamAborted = true;
        clearInterval(interval);
      });
      return;
    }

    if (u.pathname === "/html-fake.m3u8") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body>Login Required</body></html>");
      return;
    }

    if (u.pathname === "/empty-manifest.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n# sem nenhum segmento\n");
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("openRelayStream — HLS master/variant, URLs relativas, segmentos e Range", () => {
  it("reescreve master → variante → segmento preservando parâmetros e caminhos relativos", async () => {
    const masterRes = await openRelayStream(`${baseUrl}/live/master.m3u8`, {
      _testAllowLoopback: true,
    });
    expect(masterRes.ok).toBe(true);
    if (!masterRes.ok || masterRes.mode !== "manifest") throw new Error("Esperava manifesto");

    // Extrai a URL da variante reescrita
    const variantLine = masterRes.manifest
      .split("\n")
      .find((l) => l.startsWith("/api/stream-relay?"));
    expect(variantLine).toBeTruthy();

    const variantParams = new URL(variantLine!, "http://localhost").searchParams;
    const variantTargetUrl = variantParams.get("url")!;
    expect(variantTargetUrl).toBe(`${baseUrl}/live/variants/720p.m3u8?token=abc123`);
    // A assinatura HMAC gerada na reescrita autoriza o acesso à variante
    expect(variantParams.get("sig")).toBeTruthy();

    // Busca a variante
    const variantRes = await openRelayStream(variantTargetUrl, {
      _testAllowLoopback: true,
    });
    expect(variantRes.ok).toBe(true);
    if (!variantRes.ok || variantRes.mode !== "manifest") throw new Error("Esperava variante");

    // Verifica que #EXT-X-MAP e o segmento relativo (../segments/seg01.ts?seq=1) foram reescritos
    expect(variantRes.manifest).toContain('URI="/api/stream-relay?');
    const segLine = variantRes.manifest
      .split("\n")
      .find((l) => l.startsWith("/api/stream-relay?"));
    expect(segLine).toBeTruthy();
    const segTargetUrl = new URL(segLine!, "http://localhost").searchParams.get("url")!;
    expect(segTargetUrl).toBe(`${baseUrl}/live/segments/seg01.ts?seq=1`);

    // Faz streaming incremental do segmento
    const segRes = await openRelayStream(segTargetUrl, {
      _testAllowLoopback: true,
    });
    expect(segRes.ok).toBe(true);
    if (!segRes.ok || segRes.mode !== "stream") throw new Error("Esperava stream");
    expect(segRes.status).toBe(200);

    const reader = segRes.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const received = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(received.equals(SEGMENT_BYTES)).toBe(true);
  });

  it("suporta requisições parciais (Range → 206 Partial Content + Content-Range)", async () => {
    const res = await openRelayStream(`${baseUrl}/live/segments/seg01.ts`, {
      range: "bytes=10-29",
      _testAllowLoopback: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.mode !== "stream") throw new Error("Esperava stream parcial");
    expect(res.status).toBe(206);
    expect(res.contentRange).toBe(`bytes 10-29/${SEGMENT_BYTES.length}`);
    expect(res.contentLength).toBe("20");

    const reader = res.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const received = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(received.length).toBe(20);
    expect(received.equals(SEGMENT_BYTES.subarray(10, 30))).toBe(true);
  });

  it("segue redirect válido e resolve caminhos relativos contra a URL final redirecionada", async () => {
    const res = await openRelayStream(`${baseUrl}/redirect-to-master`, {
      _testAllowLoopback: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.mode !== "manifest") throw new Error("Esperava manifesto");
    expect(res.redirects).toBe(1);
    expect(res.finalUrl).toBe(`${baseUrl}/live/master.m3u8`);
    expect(res.manifest).toContain(
      encodeURIComponent(`${baseUrl}/live/variants/720p.m3u8?token=abc123`),
    );
  });

  it("bloqueia redirect para destino interno/metadados de nuvem (proteção SSRF)", async () => {
    const res1 = await openRelayStream(`${baseUrl}/redirect-to-internal`, {
      _testAllowLoopback: true,
    });
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.kind).toBe("blocked_private");
      expect(res1.status).toBe(422);
    }

    const res2 = await openRelayStream(`${baseUrl}/redirect-to-loopback-blocked`, {
      _testAllowLoopback: true,
    });
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.kind).toBe("blocked_private");
    }
  });

  it("classifica timeout corretamente quando a origem demora além do limite", async () => {
    const res = await openRelayStream(`${baseUrl}/slow-timeout`, {
      timeoutMs: 120,
      _testAllowLoopback: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("timeout");
      expect(res.status).toBe(504);
    }
  });

  it("cancela imediatamente a conexão upstream quando o cliente aborta o stream", async () => {
    const ctl = new AbortController();
    const res = await openRelayStream(`${baseUrl}/infinite-stream.ts`, {
      signal: ctl.signal,
      _testAllowLoopback: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.mode !== "stream") throw new Error("Esperava stream");

    const reader = res.stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    // Simula fechamento do player ou cancelamento do teste
    ctl.abort();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 60));
    expect(activeStreamAborted).toBe(true);
  });

  it("classifica HTML ou manifesto vazio como manifest_invalid", async () => {
    const htmlRes = await openRelayStream(`${baseUrl}/html-fake.m3u8`, {
      _testAllowLoopback: true,
    });
    expect(htmlRes.ok).toBe(false);
    if (!htmlRes.ok) expect(htmlRes.kind).toBe("manifest_invalid");

    const emptyRes = await openRelayStream(`${baseUrl}/empty-manifest.m3u8`, {
      _testAllowLoopback: true,
    });
    expect(emptyRes.ok).toBe(false);
    if (!emptyRes.ok) expect(emptyRes.kind).toBe("manifest_invalid");
  });
});

describe("/api/stream-relay — proteção contra proxy público e bloqueio de destinos internos", () => {
  it("rejeita chamadas sem token/assinatura (não é um proxy público aberto)", async () => {
    clearAuthorizedRelaySources();
    const req = new Request(
      "http://localhost:3000/api/stream-relay?url=https%3A%2F%2Fexample.com%2Flive.m3u8",
    );
    const res = await relayGET(req);
    expect(res.status).toBe(403);
    expect(res.headers.get("x-relay-error-kind")).toBe("auth_failed");
  });

  it("rejeita chamadas cross-site (Sec-Fetch-Site: cross-site ou Origin externo)", async () => {
    const signedPath = buildSignedRelayPath("https://example.com/live.m3u8");
    const crossSiteReq = new Request(`http://localhost:3000${signedPath}`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    const res1 = await relayGET(crossSiteReq);
    expect(res1.status).toBe(403);

    const badOriginReq = new Request(`http://localhost:3000${signedPath}`, {
      headers: { origin: "https://attacker.evil.example" },
    });
    const res2 = await relayGET(badOriginReq);
    expect(res2.status).toBe(403);
  });

  it("autoriza fontes configuradas via POST e bloqueia destinos internos (loopback/RFC1918/IMDS)", async () => {
    const postReq = new Request("http://localhost:3000/api/stream-relay", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000" },
      body: JSON.stringify({
        urls: ["https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"],
      }),
    });
    const postRes = await relayPOST(postReq);
    expect(postRes.status).toBe(200);
    const data = (await postRes.json()) as { ok: boolean; token: string };
    expect(data.ok).toBe(true);
    expect(data.token).toBeTruthy();

    // Fonte autorizada passa na verificação de acesso
    const authorizedReq = new Request(
      `http://localhost:3000/api/stream-relay?url=${encodeURIComponent("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8")}&token=${data.token}`,
    );
    expect(
      verifyRelayAccess(authorizedReq, "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8").ok,
    ).toBe(true);

    // Fonte não autorizada pelo usuário é negada mesmo com token de sessão válido
    const unauthorizedOriginReq = new Request(
      `http://localhost:3000/api/stream-relay?url=${encodeURIComponent("https://unlisted-domain.example.com/stream.m3u8")}&token=${data.token}`,
    );
    expect(
      verifyRelayAccess(unauthorizedOriginReq, "https://unlisted-domain.example.com/stream.m3u8").ok,
    ).toBe(false);

    // Destinos internos (127.0.0.1, localhost, 169.254.169.254, 192.168.1.1, [::1]) são bloqueados pelo SSRF mesmo assinados
    for (const internalUrl of [
      "http://127.0.0.1/admin.m3u8",
      "http://localhost/stream.m3u8",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/playlist.m3u8",
      "http://[::1]/stream.m3u8",
    ]) {
      authorizeRelaySources([internalUrl]);
      const signedInternal = buildSignedRelayPath(internalUrl);
      const internalReq = new Request(`http://localhost:3000${signedInternal}`);
      const internalRes = await relayGET(internalReq);
      expect(internalRes.status).toBe(422);
      expect(internalRes.headers.get("x-relay-error-kind")).toBe("blocked_private");
    }
  });
});
