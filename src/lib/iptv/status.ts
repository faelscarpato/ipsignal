import type { TestState } from "./types";

export interface StatusMeta {
  label: string;
  description: string;
  /** Próximo passo útil em linguagem simples. */
  nextStep: string;
  /** tom visual usado nos badges (cor + ícone, nunca só cor). */
  tone: "ok" | "info" | "warn" | "danger" | "muted" | "accent";
}

/** Tempo após o qual um resultado de stream ao vivo é considerado antigo e requer revalidação (5 min). */
export const STALE_RESULT_MS = 5 * 60 * 1000;

export function isResultStale(checkedAt: number, now = Date.now()): boolean {
  if (!checkedAt || checkedAt <= 0) return false;
  return now - checkedAt >= STALE_RESULT_MS;
}

export const STATUS_META: Record<TestState, StatusMeta> = {
  untested: {
    label: "Ainda não testado",
    description: "Este canal ainda não passou por um teste de reprodução.",
    nextStep: "Clique em “Testar” na linha do canal ou em “Testar todos” para verificar a transmissão.",
    tone: "muted",
  },
  queued: {
    label: "Na fila",
    description: "Aguardando a vez para ser testado (concorrência limitada para não sobrecarregar a origem).",
    nextStep: "Aguarde a conclusão da fila atual ou cancele o lote se desejar interromper.",
    tone: "muted",
  },
  testing: {
    label: "Testando…",
    description: "Carregando manifesto e trecho inicial da transmissão pelo relay e player.",
    nextStep: "Aguarde alguns segundos enquanto o buffer de mídia é verificado.",
    tone: "accent",
  },
  playing: {
    label: "Reproduzindo",
    description:
      "O player carregou e decodificou dados reais de mídia neste navegador. Evidência confirmada de playback.",
    nextStep: "Clique no ícone de reprodução (▶) para assistir ao canal ou mantenha-o ativo para exportação.",
    tone: "ok",
  },
  reachable_unconfirmed: {
    label: "Acessível, sem playback confirmado",
    description:
      "O endpoint respondeu e o manifesto foi lido, mas nenhum quadro/áudio entrou no buffer do player a tempo.",
    nextStep: "Teste novamente o canal ou abra no player para verificar se a transmissão apenas demorou a iniciar.",
    tone: "info",
  },
  import_error: {
    label: "Erro de importação",
    description:
      "A URL ou configuração deste canal na playlist é inválida ou usa protocolo não suportado.",
    nextStep: "Edite ou remova o canal da lista, ou reimporte uma versão corrigida da playlist.",
    tone: "danger",
  },
  network_error: {
    label: "Falha de rede",
    description:
      "Não foi possível conectar ao servidor de origem (falha de DNS, conexão recusada ou queda de rede).",
    nextStep: "Verifique sua conexão e se o domínio do servidor ainda existe; se persistir, desative o canal.",
    tone: "danger",
  },
  timeout: {
    label: "Timeout (tempo esgotado)",
    description:
      "O servidor demorou demais para entregar o manifesto ou os segmentos iniciais de vídeo.",
    nextStep: "Use “Testar novamente” em instantes; servidores IPTV sobrecarregados costumam oscilar.",
    tone: "warn",
  },
  blocked_cors: {
    label: "Bloqueado por CORS",
    description:
      "O navegador bloqueou a leitura direta por política CORS da origem.",
    nextStep: "Ative o relay de mídia integrado para encaminhar o stream pelo aplicativo sem bloqueio de CORS.",
    tone: "warn",
  },
  auth_failed: {
    label: "Acesso negado",
    description:
      "O servidor recusou o acesso (HTTP 401/403, token expirado, geobloqueio ou destino interno bloqueado).",
    nextStep: "Atualize a playlist com um token válido junto ao provedor ou desative o canal.",
    tone: "warn",
  },
  manifest_invalid: {
    label: "Manifesto inválido",
    description:
      "O endereço respondeu, mas o conteúdo não é um manifesto HLS válido (ex.: página HTML, lista vazia ou link quebrado).",
    nextStep: "Confira se a URL aponta para um stream real (.m3u8/.ts/.mp4) ou remova o canal.",
    tone: "danger",
  },
  codec_unsupported: {
    label: "Formato/codec incompatível",
    description:
      "A transmissão usa codec (ex.: HEVC/AC-3 sem suporte local), contêiner bruto ou DRM incompatível com este navegador.",
    nextStep: "Teste em um navegador com suporte de hardware a HEVC (ex.: Safari/Edge com extensão) ou mantenha na lista apenas se for usar em player externo.",
    tone: "danger",
  },
  unavailable: {
    label: "Origem indisponível",
    description:
      "O servidor de origem retornou erro (HTTP 404/410/5xx) — canal fora do ar ou removido.",
    nextStep: "Revalide mais tarde com “Repetir falhas” ou desative/exclua o canal antes de exportar.",
    tone: "danger",
  },
  undetermined: {
    label: "Erro desconhecido",
    description:
      "O teste terminou sem evidência suficiente para determinar a causa exata da falha.",
    nextStep: "Tente testar o canal individualmente novamente ou inspecione a reprodução no player.",
    tone: "muted",
  },
};

/** Estados considerados "falha" para a opção "repetir apenas falhas". */
export const FAILURE_STATES: ReadonlySet<TestState> = new Set([
  "import_error",
  "network_error",
  "timeout",
  "blocked_cors",
  "auth_failed",
  "manifest_invalid",
  "codec_unsupported",
  "unavailable",
  "undetermined",
]);

export const RESULT_STATES: readonly TestState[] = [
  "playing",
  "reachable_unconfirmed",
  "import_error",
  "network_error",
  "timeout",
  "blocked_cors",
  "auth_failed",
  "manifest_invalid",
  "codec_unsupported",
  "unavailable",
  "undetermined",
];

export function isFailureState(state: TestState): boolean {
  return FAILURE_STATES.has(state);
}

export function isTransientState(state: TestState): boolean {
  return state === "queued" || state === "testing";
}
