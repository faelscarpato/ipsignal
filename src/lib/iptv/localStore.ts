/**
 * Persistência LOCAL (IndexedDB) — as listas, edições e resultados nunca
 * saem do aparelho do usuário. Nada é enviado a serviços de terceiros.
 * Botão "Limpar dados locais" na UI apaga tudo via clearLocalSession().
 */

import type { PlaylistDoc } from "@/lib/playlist/store";
import type { ResultsMap } from "./types";

export interface LocalSession {
  version: 1;
  savedAt: number;
  doc: PlaylistDoc;
  results: ResultsMap;
}

const DB_NAME = "sinal-playlist-studio";
const DB_VERSION = 1;
const STORE = "kv";
const SESSION_KEY = "session-v1";

export function localStoreAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB indisponível"));
  });
}

export async function saveLocalSession(session: LocalSession): Promise<boolean> {
  if (!localStoreAvailable()) return false;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(session, SESSION_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false; // cota cheia / modo privado — a sessão só não persiste
  }
}

export async function loadLocalSession(): Promise<LocalSession | null> {
  if (!localStoreAvailable()) return null;
  try {
    const db = await openDb();
    const value = await new Promise<LocalSession | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(SESSION_KEY);
      req.onsuccess = () => resolve((req.result as LocalSession | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!value || value.version !== 1 || !value.doc) return null;
    return value;
  } catch {
    return null;
  }
}

export async function clearLocalSession(): Promise<void> {
  if (!localStoreAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(SESSION_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* noop */
  }
}
