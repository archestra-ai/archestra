import { describe, expect, test } from "vitest";
import { dockerLocalhostConnectionHint } from "./docker-localhost-hint";

describe("dockerLocalhostConnectionHint", () => {
  test("suggests host.docker.internal for a localhost URL on a connection failure", () => {
    const hint = dockerLocalhostConnectionHint({
      baseUrl: "http://localhost:11434/v1",
      errorMessage: "fetch failed",
    });
    expect(hint).toContain("http://host.docker.internal:11434/v1");
  });

  test("rewrites loopback IP literals too", () => {
    const hint = dockerLocalhostConnectionHint({
      baseUrl: "http://127.0.0.1:11434/v1",
      errorMessage: "connect ECONNREFUSED 127.0.0.1:11434",
    });
    expect(hint).toContain("http://host.docker.internal:11434/v1");
  });

  test("returns null for non-connection errors", () => {
    expect(
      dockerLocalhostConnectionHint({
        baseUrl: "http://localhost:11434/v1",
        errorMessage: "Models list is empty",
      }),
    ).toBeNull();
    expect(
      dockerLocalhostConnectionHint({
        baseUrl: "http://localhost:11434/v1",
        errorMessage: "Failed to fetch Ollama models: 401",
      }),
    ).toBeNull();
  });

  test("returns null when the URL is not loopback", () => {
    expect(
      dockerLocalhostConnectionHint({
        baseUrl: "https://ollama.example.com/v1",
        errorMessage: "fetch failed",
      }),
    ).toBeNull();
  });

  test("returns null when there is no base URL", () => {
    expect(
      dockerLocalhostConnectionHint({
        baseUrl: null,
        errorMessage: "fetch failed",
      }),
    ).toBeNull();
  });

  test("returns null for an unparseable URL", () => {
    expect(
      dockerLocalhostConnectionHint({
        baseUrl: "not a url",
        errorMessage: "fetch failed",
      }),
    ).toBeNull();
  });
});
