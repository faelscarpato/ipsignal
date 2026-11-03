/**
 * Redação de segredos: senhas, tokens e credenciais nunca devem aparecer em
 * mensagens de erro, logs ou na interface. Estas funções são aplicadas antes
 * de exibir ou registrar qualquer URL vinda da playlist.
 */

const SECRET_PARAM_NAMES = new Set([
  "token",
  "password",
  "passwd",
  "pwd",
  "pass",
  "secret",
  "key",
  "auth",
  "sig",
  "signature",
  "access_token",
  "session",
  "sid",
  "apikey",
  "api_key",
]);

/**
 * Retorna a URL sem credenciais (user:pass@) e com parâmetros sensíveis
 * substituídos por "***". Se não for possível analisar, devolve uma forma
 * genérica que nunca vaza o conteúdo original.
 */
export function redactUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "[URL inválida ou oculta]";
  }
  let out = `${url.protocol}//`;
  if (url.username || url.password) out += "***@";
  out += url.host;
  out += truncatePath(url.pathname);
  if (url.search) {
    const kept: string[] = [];
    for (const [k, v] of url.searchParams.entries()) {
      if (SECRET_PARAM_NAMES.has(k.toLowerCase())) kept.push(`${k}=***`);
      else kept.push(v ? `${k}=${v.slice(0, 24)}` : k);
      if (kept.length >= 5) break;
    }
    out += `?${kept.join("&")}`;
    if (url.searchParams.toString().length > 0 && kept.length === 0) out = out.slice(0, -1);
  }
  return out;
}

function truncatePath(pathname: string): string {
  if (pathname.length <= 64) return pathname;
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length <= 2) return pathname.slice(0, 64) + "…";
  return `/${parts[0]}/…/${parts[parts.length - 1]}`.slice(0, 80);
}

/** Redige padrões user:pass@ embutidos em texto livre (mensagens de erro). */
export function redactText(input: string): string {
  return input
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1***@")
    .replace(/(token|password|passwd|pwd|key|secret|sig|signature)=([^\s&]+)/gi, "$1=***");
}

/** Versão curta "host/caminho" para contextos compactos (linhas da tabela). */
export function displayHost(input: string): string {
  try {
    const url = new URL(input);
    return url.host;
  } catch {
    return "—";
  }
}
