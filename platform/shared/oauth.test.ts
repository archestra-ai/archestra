import { describe, expect, test } from "vitest";
import {
  isLocalhostUrl,
  OLLAMA_DOCKER_HOST_URL,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
} from "./oauth";

describe("isLocalhostUrl", () => {
  test("matches loopback hostnames", () => {
    expect(isLocalhostUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalhostUrl("https://localhost")).toBe(true);
    expect(isLocalhostUrl("http://127.0.0.1:8000")).toBe(true);
    expect(isLocalhostUrl("http://0.0.0.0:8080")).toBe(true);
    expect(isLocalhostUrl("http://[::1]:11434")).toBe(true);
  });

  test("does not match remote hostnames", () => {
    expect(isLocalhostUrl("https://ollama.example.com")).toBe(false);
    expect(isLocalhostUrl("http://host.docker.internal:11434")).toBe(false);
    expect(isLocalhostUrl("http://192.168.1.10:11434")).toBe(false);
  });

  test("returns false for empty or invalid input", () => {
    expect(isLocalhostUrl(null)).toBe(false);
    expect(isLocalhostUrl(undefined)).toBe(false);
    expect(isLocalhostUrl("")).toBe(false);
    expect(isLocalhostUrl("not a url")).toBe(false);
  });
});

describe("PROVIDERS_WITH_OPTIONAL_API_KEY", () => {
  test("contains ollama and vllm", () => {
    expect(PROVIDERS_WITH_OPTIONAL_API_KEY.has("ollama")).toBe(true);
    expect(PROVIDERS_WITH_OPTIONAL_API_KEY.has("vllm")).toBe(true);
  });

  test("does not contain providers that require keys", () => {
    expect(PROVIDERS_WITH_OPTIONAL_API_KEY.has("openai")).toBe(false);
    expect(PROVIDERS_WITH_OPTIONAL_API_KEY.has("anthropic")).toBe(false);
  });
});

describe("OLLAMA_DOCKER_HOST_URL", () => {
  test("points at the docker host loopback", () => {
    expect(OLLAMA_DOCKER_HOST_URL).toBe("http://host.docker.internal:11434/");
  });
});
