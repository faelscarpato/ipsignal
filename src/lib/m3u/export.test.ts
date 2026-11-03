import { describe, expect, it } from "vitest";
import { buildM3U } from "./export";
import type { Channel } from "@/lib/iptv/types";

function ch(partial: Partial<Channel>): Channel {
  return {
    id: partial.id ?? `c_${Math.random().toString(36).slice(2)}`,
    index: partial.index ?? 0,
    name: "Canal",
    url: "http://h.test/a.m3u8",
    tvgId: null,
    tvgName: null,
    tvgLogo: null,
    group: null,
    duration: "-1",
    attrs: {},
    directives: [],
    disabled: false,
    deleted: false,
    manual: false,
    ...partial,
  };
}

describe("buildM3U", () => {
  it("gera M3U válido com metadados preservados e atributos extras", () => {
    const r = buildM3U(
      [
        ch({
          id: "a",
          index: 0,
          name: "BBC One",
          url: "https://s.test/bbc.m3u8",
          tvgId: "bbc.uk",
          tvgName: "BBC One",
          tvgLogo: "https://l.test/b.png",
          group: "UK",
          attrs: { "tvg-language": "English", catchup: "flussonic" },
          directives: ["#EXTVLCOPT:http-referrer=https://s.test/"],
        }),
      ],
      { "url-tvg": "https://epg.test/g.xml" },
      { includeDisabled: false },
    );
    expect(r.ok).toBe(true);
    expect(r.exportedCount).toBe(1);
    expect(r.content.startsWith('#EXTM3U url-tvg="https://epg.test/g.xml"')).toBe(true);
    expect(r.content).toContain('tvg-id="bbc.uk"');
    expect(r.content).toContain('tvg-name="BBC One"');
    expect(r.content).toContain('tvg-logo="https://l.test/b.png"');
    expect(r.content).toContain('group-title="UK"');
    expect(r.content).toContain('tvg-language="English"');
    expect(r.content).toContain('catchup="flussonic"');
    expect(r.content).toContain(",BBC One");
    expect(r.content).toContain("#EXTVLCOPT:http-referrer=https://s.test/");
    expect(r.content).toContain("https://s.test/bbc.m3u8");
  });

  it("omite desativados por padrão e nunca exporta excluídos; contagens corretas", () => {
    const channels = [
      ch({ id: "ok", index: 0 }),
      ch({ id: "off", index: 1, disabled: true }),
      ch({ id: "del", index: 2, deleted: true }),
    ];
    const r = buildM3U(channels, {}, { includeDisabled: false });
    expect(r.exportedCount).toBe(1);
    expect(r.omittedDisabled).toBe(1);
    expect(r.omittedDeleted).toBe(1);
    const r2 = buildM3U(channels, {}, { includeDisabled: true });
    expect(r2.exportedCount).toBe(2);
    expect(r2.omittedDisabled).toBe(0);
    expect(r2.omittedDeleted).toBe(1);
  });

  it("todos desativados + opção de não incluir → erro explicado", () => {
    const r = buildM3U([ch({ disabled: true })], {}, { includeDisabled: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("higieniza aspas e quebras de linha em atributos e nomes (não quebra o M3U)", () => {
    const r = buildM3U(
      [
        ch({
          name: 'Meu "Canal"\nInjection',
          group: 'Grupo "X"',
          tvgId: 'id"mal',
        }),
      ],
      {},
      { includeDisabled: false },
    );
    expect(r.ok).toBe(true);
    expect(r.content).not.toContain('group-title="Grupo "X""');
    expect(r.content).toContain('group-title="Grupo \'X\'"');
    expect(r.content).toContain('tvg-id="id\'mal"');
    // nome em uma única linha, quebra de linha neutralizada para espaço
    const extinfLine = r.content.split("\n").find((l) => l.startsWith("#EXTINF"))!;
    expect(extinfLine).toContain(',Meu "Canal" Injection');
  });

  it("mantém payload de XSS como TEXTO literal (sem interpretação HTML no M3U)", () => {
    const payload = '"><script>alert("x")</script>';
    const r = buildM3U([ch({ name: payload })], {}, { includeDisabled: false });
    // nada é executado: o M3U é texto puro; a UI também renderiza como texto
    expect(r.content).toContain(payload);
    const extinfLine = r.content.split("\n").find((l) => l.startsWith("#EXTINF"))!;
    expect(extinfLine).toContain(',"><script>alert("x")</script>');
  });

  it("descarta url-tvg do cabeçalho quando não é http(s) (anti javascript:)", () => {
    const r = buildM3U([ch({})], { "url-tvg": "javascript:alert(1)" }, { includeDisabled: false });
    expect(r.content.split("\n")[0]).toBe("#EXTM3U");
  });

  it("mantém a ordem original (index) mesmo com edições", () => {
    const channels = [ch({ id: "b", index: 5, name: "B" }), ch({ id: "a", index: 1, name: "A" })];
    const r = buildM3U(channels, {}, { includeDisabled: false });
    const extinfLines = r.content.split("\n").filter((l) => l.startsWith("#EXTINF"));
    expect(extinfLines[0]).toContain(",A");
    expect(extinfLines[1]).toContain(",B");
  });
});
