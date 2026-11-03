/**
 * Store de edição da playlist — 100% puro/testável.
 *
 * A playlist importada (`original`) é IMUTÁVEL. Todas as mudanças viram uma
 * cópia de trabalho (`channels`) versionada por uma pilha de snapshots
 * (desfazer/refazer). Remoções são suaves (flag `deleted`) para permitir
 * desfazer; "Restaurar original" volta a cópia de trabalho à origem.
 */

import type { Channel } from "@/lib/iptv/types";
import {
  MAX_GROUP_LENGTH,
  MAX_NAME_LENGTH,
  makeManualId,
  sanitizeDisplayText,
  sanitizeGroup,
  validateHttpUrl,
  validateLogoUrl,
} from "@/lib/iptv/validate";

export interface PlaylistDoc {
  sourceName: string;
  sourceKind: "file" | "url" | "paste" | "server";
  /** URL original quando importada remotamente (usada para revalidação/atualização segura). */
  sourceUrl?: string;
  importedAt: number;
  headerAttrs: Record<string, string>;
  /** Origem imutável — nunca alterada por edições. */
  original: Channel[];
  /** Cópia de trabalho (edições). Contém também canais com deleted=true. */
  channels: Channel[];
}

export function createDoc(
  sourceName: string,
  sourceKind: PlaylistDoc["sourceKind"],
  channels: Channel[],
  headerAttrs: Record<string, string>,
  sourceUrl?: string,
): PlaylistDoc {
  return {
    sourceName,
    sourceKind,
    ...(sourceUrl ? { sourceUrl } : {}),
    importedAt: Date.now(),
    headerAttrs,
    original: channels.map((c) => ({ ...c, attrs: { ...c.attrs }, directives: [...c.directives] })),
    channels,
  };
}

export type EditAction =
  | { type: "rename"; id: string; name: string }
  | { type: "setLogo"; id: string; logo: string }
  | { type: "setGroup"; ids: string[]; group: string }
  | { type: "updateChannel"; id: string; name: string; logo: string; group: string }
  | { type: "setDisabled"; ids: string[]; disabled: boolean }
  | { type: "remove"; ids: string[] }
  | { type: "restoreDeleted"; ids: string[] }
  | { type: "addChannel"; name: string; url: string; group: string }
  | { type: "restoreOriginal" };

export interface EditOutcome {
  ok: boolean;
  doc: PlaylistDoc;
  label: string;
  error?: string;
}

function mapChannels(
  doc: PlaylistDoc,
  ids: ReadonlySet<string>,
  fn: (c: Channel) => Channel,
): Channel[] {
  return doc.channels.map((c) => (ids.has(c.id) ? fn(c) : c));
}

export function applyEdit(doc: PlaylistDoc, action: EditAction): EditOutcome {
  switch (action.type) {
    case "rename": {
      const name = sanitizeDisplayText(action.name, MAX_NAME_LENGTH);
      if (!name) return { ok: false, doc, label: "", error: "O nome não pode ficar vazio." };
      const exists = doc.channels.some((c) => c.id === action.id && !c.deleted);
      if (!exists) return { ok: false, doc, label: "", error: "Canal não encontrado." };
      return {
        ok: true,
        doc: { ...doc, channels: mapChannels(doc, new Set([action.id]), (c) => ({ ...c, name })) },
        label: `Renomear para “${name}”`,
      };
    }
    case "setLogo": {
      const logo = action.logo.trim();
      if (logo && !validateLogoUrl(logo).ok)
        return { ok: false, doc, label: "", error: "URL de logo inválida — use http(s) ou deixe vazio." };
      return {
        ok: true,
        doc: {
          ...doc,
          channels: mapChannels(doc, new Set([action.id]), (c) => ({ ...c, tvgLogo: logo || null })),
        },
        label: "Alterar logo",
      };
    }
    case "setGroup": {
      const group = action.group.trim()
        ? sanitizeGroup(action.group).slice(0, MAX_GROUP_LENGTH)
        : "";
      const ids = new Set(action.ids);
      let moved = 0;
      const channels = doc.channels.map((c) => {
        if (!ids.has(c.id)) return c;
        moved++;
        return { ...c, group: group || null };
      });
      if (moved === 0) return { ok: false, doc, label: "", error: "Nenhum canal afetado." };
      return {
        ok: true,
        doc: { ...doc, channels },
        label: group ? `Mover ${moved} para “${group}”` : `Remover grupo de ${moved}`,
      };
    }
    case "updateChannel": {
      const name = sanitizeDisplayText(action.name, MAX_NAME_LENGTH);
      if (!name) return { ok: false, doc, label: "", error: "O nome não pode ficar vazio." };
      const logo = action.logo.trim();
      if (logo && !validateLogoUrl(logo).ok)
        return { ok: false, doc, label: "", error: "URL de logo inválida — use http(s) ou deixe vazio." };
      const group = action.group.trim() ? sanitizeGroup(action.group) : null;
      const exists = doc.channels.some((c) => c.id === action.id && !c.deleted);
      if (!exists) return { ok: false, doc, label: "", error: "Canal não encontrado." };
      return {
        ok: true,
        doc: {
          ...doc,
          channels: mapChannels(doc, new Set([action.id]), (c) => ({
            ...c,
            name,
            tvgLogo: logo || null,
            group,
          })),
        },
        label: `Editar “${name}”`,
      };
    }
    case "setDisabled": {
      const ids = new Set(action.ids);
      let changed = 0;
      const channels = doc.channels.map((c) => {
        if (!ids.has(c.id) || c.deleted || c.disabled === action.disabled) return c;
        changed++;
        return { ...c, disabled: action.disabled };
      });
      if (changed === 0)
        return { ok: false, doc, label: "", error: "Nenhum canal precisava de alteração." };
      return {
        ok: true,
        doc: { ...doc, channels },
        label: action.disabled ? `Desativar ${changed}` : `Reativar ${changed}`,
      };
    }
    case "remove": {
      const ids = new Set(action.ids);
      let removed = 0;
      const channels = doc.channels.map((c) => {
        if (!ids.has(c.id) || c.deleted) return c;
        removed++;
        return { ...c, deleted: true };
      });
      if (removed === 0)
        return { ok: false, doc, label: "", error: "Nenhum canal para remover." };
      return {
        ok: true,
        doc: { ...doc, channels },
        label: `Remover ${removed}`,
      };
    }
    case "restoreDeleted": {
      const ids = new Set(action.ids);
      const channels = doc.channels.map((c) =>
        ids.has(c.id) && c.deleted ? { ...c, deleted: false } : c,
      );
      return { ok: true, doc: { ...doc, channels }, label: "Restaurar removidos" };
    }
    case "addChannel": {
      const name = sanitizeDisplayText(action.name, MAX_NAME_LENGTH);
      if (!name) return { ok: false, doc, label: "", error: "Informe um nome para o canal." };
      const check = validateHttpUrl(action.url);
      if (!check.ok)
        return { ok: false, doc, label: "", error: `URL inválida: ${check.reason}.` };
      const group = action.group.trim() ? sanitizeGroup(action.group) : null;
      const channel: Channel = {
        id: makeManualId(doc.channels.length),
        index: doc.channels.length
          ? Math.max(...doc.channels.map((c) => c.index)) + 1
          : 0,
        name,
        url: check.url.toString(),
        tvgId: null,
        tvgName: null,
        tvgLogo: null,
        group,
        duration: "-1",
        attrs: {},
        directives: [],
        disabled: false,
        deleted: false,
        manual: true,
      };
      return {
        ok: true,
        doc: { ...doc, channels: [...doc.channels, channel] },
        label: `Adicionar “${name}”`,
      };
    }
    case "restoreOriginal": {
      return {
        ok: true,
        doc: {
          ...doc,
          channels: doc.original.map((c) => ({
            ...c,
            attrs: { ...c.attrs },
            directives: [...c.directives],
          })),
        },
        label: "Restaurar versão original",
      };
    }
  }
}

/* ------------------------- histórico desfazer/refazer ------------------------- */

export interface HistoryEntry {
  label: string;
  channels: Channel[];
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const EMPTY_HISTORY: History = { past: [], future: [] };
export const HISTORY_LIMIT = 50;

export function pushHistory(h: History, entry: HistoryEntry): History {
  const past = [...h.past, entry];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, future: [] };
}

export function undo(doc: PlaylistDoc, h: History): { doc: PlaylistDoc; history: History; label: string } | null {
  const prev = h.past[h.past.length - 1];
  if (!prev) return null;
  return {
    doc: { ...doc, channels: prev.channels },
    history: {
      past: h.past.slice(0, -1),
      future: [...h.future, { label: prev.label, channels: doc.channels }],
    },
    label: prev.label,
  };
}

export function redo(doc: PlaylistDoc, h: History): { doc: PlaylistDoc; history: History; label: string } | null {
  const next = h.future[h.future.length - 1];
  if (!next) return null;
  return {
    doc: { ...doc, channels: next.channels },
    history: {
      past: [...h.past, { label: next.label, channels: doc.channels }],
      future: h.future.slice(0, -1),
    },
    label: next.label,
  };
}

/* ------------------------- consultas ------------------------- */

export function listGroups(doc: PlaylistDoc): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of doc.channels) {
    if (c.deleted) continue;
    const g = c.group ?? "Sem grupo";
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export function docStats(doc: PlaylistDoc) {
  let active = 0;
  let disabled = 0;
  let deleted = 0;
  for (const c of doc.channels) {
    if (c.deleted) deleted++;
    else if (c.disabled) disabled++;
    else active++;
  }
  return { total: doc.channels.length - deleted, active, disabled, deleted };
}

/**
 * Atualiza um documento existente com uma nova lista vinda da origem,
 * preservando edições do usuário (renomeações, grupos, desativados, removidos
 * e canais adicionados manualmente) quando a nova lista é válida.
 */
export function mergeUpdatedPlaylist(
  currentDoc: PlaylistDoc,
  freshChannels: Channel[],
  freshHeaderAttrs: Record<string, string>,
  sourceKind?: PlaylistDoc["sourceKind"],
): PlaylistDoc {
  if (freshChannels.length === 0) {
    return currentDoc;
  }

  const prevByUrl = new Map<string, Channel>();
  for (const ch of currentDoc.channels) {
    if (!ch.manual && !prevByUrl.has(ch.url)) {
      prevByUrl.set(ch.url, ch);
    }
  }

  const merged: Channel[] = freshChannels.map((fresh, idx) => {
    const prev = prevByUrl.get(fresh.url);
    if (!prev) return { ...fresh, index: idx };
    return {
      ...fresh,
      id: prev.id,
      index: idx,
      name: prev.name,
      tvgLogo: prev.tvgLogo,
      group: prev.group,
      disabled: prev.disabled,
      deleted: prev.deleted,
    };
  });

  const manualChannels = currentDoc.channels
    .filter((c) => c.manual)
    .map((c, i) => ({ ...c, index: merged.length + i }));

  return {
    ...currentDoc,
    sourceKind: sourceKind ?? currentDoc.sourceKind,
    importedAt: Date.now(),
    headerAttrs: freshHeaderAttrs,
    original: freshChannels.map((c) => ({ ...c, attrs: { ...c.attrs }, directives: [...c.directives] })),
    channels: [...merged, ...manualChannels],
  };
}
