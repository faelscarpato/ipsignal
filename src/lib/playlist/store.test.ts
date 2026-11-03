import { describe, expect, it } from "vitest";
import { buildM3U } from "@/lib/m3u/export";
import type { Channel } from "@/lib/iptv/types";
import {
  applyEdit,
  createDoc,
  docStats,
  EMPTY_HISTORY,
  listGroups,
  mergeUpdatedPlaylist,
  pushHistory,
  redo,
  undo,
  type History,
  type PlaylistDoc,
} from "./store";

function ch(partial: Partial<Channel> & { id: string }): Channel {
  return {
    index: 0,
    name: partial.id,
    url: `http://h.test/${partial.id}.m3u8`,
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

function fixtureDoc(): PlaylistDoc {
  return createDoc(
    "teste.m3u",
    "file",
    [
      ch({ id: "a", index: 0, name: "Alpha", group: "Notícias" }),
      ch({ id: "b", index: 1, name: "Beta", group: "Notícias" }),
      ch({ id: "c", index: 2, name: "Gama", group: "Filmes" }),
    ],
    {},
  );
}

describe("edições básicas", () => {
  it("renomear valida nome vazio", () => {
    const doc = fixtureDoc();
    expect(applyEdit(doc, { type: "rename", id: "a", name: "  " }).ok).toBe(false);
    const r = applyEdit(doc, { type: "rename", id: "a", name: "Alpha HD" });
    expect(r.ok).toBe(true);
    expect(r.doc.channels[0].name).toBe("Alpha HD");
    // original permanece imutável
    expect(r.doc.original[0].name).toBe("Alpha");
  });

  it("trocar logo valida http/https e aceita vazio", () => {
    const doc = fixtureDoc();
    expect(applyEdit(doc, { type: "setLogo", id: "a", logo: "javascript:alert(1)" }).ok).toBe(false);
    expect(applyEdit(doc, { type: "setLogo", id: "a", logo: "ftp://x/y.png" }).ok).toBe(false);
    const okR = applyEdit(doc, { type: "setLogo", id: "a", logo: "https://l.test/x.png" });
    expect(okR.ok).toBe(true);
    expect(okR.doc.channels[0].tvgLogo).toBe("https://l.test/x.png");
    const clear = applyEdit(okR.doc, { type: "setLogo", id: "a", logo: "" });
    expect(clear.doc.channels[0].tvgLogo).toBeNull();
  });

  it("mudar/criar grupo e mover canais entre grupos", () => {
    const doc = fixtureDoc();
    const r = applyEdit(doc, { type: "setGroup", ids: ["a", "b"], group: "Novidades" });
    expect(r.ok).toBe(true);
    expect(r.doc.channels.filter((c) => c.group === "Novidades")).toHaveLength(2);
    const groups = listGroups(r.doc);
    expect(groups.map((g) => g.name).sort()).toEqual(["Filmes", "Novidades"]);
    const none = applyEdit(r.doc, { type: "setGroup", ids: ["a"], group: "" });
    expect(none.doc.channels[0].group).toBeNull();
    expect(listGroups(none.doc).some((g) => g.name === "Sem grupo")).toBe(true);
  });

  it("desativar/reativar é simétrico e idempotente", () => {
    const doc = fixtureDoc();
    const off = applyEdit(doc, { type: "setDisabled", ids: ["a"], disabled: true });
    expect(off.ok).toBe(true);
    expect(docStats(off.doc).disabled).toBe(1);
    // segunda vez não muda nada → erro informativo
    expect(applyEdit(off.doc, { type: "setDisabled", ids: ["a"], disabled: true }).ok).toBe(false);
    const on = applyEdit(off.doc, { type: "setDisabled", ids: ["a"], disabled: false });
    expect(docStats(on.doc).disabled).toBe(0);
  });

  it("excluir é suave (deleted=true) e restaurável", () => {
    const doc = fixtureDoc();
    const del = applyEdit(doc, { type: "remove", ids: ["a", "b"] });
    expect(docStats(del.doc).deleted).toBe(2);
    expect(docStats(del.doc).total).toBe(1);
    // exportação nunca inclui excluídos
    const exp = buildM3U(del.doc.channels, {}, { includeDisabled: true });
    expect(exp.exportedCount).toBe(1);
    const und = applyEdit(del.doc, { type: "restoreDeleted", ids: ["a"] });
    expect(docStats(und.doc).deleted).toBe(1);
  });
});

describe("adição manual", () => {
  it("canal manual é criado marcado como manual e sem id de importação", () => {
    const doc = fixtureDoc();
    const r = applyEdit(doc, {
      type: "addChannel",
      name: "Canal Novo",
      url: "https://n.test/live.m3u8",
      group: "Extras",
    });
    expect(r.ok).toBe(true);
    const added = r.doc.channels[r.doc.channels.length - 1];
    expect(added.manual).toBe(true);
    expect(added.id.startsWith("m_")).toBe(true);
    expect(added.group).toBe("Extras");
    // NÃO existe na origem; restaurar original o remove
    const restored = applyEdit(r.doc, { type: "restoreOriginal" });
    expect(restored.doc.channels.some((c) => c.id === added.id)).toBe(false);
  });

  it("adição manual rejeita esquema proibido e URL inválida", () => {
    const doc = fixtureDoc();
    expect(applyEdit(doc, { type: "addChannel", name: "X", url: "rtsp://cam.local/1", group: "" }).ok).toBe(false);
    expect(applyEdit(doc, { type: "addChannel", name: "X", url: "ht tp://x", group: "" }).ok).toBe(false);
    expect(applyEdit(doc, { type: "addChannel", name: "", url: "http://ok.test", group: "" }).ok).toBe(false);
  });
});

describe("histórico desfazer/refazer", () => {
  it("desfazer reverter remoção (excluir com possibilidade de desfazer)", () => {
    const doc = fixtureDoc();
    let history: History = EMPTY_HISTORY;
    const removed = applyEdit(doc, { type: "remove", ids: ["a"] });
    history = pushHistory(history, { label: removed.label, channels: doc.channels });
    expect(docStats(removed.doc).deleted).toBe(1);

    const u = undo(removed.doc, history);
    expect(u).not.toBeNull();
    expect(docStats(u!.doc).deleted).toBe(0);
    expect(u!.label).toContain("Remover");

    const r = redo(u!.doc, u!.history);
    expect(r).not.toBeNull();
    expect(docStats(r!.doc).deleted).toBe(1);
  });

  it("futuro é limpo após nova edição", () => {
    const doc = fixtureDoc();
    let history: History = EMPTY_HISTORY;
    const e1 = applyEdit(doc, { type: "rename", id: "a", name: "A2" });
    history = pushHistory(history, { label: e1.label, channels: doc.channels });
    const u = undo(e1.doc, history)!;
    const e2 = applyEdit(u.doc, { type: "rename", id: "b", name: "B2" });
    const h2 = pushHistory(u.history, { label: e2.label, channels: u.doc.channels });
    expect(h2.future).toHaveLength(0);
    expect(redo(e2.doc, h2)).toBeNull();
  });

  it("restaurar original volta toda a lista à origem e é desfazível", () => {
    const doc = fixtureDoc();
    let history: History = EMPTY_HISTORY;
    const del = applyEdit(doc, { type: "remove", ids: ["a", "b", "c"] });
    history = pushHistory(history, { label: del.label, channels: doc.channels });
    const rest = applyEdit(del.doc, { type: "restoreOriginal" });
    history = pushHistory(history, { label: rest.label, channels: del.doc.channels });
    expect(docStats(rest.doc).total).toBe(3);
    const u = undo(rest.doc, history)!;
    expect(docStats(u.doc).deleted).toBe(3);
  });
});

describe("integração edição → exportação M3U", () => {
  it("exporta com mudanças preservando metadados válidos", () => {
    const doc = fixtureDoc();
    const renamed = applyEdit(doc, { type: "rename", id: "a", name: "Alpha HD" });
    const grouped = applyEdit(renamed.doc, { type: "setGroup", ids: ["a"], group: "Documentários" });
    const disabled = applyEdit(grouped.doc, { type: "setDisabled", ids: ["b"], disabled: true });
    const exp = buildM3U(disabled.doc.channels, {}, { includeDisabled: false });
    expect(exp.exportedCount).toBe(2);
    expect(exp.omittedDisabled).toBe(1);
    expect(exp.content).toContain(",Alpha HD");
    expect(exp.content).toContain('group-title="Documentários"');
    expect(exp.content).not.toContain(",Beta");
    expect(exp.content).toContain(",Gama");
  });

  it("preserva playlist válida e edições do usuário ao atualizar da origem", () => {
    const doc = fixtureDoc();
    const renamed = applyEdit(doc, { type: "rename", id: "a", name: "Alpha Editado" }).doc;
    const disabled = applyEdit(renamed, { type: "setDisabled", ids: ["b"], disabled: true }).doc;

    // Se a atualização trouxer lista vazia, preserva o documento atual intacto
    const unchanged = mergeUpdatedPlaylist(disabled, [], {});
    expect(unchanged).toBe(disabled);

    // Se trouxer canais atualizados + canal novo, preserva as edições em 'a' e 'b'
    const updated = mergeUpdatedPlaylist(
      disabled,
      [
        ch({ id: "new_a", index: 0, name: "Alpha Original", url: "http://h.test/a.m3u8" }),
        ch({ id: "new_b", index: 1, name: "Beta Original", url: "http://h.test/b.m3u8" }),
        ch({ id: "new_d", index: 2, name: "Delta Novo", url: "http://h.test/d.m3u8" }),
      ],
      { "url-tvg": "https://epg.test/novo.xml" },
    );
    expect(updated.channels).toHaveLength(3);
    expect(updated.channels[0].name).toBe("Alpha Editado");
    expect(updated.channels[1].disabled).toBe(true);
    expect(updated.channels[2].name).toBe("Delta Novo");
  });
});
