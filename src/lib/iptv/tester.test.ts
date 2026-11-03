import { describe, expect, it } from "vitest";
import { detectBrowserMediaCapabilities, inspectStreamFormat } from "./capabilities";
import { testChannelPlayback } from "./tester";
import { extractDirectiveHeaders } from "@/lib/relay/directives";

describe("testChannelPlayback — validação de URL, formatos e ambiente", () => {
  it("retorna import_error para URL vazia ou protocolo proibido", async () => {
    const r1 = await testChannelPlayback("");
    expect(r1.state).toBe("import_error");
    expect(r1.nextStep).toBeTruthy();

    const r2 = await testChannelPlayback("rtmp://servidor.exemplo/live/canal");
    expect(r2.state).toBe("import_error");
  });

  it("inspectStreamFormat distingue HLS, vídeo, áudio e contêiner não suportado", () => {
    expect(inspectStreamFormat("https://cdn.example.com/live/master.m3u8").kind).toBe("hls");
    expect(inspectStreamFormat("https://cdn.example.com/vod/filme.mp4").kind).toBe("video");
    expect(inspectStreamFormat("https://cdn.example.com/radio/stream.aac").kind).toBe("audio");
    const bad = inspectStreamFormat("https://cdn.example.com/vod/filme.avi");
    expect(bad.kind).toBe("unsupported_container");
    expect(bad.reasonIfUnsupported).toContain("FFmpeg");
  });

  it("detectBrowserMediaCapabilities retorna estrutura segura fora do navegador", () => {
    const caps = detectBrowserMediaCapabilities();
    expect(caps.mseSupported).toBe(false);
    expect(caps.nativeHlsSupported).toBe(false);
  });

  it("extractDirectiveHeaders extrai User-Agent e Referer válidos de #EXTVLCOPT", () => {
    const headers = extractDirectiveHeaders([
      "#EXTVLCOPT:http-user-agent=VLC/3.0.20 LibVLC/3.0.20",
      "#EXTVLCOPT:http-referrer=https://portal.exemplo.com/player",
      "#EXTVLCOPT:http-referrer=javascript:alert(1)",
    ]);
    expect(headers.userAgent).toBe("VLC/3.0.20 LibVLC/3.0.20");
    expect(headers.referer).toBe("https://portal.exemplo.com/player");
  });
});
