import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OPENCODE_AGENT_HEADER } from "@archestra/shared/consts";
import { describe, expect, test, vi } from "vitest";
import { renderOpenCodeRoutingPlugin } from "@/services/opencode-routing-plugin";

describe("OpenCode routing plugin", () => {
  test("reapplies managed routes and fails closed for unsupported or overridden providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-plugin-"));
    const file = path.join(root, "archestra-llm-proxy.mjs");
    const dataDir = path.join(root, "data");
    const routes = {
      anthropic: "https://example.com/v1/anthropic/v1",
      google: "https://example.com/v1/gemini/v1beta",
      openai: "https://example.com/v1/openai",
      cerebras: "https://example.com/v1/cerebras",
      zhipuai: "https://example.com/v1/zhipuai",
    };
    const headers = {
      "X-Archestra-Agent-Id": "opencode",
      "X-Archestra-Virtual-Key": "arch_passthroughcafe",
    };
    const originalFetch = globalThis.fetch;
    const originalDataHome = process.env.XDG_DATA_HOME;
    const originalCerebrasKey = process.env.CEREBRAS_API_KEY;
    const outboundFetch = vi.fn().mockResolvedValue(new Response("ok"));
    try {
      globalThis.fetch = outboundFetch;
      process.env.XDG_DATA_HOME = dataDir;
      process.env.CEREBRAS_API_KEY = "cerebras-key";
      await mkdir(path.join(dataDir, "opencode"), { recursive: true });
      await writeFile(
        path.join(dataDir, "opencode", "auth.json"),
        JSON.stringify({
          openai: {
            type: "oauth",
            access: "stale-openai-access",
            refresh: "openai-refresh",
            accountId: "acct",
          },
          google: {
            type: "oauth",
            access: "google-access",
            refresh: "google-refresh",
            expires: Date.now() - 1,
          },
        }),
      );
      await writeFile(file, renderOpenCodeRoutingPlugin({ routes, headers }));
      const module = await import(
        `${pathToFileURL(file).href}?t=${Date.now()}`
      );
      const hooks = await module.ArchestraLlmProxy();
      const config = {
        enabled_providers: ["direct"],
        disabled_providers: ["google", "direct"],
        model: "zhipuai/glm-model",
        small_model: "google/gemini-model",
        provider: {
          anthropic: { options: { apiKey: "configured-key" } },
          google: {
            options: {
              baseURL: "https://generativelanguage.googleapis.com/v1beta",
              headers: { "X-Local": "kept" },
            },
          },
        },
      };

      await hooks.config(config);
      expect(config).toMatchObject({
        enabled_providers: ["anthropic", "google", "openai", "cerebras"],
        disabled_providers: ["direct"],
        small_model: "google/gemini-model",
        provider: {
          google: {
            options: {
              baseURL: routes.google,
              headers: {
                "X-Local": "kept",
                "X-Archestra-Agent-Id": "opencode",
              },
            },
          },
        },
      });
      expect(config).not.toHaveProperty("model");
      expect(config.provider).not.toHaveProperty("zhipuai");
      expect(
        (
          config.provider as Record<
            string,
            { options: Record<string, unknown> }
          >
        ).openai?.options.baseURL,
      ).toBe("https://api.openai.com/v1");

      const googleInput = {
        sessionID: "ses_parent",
        agent: "build",
        provider: {
          id: "google",
          options: { baseURL: routes.google },
        },
      };
      await expect(hooks["chat.params"](googleInput)).resolves.toBeUndefined();
      await expect(
        hooks["chat.params"]({
          provider: {
            id: "google",
            options: { baseURL: "https://generativelanguage.googleapis.com" },
          },
        }),
      ).rejects.toThrow("instead of the connected Archestra endpoint");
      await expect(
        hooks["chat.params"]({
          provider: { id: "direct", options: {} },
        }),
      ).rejects.toThrow("is not supported");

      const output: { headers: Record<string, string> } = {
        headers: { "X-Local": "kept" },
      };
      await hooks["chat.headers"](googleInput, output);
      expect(output.headers).toEqual({
        "X-Local": "kept",
        "X-Archestra-Agent-Id": "opencode",
        "X-Archestra-Virtual-Key": "arch_passthroughcafe",
        "x-opencode-session": "ses_parent",
        [OPENCODE_AGENT_HEADER]: "build",
      });

      const childOutput: { headers: Record<string, string> } = { headers: {} };
      await hooks["chat.headers"](
        { ...googleInput, sessionID: "ses_child", agent: "explore" },
        childOutput,
      );
      expect(childOutput.headers).toMatchObject({
        "x-opencode-session": "ses_child",
        [OPENCODE_AGENT_HEADER]: "explore",
      });
      expect(output.headers["x-opencode-session"]).toBe("ses_parent");

      await globalThis.fetch(
        new Request("https://chatgpt.com/backend-api/codex/responses", {
          method: "POST",
          headers: {
            Authorization: "Bearer refreshed-openai-access",
            "ChatGPT-Account-Id": "acct",
          },
          body: "{}",
        }),
      );
      const fallbackRequest = outboundFetch.mock.calls.at(-1)?.[0] as Request;
      expect(fallbackRequest.headers.get("authorization")).toBe(
        "Bearer refreshed-openai-access",
      );

      const openAiHooks = await module.ArchestraOpenAiOAuth();
      const openAiLoader = await openAiHooks.auth.loader(async () => ({
        type: "oauth",
        access: "openai-access",
      }));
      await openAiLoader.fetch(
        new Request("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "x-openai-internal-codex-residency": "us",
            "x-opencode-session": "ses_parent",
          },
          body: "{}",
        }),
      );
      const openAiRequest = outboundFetch.mock.calls.at(-1)?.[0] as Request;
      expect(openAiRequest.url).toBe(`${routes.openai}/responses`);
      expect(openAiRequest.headers.get("authorization")).toBe(
        "Bearer openai-access",
      );
      expect(openAiRequest.headers.get("chatgpt-account-id")).toBe("acct");
      expect(
        openAiRequest.headers.get("x-archestra-opencode-oauth-bridge"),
      ).toBe("true");
      expect(openAiRequest.headers.get("x-archestra-virtual-key")).toBe(
        "arch_passthroughcafe",
      );
      expect(openAiRequest.headers.get("x-opencode-session")).toBe(
        "ses_parent",
      );
      const expiredOpenAiLoader = await openAiHooks.auth.loader(async () => ({
        type: "oauth",
        access: "expired-openai-access",
        expires: Date.now() - 1,
      }));
      await expect(
        expiredOpenAiLoader.fetch("https://api.openai.com/v1/responses", {
          method: "POST",
        }),
      ).rejects.toThrow("OpenAI OAuth access token expired");

      const googleLoader = await hooks.auth.loader(async () => ({
        type: "oauth",
        access: "google-access",
        expires: Date.now() + 60_000,
      }));
      await googleLoader.fetch(
        new Request(`${routes.google}/models/gemini:test`, {
          method: "POST",
          headers: {
            "x-goog-api-key": "archestra-oauth-bridge",
            "x-opencode-session": "ses_parent",
          },
          body: "{}",
        }),
      );
      const googleRequest = outboundFetch.mock.calls.at(-1)?.[0] as Request;
      expect(googleRequest.headers.get("x-goog-api-key")).toBeNull();
      expect(googleRequest.headers.get("authorization")).toBe(
        "Bearer google-access",
      );
      expect(googleRequest.headers.get("x-archestra-virtual-key")).toBe(
        "arch_passthroughcafe",
      );
      expect(googleRequest.headers.get("x-opencode-session")).toBe(
        "ses_parent",
      );
      const expiredGoogleLoader = await hooks.auth.loader(async () => ({
        type: "oauth",
        access: "expired-google-access",
        expires: Date.now() - 1,
      }));
      await expect(
        expiredGoogleLoader.fetch(`${routes.google}/models/gemini:test`, {
          method: "POST",
        }),
      ).rejects.toThrow("Google OAuth access token expired");

      expect(() =>
        globalThis.fetch("https://api.openai.com/v1/responses"),
      ).toThrow("Blocked a direct provider inference request");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalDataHome;
      if (originalCerebrasKey === undefined)
        delete process.env.CEREBRAS_API_KEY;
      else process.env.CEREBRAS_API_KEY = originalCerebrasKey;
      delete (globalThis as unknown as Record<PropertyKey, unknown>)[
        Symbol.for("archestra.opencode.llmProxyFetchGuard")
      ];
      await rm(root, { recursive: true, force: true });
    }
  });
});
