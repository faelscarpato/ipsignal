import { describe, expect, it } from "vitest";
import {
  classifyHlsError,
  classifyHttpCode,
  classifyImportFetchError,
  classifyImportHttpStatus,
  classifyRelayErrorKind,
  decideOutcome,
  IMPORT_ERROR_MESSAGES,
  type StreamEvidence,
} from "./classify";
import { inspectStreamFormat } from "./capabilities";
import { isResultStale, RESULT_STATES, STALE_RESULT_MS, STATUS_META } from "./status";

describe("classificação de erros de stream (HLS e Relay) — todos os estados distintos", () => {
  it("HTTP 401/403/422 → acesso negado (auth_failed)", () => {
    expect(
      classifyHlsError({ type: "networkError", details: "manifestLoadError", responseCode: 401, fatal: true }),
    ).toBe("auth_failed");
    expect(
      classifyHlsError({ type: "networkError", details: "levelLoadError", responseCode: 403, fatal: true }),
    ).toBe("auth_failed");
    expect(classifyHttpCode(422, "blocked_private")).toBe("auth_failed");
  });

  it("HTTP 404/410/500 → origem indisponível (unavailable)", () => {
    expect(
      classifyHlsError({ type: "networkError", details: "fragLoadError", responseCode: 404, fatal: true }),
    ).toBe("unavailable");
    expect(
      classifyHlsError({ type: "networkError", details: "manifestLoadError", responseCode: 500, fatal: true }),
    ).toBe("unavailable");
  });

  it("HTTP 502 / relay network_error → falha de rede (network_error)", () => {
    expect(
      classifyHlsError({
        type: "networkError",
        details: "manifestLoadError",
        responseCode: 502,
        fatal: true,
        relayErrorKind: "network_error",
        viaRelay: true,
      }),
    ).toBe("network_error");
    expect(classifyHttpCode(502)).toBe("network_error");
  });

  it("rede falha sem resposta direta no navegador → bloqueado por CORS (blocked_cors)", () => {
    expect(
      classifyHlsError({
        type: "networkError",
        details: "manifestLoadError",
        responseCode: 0,
        fatal: true,
        isFetchTypeError: true,
        viaRelay: false,
      }),
    ).toBe("blocked_cors");
  });

  it("erro de parsing de manifesto → manifesto inválido (manifest_invalid)", () => {
    expect(
      classifyHlsError({ type: "networkError", details: "manifestParsingError", responseCode: 200, fatal: true }),
    ).not.toBe("unavailable");
    expect(
      classifyHlsError({ type: "networkError", details: "manifestParsingError", responseCode: null, fatal: true }),
    ).toBe("manifest_invalid");
    expect(
      classifyHlsError({ type: "mediaError", details: "levelEmptyError", responseCode: null, fatal: true }),
    ).toBe("manifest_invalid");
  });

  it("codecs/DRM/contêiner incompatível → formato/codec incompatível (codec_unsupported)", () => {
    expect(
      classifyHlsError({ type: "mediaError", details: "bufferAddCodecError", responseCode: null, fatal: true }),
    ).toBe("codec_unsupported");
    expect(
      classifyHlsError({
        type: "mediaError",
        details: "manifestIncompatibleCodecsError",
        responseCode: null,
        fatal: true,
      }),
    ).toBe("codec_unsupported");
    expect(
      classifyHlsError({ type: "otherError", details: "keySystemNoConfiguredLicense", responseCode: null, fatal: true }),
    ).toBe("codec_unsupported");
    expect(
      classifyHlsError({ type: "mediaError", details: "bufferAppendError", responseCode: null, fatal: false }),
    ).toBe("codec_unsupported");
    expect(inspectStreamFormat("https://cdn.example.com/movie.avi").kind).toBe("unsupported_container");
  });

  it("timeouts de carga ou HTTP 504 → timeout distinto de origem indisponível", () => {
    expect(
      classifyHlsError({ type: "networkError", details: "fragLoadTimeOut", responseCode: null, fatal: true }),
    ).toBe("timeout");
    expect(
      classifyHlsError({
        type: "networkError",
        details: "manifestLoadError",
        responseCode: 504,
        fatal: true,
        relayErrorKind: "timeout",
      }),
    ).toBe("timeout");
  });

  it("erro de importação (import_error) é distinto dos demais estados", () => {
    expect(classifyRelayErrorKind("import_error")).toBe("import_error");
  });

  it("erros desconhecidos → não foi possível determinar (undetermined)", () => {
    expect(
      classifyHlsError({ type: "otherError", details: "internalException", responseCode: null, fatal: true }),
    ).toBe("undetermined");
  });

  it("classifyHttpCode nunca devolve 'playing'", () => {
    for (const code of [200, 204, 206, 301, 404, 500, 502, 504]) {
      expect(classifyHttpCode(code)).not.toBe("playing");
    }
  });

  it("todos os estados possuem descrição e próximo passo útil em linguagem simples", () => {
    for (const state of RESULT_STATES) {
      const meta = STATUS_META[state];
      expect(meta.label.length).toBeGreaterThan(3);
      expect(meta.description.length).toBeGreaterThan(10);
      expect(meta.nextStep.length).toBeGreaterThan(10);
    }
  });

  it("isResultStale sinaliza resultados antigos para revalidação", () => {
    const now = 1_700_000_000_000;
    expect(isResultStale(now - 30_000, now)).toBe(false);
    expect(isResultStale(now - STALE_RESULT_MS - 1, now)).toBe(true);
  });
});

describe("decideOutcome — sem evidência de mídia, NUNCA 'playing'", () => {
  const base: StreamEvidence = {
    manifestParsed: false,
    levelLoaded: false,
    fragLoaded: false,
    playbackEvidence: false,
  };

  it("sem nenhuma evidência → undetermined (ou timeout quando expirou)", () => {
    expect(decideOutcome({ ...base }, null)).toBe("undetermined");
    expect(decideOutcome({ ...base, timedOut: true }, null)).toBe("timeout");
  });

  it("manifesto OK mas sem fragmentos → acessível, sem playback confirmado", () => {
    expect(decideOutcome({ ...base, manifestParsed: true, levelLoaded: true }, null)).toBe(
      "reachable_unconfirmed",
    );
  });

  it("fragmento baixado mas nada anexado ao buffer → ainda NÃO confirmado", () => {
    expect(
      decideOutcome({ ...base, manifestParsed: true, levelLoaded: true, fragLoaded: true }, null),
    ).toBe("reachable_unconfirmed");
  });

  it("erro classificado prevalece sobre manifesto OK", () => {
    expect(decideOutcome({ ...base, manifestParsed: true }, "codec_unsupported")).toBe(
      "codec_unsupported",
    );
  });

  it("com evidência de mídia → playing mesmo havendo erro registrado depois", () => {
    expect(
      decideOutcome({ ...base, manifestParsed: true, playbackEvidence: true }, "unavailable"),
    ).toBe("playing");
  });

  it("HTTP 200 + manifesto baixado SOZINHOS nunca viram 'playing'", () => {
    const outcome = decideOutcome(
      { manifestParsed: true, levelLoaded: true, fragLoaded: false, playbackEvidence: false },
      null,
    );
    expect(outcome).not.toBe("playing");
  });
});

describe("classificação de erros de importação (estados distintos)", () => {
  it("status HTTP mapeiam para tipos diferentes", () => {
    expect(classifyImportHttpStatus(401)).toBe("auth");
    expect(classifyImportHttpStatus(403)).toBe("auth");
    expect(classifyImportHttpStatus(404)).toBe("not_found");
    expect(classifyImportHttpStatus(413)).toBe("too_large");
    expect(classifyImportHttpStatus(504)).toBe("timeout");
    expect(classifyImportHttpStatus(422)).toBe("blocked_private");
    expect(classifyImportHttpStatus(502)).toBe("http_error");
  });

  it("cancelamento, timeout e CORS são estados diferentes", () => {
    const abort = new DOMException("user canceled", "AbortError");
    expect(classifyImportFetchError(abort, false)).toBe("aborted");
    expect(classifyImportFetchError(abort, true)).toBe("timeout");
    expect(classifyImportFetchError(new TypeError("Failed to fetch"), false)).toBe("cors");
    expect(classifyImportFetchError(new Error("outro"), false)).toBe("network");
  });

  it("cada tipo tem mensagem própria e explicativa", () => {
    const kinds = [
      "cors",
      "timeout",
      "aborted",
      "auth",
      "http_error",
      "not_found",
      "too_large",
      "invalid_content",
      "network",
      "blocked_private",
    ] as const;
    const titles = new Set(kinds.map((k) => IMPORT_ERROR_MESSAGES[k].title));
    expect(titles.size).toBe(kinds.length);
    expect(IMPORT_ERROR_MESSAGES.cors.hint).toContain("CORS");
    expect(IMPORT_ERROR_MESSAGES.invalid_content.title).toContain("M3U");
  });
});
