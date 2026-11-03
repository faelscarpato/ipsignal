/**
 * Modelo de canal e resultados compartilhado entre parser, store, tester e UI.
 * Todo texto que veio da playlist é tratado como entrada NÃO confiável:
 * nunca renderizar via innerHTML; sempre como texto (React escapa por padrão).
 */
export interface Channel {
  /** Id estável derivado do conteúdo (fnv1a). Prefixo "m_" para canais manuais. */
  id: string;
  /** Posição original na playlist (para ordenação e exportação estável). */
  index: number;
  name: string;
  url: string;
  tvgId: string | null;
  tvgName: string | null;
  tvgLogo: string | null;
  group: string | null;
  duration: string | null;
  /** Atributos #EXTINF desconhecidos, preservados para exportação. */
  attrs: Record<string, string>;
  /** Diretivas extras seguras associadas ao canal (#EXTVLCOPT, #KODIPROP, #EXTGRP). */
  directives: string[];
  disabled: boolean;
  deleted: boolean;
  /** true quando adicionado manualmente pelo usuário (não existe na origem). */
  manual: boolean;
}

export type TestState =
  | "untested"
  | "queued"
  | "testing"
  | "playing"
  | "reachable_unconfirmed"
  | "import_error"
  | "network_error"
  | "timeout"
  | "blocked_cors"
  | "auth_failed"
  | "manifest_invalid"
  | "codec_unsupported"
  | "unavailable"
  | "undetermined";

export interface TestResult {
  state: TestState;
  /** Mensagem em linguagem simples, já redigida sem segredos/URLs completas. */
  detail: string;
  /** Próximo passo útil em linguagem simples. */
  nextStep?: string;
  checkedAt: number;
  durationMs: number;
  /** true quando o teste utilizou o relay de mídia integrado. */
  viaRelay?: boolean;
}

export type ResultsMap = Record<string, TestResult>;
