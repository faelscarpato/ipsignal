import { describe, expect, it } from "vitest";
import { ipv6ToBytes, isPublicIp } from "./ip";
import { validateRedirectTarget, validateTargetUrl } from "./policy";

describe("isPublicIp — bloqueios IPv4 (OWASP denylist)", () => {
  it.each([
    "127.0.0.1", // loopback
    "127.10.20.30",
    "10.0.0.5", // RFC1918
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // metadados de nuvem (IMDS)
    "169.254.0.1", // link-local
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "198.18.0.1", // benchmark
    "192.0.2.1", // TEST-NET
    "203.0.113.9",
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast
  ])("bloqueia %s", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "151.101.1.140", "172.32.0.1", "11.0.0.1"])(
    "permite %s",
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );

  it("formatos não estritos (hex/dword/octal) não contam como IP público", () => {
    expect(isPublicIp("0x7f000001")).toBe(false);
    expect(isPublicIp("2130706433")).toBe(false);
    expect(isPublicIp("0177.0.0.1")).toBe(false);
    expect(isPublicIp("127.1")).toBe(false);
  });
});

describe("isPublicIp — bloqueios IPv6", () => {
  it.each([
    "::1", // loopback
    "::", // não especificado
    "fe80::1", // link-local
    "fc00::1", // ULA
    "fd12:3456::1", // ULA
    "ff02::1", // multicast
    "2001:db8::1", // documentação
    "2001::1", // Teredo
    "2002::1", // 6to4
    "64:ff9b::1", // NAT64 well-known
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:7f00:1", // mapped hex loopback
    "::ffff:10.0.0.1", // mapped privado
    "::ffff:169.254.169.254", // mapped IMDS
  ])("bloqueia %s", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(["2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "permite %s",
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );

  it("expansão de IPv6 está correta", () => {
    const b = ipv6ToBytes("::ffff:127.0.0.1");
    expect(b).not.toBeNull();
    expect(Array.from(b!.slice(10))).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    expect(Array.from(ipv6ToBytes("2001:db8::1")!.slice(0, 4))).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(ipv6ToBytes(":::")).toBeNull();
    expect(ipv6ToBytes("1:2:3:4:5")).toBeNull();
  });
});

describe("validateTargetUrl — política de destino do servidor", () => {
  it("aceita http/https público em portas 80/443", () => {
    expect(validateTargetUrl("http://example.com/lista.m3u8").ok).toBe(true);
    expect(validateTargetUrl("https://example.com:443/lista.m3u8").ok).toBe(true);
  });

  it("rejeita esquemas não-http (gopher, file, ftp)", () => {
    for (const u of ["gopher://h/x", "file:///etc/passwd", "ftp://h/x.m3u"]) {
      const v = validateTargetUrl(u);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("http/https");
    }
  });

  it("bloqueia loopback, privados, link-local e metadados por IP literal", () => {
    for (const u of [
      "http://127.0.0.1/lista.m3u",
      "http://10.0.0.8/lista.m3u",
      "http://192.168.0.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/x",
      "http://[fe80::1]/x",
      "http://[::ffff:127.0.0.1]/x",
    ]) {
      expect(validateTargetUrl(u).ok).toBe(false);
    }
  });

  it("bloqueia hostnames internos conhecidos", () => {
    for (const u of [
      "http://localhost/x.m3u",
      "http://printer.local/x",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://nas.lan/list.m3u",
    ]) {
      expect(validateTargetUrl(u).ok).toBe(false);
    }
  });

  it("bloqueia portas fora da allowlist", () => {
    const v = validateTargetUrl("http://example.com:22/list.m3u");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("Porta");
    expect(validateTargetUrl("http://example.com:8080/list.m3u").ok).toBe(false);
  });
});

describe("validateRedirectTarget — redirects para destinos bloqueados não passam", () => {
  const base = new URL("https://cdn.example.com/lista.m3u");

  it("redirect http→https público passa", () => {
    const v = validateRedirectTarget(base, "https://cdn2.example.com/lista.m3u");
    expect(v.ok).toBe(true);
  });

  it("redirect relativo passa quando continua público", () => {
    const v = validateRedirectTarget(base, "/outra/lista.m3u");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.url.host).toBe("cdn.example.com");
  });

  it("redirect para loopback é bloqueado", () => {
    expect(validateRedirectTarget(base, "http://127.0.0.1/x").ok).toBe(false);
  });

  it("redirect para rede privada é bloqueado", () => {
    expect(validateRedirectTarget(base, "http://192.168.1.50/x.m3u").ok).toBe(false);
  });

  it("redirect para metadados de nuvem é bloqueado", () => {
    expect(validateRedirectTarget(base, "http://169.254.169.254/latest").ok).toBe(false);
  });

  it("redirect para outro esquema (file:, gopher:) é bloqueado", () => {
    expect(validateRedirectTarget(base, "file:///etc/passwd").ok).toBe(false);
    expect(validateRedirectTarget(base, "gopher://internal/x").ok).toBe(false);
  });

  it("redirect malformado é rejeitado sem vazar destino", () => {
    expect(validateRedirectTarget(base, "http://[::1:8080").ok).toBe(false);
  });
});
