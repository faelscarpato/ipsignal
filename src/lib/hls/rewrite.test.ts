import { describe, expect, it } from "vitest";
import {
  isPlayableHlsManifest,
  looksLikeHlsManifest,
  resolveHlsReference,
  rewriteHlsManifest,
} from "./rewrite";

describe("looksLikeHlsManifest e isPlayableHlsManifest", () => {
  it("reconhece #EXTM3U mesmo com BOM UTF-8 e espaços iniciais", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(looksLikeHlsManifest(`${bom}  #EXTM3U\n#EXTINF:4,\nseg.ts`)).toBe(true);
    expect(looksLikeHlsManifest("<!doctype html><html></html>")).toBe(false);
  });

  it("rejeita manifesto vazio que só tem #EXTM3U sem variantes ou segmentos", () => {
    expect(isPlayableHlsManifest("#EXTM3U\n# comentário apenas\n")).toBe(false);
    expect(
      isPlayableHlsManifest("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p/index.m3u8"),
    ).toBe(true);
    expect(
      isPlayableHlsManifest("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg01.ts"),
    ).toBe(true);
  });
});

describe("resolveHlsReference", () => {
  const base = "https://cdn.example.com/live/ch1/master.m3u8?session=abc";

  it("resolve caminhos relativos, subpastas, ../, raiz e query params", () => {
    expect(resolveHlsReference("720p/prog.m3u8?token=1", base)).toBe(
      "https://cdn.example.com/live/ch1/720p/prog.m3u8?token=1",
    );
    expect(resolveHlsReference("../audio/pt.m3u8", base)).toBe(
      "https://cdn.example.com/live/audio/pt.m3u8",
    );
    expect(resolveHlsReference("/root/seg0.ts", base)).toBe(
      "https://cdn.example.com/root/seg0.ts",
    );
  });

  it("rejeita esquemas inseguros (file, javascript, ftp)", () => {
    expect(resolveHlsReference("file:///etc/passwd", base)).toBeNull();
    expect(resolveHlsReference("javascript:alert(1)", base)).toBeNull();
    expect(resolveHlsReference("ftp://files.example.com/seg.ts", base)).toBeNull();
  });
});

describe("rewriteHlsManifest — Master e Variant Playlists", () => {
  const mockRelay = (url: string, kind: string) =>
    `/api/stream-relay?kind=${kind}&url=${encodeURIComponent(url)}`;

  it("reescreve Master Playlist (variantes, áudio alternativo e I-Frame streams)", () => {
    const master = [
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Português",DEFAULT=YES,URI="audio/pt/prog.m3u8?tok=9"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="aac"',
      "720p/prog.m3u8?tok=9",
      "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080",
      "https://edge2.cdn.example.com/hls/1080p.m3u8",
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=180000,URI="../iframes/index.m3u8"',
    ].join("\n");

    const rewritten = rewriteHlsManifest(
      master,
      "https://origin.example.com/live/main/master.m3u8",
      mockRelay,
    );

    expect(rewritten).toContain(
      `URI="/api/stream-relay?kind=manifest&url=${encodeURIComponent("https://origin.example.com/live/main/audio/pt/prog.m3u8?tok=9")}"`,
    );
    expect(rewritten).toContain(
      `/api/stream-relay?kind=manifest&url=${encodeURIComponent("https://origin.example.com/live/main/720p/prog.m3u8?tok=9")}`,
    );
    expect(rewritten).toContain(
      `/api/stream-relay?kind=manifest&url=${encodeURIComponent("https://edge2.cdn.example.com/hls/1080p.m3u8")}`,
    );
    expect(rewritten).toContain(
      `URI="/api/stream-relay?kind=manifest&url=${encodeURIComponent("https://origin.example.com/live/iframes/index.m3u8")}"`,
    );
  });

  it("reescreve Variant/Media Playlist (segmentos, #EXT-X-MAP, #EXT-X-KEY e preserva data: e #EXT-X-BYTERANGE)", () => {
    const variant = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:6",
      '#EXT-X-KEY:METHOD=AES-128,URI="keys/key1.bin?auth=xyz",IV=0x00000001',
      '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAAAAAAAAAAAAAAAAAAAA=="',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      "#EXTINF:6.000,",
      "#EXT-X-BYTERANGE:150000@720",
      "seg-001.m4s?token=abc",
      "#EXTINF:6.000,",
      "/chunks/seg-002.ts",
      "#EXT-X-ENDLIST",
    ].join("\r\n");

    const rewritten = rewriteHlsManifest(
      variant,
      "https://cdn.example.com/hls/720p/index.m3u8",
      mockRelay,
    );

    expect(rewritten).toContain(
      `URI="/api/stream-relay?kind=key&url=${encodeURIComponent("https://cdn.example.com/hls/720p/keys/key1.bin?auth=xyz")}"`,
    );
    // data: URI permanece intacta
    expect(rewritten).toContain('URI="data:text/plain;base64,AAAAAAAAAAAAAAAAAAAAAA=="');
    expect(rewritten).toContain(
      `URI="/api/stream-relay?kind=map&url=${encodeURIComponent("https://cdn.example.com/hls/720p/init.mp4")}"`,
    );
    expect(rewritten).toContain("#EXT-X-BYTERANGE:150000@720");
    expect(rewritten).toContain(
      `/api/stream-relay?kind=segment&url=${encodeURIComponent("https://cdn.example.com/hls/720p/seg-001.m4s?token=abc")}`,
    );
    expect(rewritten).toContain(
      `/api/stream-relay?kind=segment&url=${encodeURIComponent("https://cdn.example.com/chunks/seg-002.ts")}`,
    );
  });

  it("bloqueia referências com esquema proibido sem quebrar o restante da playlist", () => {
    const variant = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      "#EXTINF:4.0,",
      "file:///etc/passwd",
      "#EXTINF:4.0,",
      "ok-seg.ts",
    ].join("\n");

    const rewritten = rewriteHlsManifest(variant, "https://cdn.example.com/live/index.m3u8", mockRelay);
    expect(rewritten).not.toContain("file:///etc/passwd");
    expect(rewritten).toContain("# [bloqueado pelo relay");
    expect(rewritten).toContain(
      `/api/stream-relay?kind=segment&url=${encodeURIComponent("https://cdn.example.com/live/ok-seg.ts")}`,
    );
  });
});
