import { describe, expect, it } from "vitest";
import { displayHost, redactText, redactUrl } from "./redact";
import { validateHttpUrl } from "./validate";

describe("redactUrl — segredos nunca vazam", () => {
  it("remove user:pass@ e mascara parâmetros sensíveis", () => {
    const r = redactUrl("http://user:supersecret@h.test:8080/live/c1.m3u8?token=abc123xyz&mode=live");
    expect(r).not.toContain("supersecret");
    expect(r).not.toContain("user:supersecret");
    expect(r).not.toContain("abc123xyz");
    expect(r).toContain("h.test");
    expect(r).toContain("token=***");
    expect(r).toContain("mode=live");
  });

  it("mascara vários nomes de segredo comuns", () => {
    const r = redactUrl("https://h.test/a?password=p&sig=s&access_token=t&ok=1");
    expect(r).not.toContain("=p");
    expect(r).toContain("password=***");
    expect(r).toContain("sig=***");
    expect(r).toContain("access_token=***");
    expect(r).toContain("ok=1");
  });

  it("URL inválida nunca é refletida", () => {
    expect(redactUrl("not a url at all")).toBe("[URL inválida ou oculta]");
  });

  it("caminhos longos são encurtados", () => {
    const r = redactUrl(`https://h.test/${"a".repeat(200)}/x.m3u8`);
    expect(r.length).toBeLessThan(130);
  });

  it("redactText limpa credenciais embutidas em mensagens", () => {
    const t = redactText("Falha em http://u:p@h.test/x.m3u8 com token=segredo123");
    expect(t).not.toContain("u:p@");
    expect(t).not.toContain("segredo123");
  });

  it("displayHost expõe só o host", () => {
    expect(displayHost("https://user:pass@h.test:8080/x?token=a")).toBe("h.test:8080");
    expect(displayHost("lixo")).toBe("—");
  });
});

describe("validateHttpUrl — somente http/https", () => {
  it("aceita http e https", () => {
    expect(validateHttpUrl("http://h.test/a.m3u8").ok).toBe(true);
    expect(validateHttpUrl("https://h.test/a.m3u8").ok).toBe(true);
  });

  it("rejeita esquemas arbitrários", () => {
    for (const u of ["ftp://h/a", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "rtmp://h/x", "chrome://x"]) {
      const c = validateHttpUrl(u);
      expect(c.ok).toBe(false);
    }
  });

  it("rejeita URL com espaço ou vazia", () => {
    expect(validateHttpUrl("http://h.test/a b.m3u8").ok).toBe(false);
    expect(validateHttpUrl("").ok).toBe(false);
  });
});
