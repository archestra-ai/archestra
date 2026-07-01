import { MINIMAX_MODELS, PERPLEXITY_MODELS } from "@archestra/shared";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { modelFetchers } from "./index";

const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockModelsResponse(json: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(json),
  });
}

describe("descriptor-table fetchers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  test("cerebras drops ids containing llama, keeps createdAt as created*1000", async () => {
    mockModelsResponse({
      data: [
        { id: "llama-3.1-70b", created: 1 },
        { id: "qwen-3-32b", created: 1700000000 },
      ],
    });

    const models = await modelFetchers.cerebras("k");

    expect(models.map((m) => m.id)).toEqual(["qwen-3-32b"]);
    expect(models[0]).toMatchObject({
      id: "qwen-3-32b",
      displayName: "qwen-3-32b",
      provider: "cerebras",
      createdAt: new Date(1700000000 * 1000).toISOString(),
    });
  });

  test("groq maps every model with createdAt as created*1000", async () => {
    mockModelsResponse({ data: [{ id: "groq-a", created: 1700000000 }] });

    const models = await modelFetchers.groq("k");

    expect(models).toEqual([
      {
        id: "groq-a",
        displayName: "groq-a",
        provider: "groq",
        createdAt: new Date(1700000000 * 1000).toISOString(),
      },
    ]);
  });

  test("mistral maps every model with createdAt as created*1000", async () => {
    mockModelsResponse({ data: [{ id: "mistral-a", created: 1700000000 }] });

    const models = await modelFetchers.mistral("k");

    expect(models).toEqual([
      {
        id: "mistral-a",
        displayName: "mistral-a",
        provider: "mistral",
        createdAt: new Date(1700000000 * 1000).toISOString(),
      },
    ]);
  });

  test("deepseek tolerates missing data and falls back createdAt to epoch", async () => {
    mockModelsResponse({ data: [{ id: "deepseek-chat" }] });

    const models = await modelFetchers.deepseek("k");

    expect(models[0]).toMatchObject({
      id: "deepseek-chat",
      provider: "deepseek",
      createdAt: new Date(0).toISOString(),
    });
  });

  test("deepseek returns empty list when data is absent", async () => {
    mockModelsResponse({});

    const models = await modelFetchers.deepseek("k");

    expect(models).toEqual([]);
  });

  test("xai uses created when present, undefined otherwise", async () => {
    mockModelsResponse({
      data: [
        { id: "grok-with-created", created: 1700000000 },
        { id: "grok-orlando", name: "Grok" },
      ],
    });

    const models = await modelFetchers.xai("k");

    expect(models[0].createdAt).toBe(new Date(1700000000 * 1000).toISOString());
    expect(models[1].createdAt).toBeUndefined();
  });

  test("zhipuai filters to glm/chatglm prefixes excluding embeddings", async () => {
    mockModelsResponse({
      data: [
        { id: "glm-4.6", created: 1700000000 },
        { id: "chatglm-3", created: 1700000000 },
        { id: "glm-embedding-2", created: 1700000000 },
        { id: "qwen", created: 1700000000 },
      ],
    });

    const models = await modelFetchers.zhipuai("k");

    expect(models.map((m) => m.id)).toEqual([
      "glm-4.5-flash",
      "glm-4.6",
      "chatglm-3",
    ]);
  });

  test("zhipuai does not prepend the free model when already present", async () => {
    mockModelsResponse({
      data: [{ id: "glm-4.5-flash", created: 1700000000 }],
    });

    const models = await modelFetchers.zhipuai("k");

    expect(models.filter((m) => m.id === "glm-4.5-flash")).toHaveLength(1);
    expect(models[0].createdAt).toBe(new Date(1700000000 * 1000).toISOString());
  });
});

describe("static fetchers", () => {
  test("minimax preserves id and displayName", async () => {
    const models = await modelFetchers.minimax("");
    expect(models).toEqual(
      MINIMAX_MODELS.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        provider: "minimax",
      })),
    );
  });

  test("perplexity preserves distinct displayName labels", async () => {
    const models = await modelFetchers.perplexity("");
    expect(models).toEqual(
      PERPLEXITY_MODELS.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        provider: "perplexity",
      })),
    );
  });
});
