import { describe, expect, it } from "vitest";
import { LIMITS, parseM3U, scanExtinf } from "./parse";

const BOM = String.fromCharCode(0xfeff);

describe("scanExtinf", () => {
  it("extrai duração, atributos e nome com vírgula DENTRO de valor entre aspas", () => {
    const s = scanExtinf(
      '-1 tvg-id="a.b" tvg-logo="https://x.test/a,b.png" group-title="News, Int",Canal, Legal',
    );
    expect(s.duration).toBe("-1");
    expect(s.attrs["tvg-logo"]).toBe("https://x.test/a,b.png");
    expect(s.attrs["group-title"]).toBe("News, Int");
    expect(s.name).toBe("Canal, Legal");
    expect(s.malformed).toBe(false);
  });

  it("marca atributo sem aspas como malformado mas resgata o nome", () => {
    const s = scanExtinf("-1 tvg-id=abc group-title=\"X\",Nome do Canal");
    expect(s.malformed).toBe(true);
    expect(s.name).toBe("Nome do Canal");
  });
});

describe("parseM3U — playlists válidas", () => {
  it("parseia um canal com metadados completos", () => {
    const text = [
      "#EXTM3U",
      '#EXTINF:-1 tvg-id="bbc.uk" tvg-name="BBC One" tvg-logo="https://l.test/b.png" group-title="UK",BBC One HD',
      "https://s.test/live/bbc.m3u8",
    ].join("\n");
    const r = parseM3U(text);
    expect(r.ok).toBe(true);
    expect(r.channels).toHaveLength(1);
    const ch = r.channels[0];
    expect(ch.name).toBe("BBC One HD");
    expect(ch.tvgId).toBe("bbc.uk");
    expect(ch.tvgName).toBe("BBC One");
    expect(ch.tvgLogo).toBe("https://l.test/b.png");
    expect(ch.group).toBe("UK");
    expect(ch.url).toBe("https://s.test/live/bbc.m3u8");
    expect(ch.deleted).toBe(false);
    expect(ch.disabled).toBe(false);
    expect(ch.manual).toBe(false);
    expect(ch.id).toBeTruthy();
  });

  it("preserva atributos desconhecidos e diretivas #EXTVLCOPT/#KODIPROP", () => {
    const text = [
      "#EXTM3U",
      '#EXTINF:-1 tvg-id="x" catchup="flussonic" tvg-language="Português" group-title="Filmes",Cine X',
      "#EXTVLCOPT:http-user-agent=Mozilla/5.0",
      "#KODIPROP:inputstream.adaptive.license_type=clearkey",
      "http://s.test:80/x/index.m3u8",
    ].join("\n");
    const r = parseM3U(text);
    expect(r.ok).toBe(true);
    expect(r.channels[0].attrs["catchup"]).toBe("flussonic");
    expect(r.channels[0].attrs["tvg-language"]).toBe("Português");
    expect(r.channels[0].directives).toContain("#EXTVLCOPT:http-user-agent=Mozilla/5.0");
    expect(r.channels[0].directives.some((d) => d.startsWith("#KODIPROP:"))).toBe(true);
  });

  it("múltiplos canais mantêm ordem e ids únicos", () => {
    const n = 50;
    const text =
      "#EXTM3U\n" +
      Array.from(
        { length: n },
        (_, i) => `#EXTINF:-1 group-title="G${i % 3}",Canal ${i}\nhttp://h.test/${i}.m3u8`,
      ).join("\n");
    const r = parseM3U(text);
    expect(r.ok).toBe(true);
    expect(r.channels).toHaveLength(n);
    expect(new Set(r.channels.map((c) => c.id)).size).toBe(n);
    expect(r.channels.map((c) => c.index)).toEqual([...Array(n).keys()]);
  });

  it("captura atributos do cabeçalho (#EXTM3U url-tvg)", () => {
    const r = parseM3U(
      '#EXTM3U url-tvg="https://epg.test/guide.xml" x-tvg-url="https://epg2.test/g.xml"\n#EXTINF:-1,A\nhttp://h.test/a.m3u8',
    );
    expect(r.headerAttrs["url-tvg"]).toBe("https://epg.test/guide.xml");
    expect(r.headerAttrs["x-tvg-url"]).toBe("https://epg2.test/g.xml");
  });

  it("#EXTGRP sobrescreve group-title do canal", () => {
    const r = parseM3U(
      '#EXTM3U\n#EXTINF:-1 group-title="Errado",A\n#EXTGRP:Certo\nhttp://h.test/a.m3u8',
    );
    expect(r.channels[0].group).toBe("Certo");
  });
});

describe("parseM3U — entradas problemáticas", () => {
  it("arquivo vazio → erro fatal de importação", () => {
    const r = parseM3U("");
    expect(r.ok).toBe(false);
    expect(r.fatal).toContain("M3U");
  });

  it("somente espaços/linhas em branco → erro fatal", () => {
    expect(parseM3U("   \n \n\t \n").ok).toBe(false);
  });

  it("BOM UTF-8 no início não quebra o parsing", () => {
    const r = parseM3U(`${BOM}#EXTM3U\n#EXTINF:-1,A\nhttp://h.test/a.m3u8`);
    expect(r.ok).toBe(true);
    expect(r.channels).toHaveLength(1);
  });

  it("quebras CRLF e CR são normalizadas", () => {
    const r = parseM3U("#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://h.test/a.m3u8\r#EXTINF:-1,B\rhttp://h.test/b.m3u8");
    expect(r.ok).toBe(true);
    expect(r.channels).toHaveLength(2);
  });

  it("caracteres especiais e acentos nos nomes são preservados", () => {
    const r = parseM3U(
      '#EXTM3U\n#EXTINF:-1 group-title="Música & Sátira — 東京",Canal Ç ñ 漢字 ★\nhttp://h.test/a.m3u8',
    );
    expect(r.channels[0].name).toBe("Canal Ç ñ 漢字 ★");
    expect(r.channels[0].group).toBe("Música & Sátira — 東京");
  });

  it("URL inválida é descartada com erro por linha, sem afetar vizinhos válidos", () => {
    const r = parseM3U(
      [
        "#EXTM3U",
        "#EXTINF:-1,Bom 1",
        "http://h.test/ok.m3u8",
        "#EXTINF:-1,Quebrado",
        "notaurl://??",
        "#EXTINF:-1,Bom 2",
        "http://h.test/ok2.m3u8",
      ].join("\n"),
    );
    expect(r.ok).toBe(true);
    expect(r.channels).toHaveLength(2);
    expect(r.channels.map((c) => c.name)).toEqual(["Bom 1", "Bom 2"]);
    expect(r.issues.some((i) => i.severity === "error" && i.line === 5)).toBe(true);
  });

  it("esquemas proibidos (ftp, file, javascript) são rejeitados por entrada", () => {
    const r = parseM3U(
      [
        "#EXTM3U",
        "#EXTINF:-1,FTP",
        "ftp://h.test/a.m3u8",
        "#EXTINF:-1,Local",
        "file:///etc/passwd",
        "#EXTINF:-1,XSS",
        "javascript:alert(1)",
      ].join("\n"),
    );
    expect(r.ok).toBe(false);
    expect(r.channels).toHaveLength(0);
    expect(r.issues.filter((i) => i.severity === "error").length).toBe(3);
    expect(r.issues[0].message).toMatch(/não é permitido|inválida/i);
  });

  it("#EXTINF sem URL subsequente vira aviso de órfão", () => {
    const r = parseM3U("#EXTM3U\n#EXTINF:-1,Órfão\n#EXTINF:-1,Ok\nhttp://h.test/a.m3u8");
    expect(r.ok).toBe(true);
    expect(r.channels).toHaveLength(1);
    expect(r.issues.some((i) => i.message.includes("sem URL"))).toBe(true);
  });

  it("URL solta sem #EXTINF cria canal com nome derivado + aviso", () => {
    const r = parseM3U("#EXTM3U\nhttp://h.test/live/canal-x.m3u8");
    expect(r.ok).toBe(true);
    expect(r.channels[0].name).toBe("canal-x");
    expect(r.issues.some((i) => i.message.includes("sem #EXTINF"))).toBe(true);
  });

  it("sem cabeçalho #EXTM3U mas com #EXTINF: parsing tolerante com aviso", () => {
    const r = parseM3U('#EXTINF:-1 group-title="G",A\nhttp://h.test/a.m3u8');
    expect(r.ok).toBe(true);
    expect(r.issues[0].message).toContain("#EXTM3U");
  });

  it("conteúdo totalmente estranho (HTML) é rejeitado", () => {
    const r = parseM3U("<!doctype html><html><body>nada</body></html>");
    expect(r.ok).toBe(false);
    expect(r.fatal).toBeTruthy();
  });
});

describe("parseM3U — limites e entradas grandes", () => {
  it("rejeita conteúdo acima do limite de bytes configurado", () => {
    const big = "#EXTM3U\n" + "x".repeat(2048);
    const r = parseM3U(big, { maxTextBytes: 1024 });
    expect(r.ok).toBe(false);
    expect(r.fatal).toMatch(/limite/i);
  });

  it("trunca playlist que excede o número máximo de canais", () => {
    const over = LIMITS.maxEntries + 25;
    let text = "#EXTM3U\n";
    for (let i = 0; i < over; i++) text += `#EXTINF:-1,C${i}\nhttp://h.test/${i}.m3u8\n`;
    const r = parseM3U(text);
    expect(r.channels).toHaveLength(LIMITS.maxEntries);
    expect(r.truncated).toBe(true);
    expect(r.issues.some((i) => i.severity === "error" && i.message.includes("Limite"))).toBe(true);
  }, 30000);

  it("nome com tentativa de XSS permanece texto literal (sem execução)", () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const r = parseM3U(`#EXTM3U\n#EXTINF:-1 tvg-name="${payload}",${payload}\nhttp://h.test/a.m3u8`);
    expect(r.ok).toBe(true);
    // nada é removido: o perigo seria interpretar como HTML; a UI só usa texto
    expect(r.channels[0].name).toBe(payload);
    expect(r.channels[0].tvgName).toBe(payload);
  });
});
