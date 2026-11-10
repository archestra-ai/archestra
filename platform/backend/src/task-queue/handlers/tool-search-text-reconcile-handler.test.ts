import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import {
  hashToolDefinition,
  TOOL_SEARCH_TEXT_PROMPT_VERSION,
} from "@/archestra-mcp-server/search-text";
import db, { schema } from "@/database";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
  ToolSearchTextModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { reconcileToolSearchTexts } from "./tool-search-text-reconcile-handler";

const BASE_URL = "https://llm.test/v1";
const FAST_MODEL = "fast-model";
const DAY_MS = 24 * 60 * 60 * 1000;

// biome-ignore lint/correctness/useHookAtTopLevel: per-test provider boundary
const server = useMswServer();

function serveCompletions(reply: () => string | { status: number }) {
  const prompts: string[] = [];
  server.use(
    http.post(`${BASE_URL}/chat/completions`, async ({ request }) => {
      const body = (await request.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      prompts.push(
        body.messages.find(({ role }) => role === "user")?.content ?? "",
      );
      const content = reply();
      if (typeof content !== "string") {
        return HttpResponse.json(
          { error: { message: "provider error" } },
          { status: content.status },
        );
      }
      return HttpResponse.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: FAST_MODEL,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }),
  );
  return prompts;
}

const generated = (text: string) => JSON.stringify({ search_text: text });

async function readRow(definitionHash: string) {
  const [row] = await db
    .select()
    .from(schema.toolSearchTextsTable)
    .where(eq(schema.toolSearchTextsTable.definitionHash, definitionHash));
  return row;
}

async function makeOlder(definitionHash: string, ageMs: number) {
  await db
    .update(schema.toolSearchTextsTable)
    .set({ updatedAt: new Date(Date.now() - ageMs) })
    .where(eq(schema.toolSearchTextsTable.definitionHash, definitionHash));
}

describe("reconcileToolSearchTexts", () => {
  type Fixtures = {
    makeOrganization: () => Promise<{ id: string }>;
    makeSecret: (input: {
      secret: Record<string, string>;
    }) => Promise<{ id: string }>;
    makeLlmProviderApiKey: (
      organizationId: string,
      secretId: string | null,
      overrides: { provider: "openai"; baseUrl: string },
    ) => Promise<{ id: string }>;
    makeInternalMcpCatalog: (input: {
      organizationId: string;
    }) => Promise<{ id: string }>;
    makeTool: (input: {
      name: string;
      description: string;
      catalogId: string;
      parameters: Record<string, unknown>;
    }) => Promise<{ id: string }>;
  };

  async function setup(fixtures: Fixtures, options?: { linkModel?: boolean }) {
    const organization = await fixtures.makeOrganization();
    const secret = await fixtures.makeSecret({
      secret: { apiKey: "test-key" },
    });
    const key = await fixtures.makeLlmProviderApiKey(
      organization.id,
      secret.id,
      { provider: "openai", baseUrl: BASE_URL },
    );
    const model = await ModelModel.create({
      provider: "openai",
      modelId: FAST_MODEL,
      externalId: `openai/${FAST_MODEL}`,
      inputModalities: ["text"],
      outputModalities: ["text"],
      outputLength: 4096,
    });
    if (options?.linkModel !== false) {
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
        model.id,
      ]);
    }
    await OrganizationModel.patch(organization.id, {
      defaultLlmApiKeyId: key.id,
      defaultFastModelId: model.id,
    });
    const catalog = await fixtures.makeInternalMcpCatalog({
      organizationId: organization.id,
    });
    const makeDefinition = async (name: string, description = "Do a thing") => {
      const parameters = { type: "object", properties: {} };
      await fixtures.makeTool({
        name,
        description,
        catalogId: catalog.id,
        parameters,
      });
      return hashToolDefinition({ name, description, parameters });
    };
    return { makeDefinition, generatorId: `openai/${FAST_MODEL}` };
  }

  type Harness = Awaited<ReturnType<typeof setup>>;
  const it = test.extend<{ harness: Harness; unlinkedHarness: Harness }>({
    harness: async (
      {
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
        makeInternalMcpCatalog,
        makeTool,
      },
      use,
    ) => {
      await use(
        await setup({
          makeOrganization,
          makeSecret,
          makeLlmProviderApiKey,
          makeInternalMcpCatalog,
          makeTool,
        } as unknown as Fixtures),
      );
    },
    unlinkedHarness: async (
      {
        makeOrganization,
        makeSecret,
        makeLlmProviderApiKey,
        makeInternalMcpCatalog,
        makeTool,
      },
      use,
    ) => {
      await use(
        await setup(
          {
            makeOrganization,
            makeSecret,
            makeLlmProviderApiKey,
            makeInternalMcpCatalog,
            makeTool,
          } as unknown as Fixtures,
          { linkModel: false },
        ),
      );
    },
  });

  it("stores generated text and does not call the provider again for it", async ({
    harness,
  }) => {
    const { makeDefinition } = harness;
    const hash = await makeDefinition("server__lookup");
    const prompts = serveCompletions(() => generated("booking availability"));

    await reconcileToolSearchTexts();
    await reconcileToolSearchTexts();

    expect(prompts).toHaveLength(1);
    expect(JSON.parse(prompts[0] ?? "{}")).toMatchObject({
      name: "server__lookup",
      description: "Do a thing",
    });
    expect(await readRow(hash)).toMatchObject({
      status: "ready",
      searchText: "booking availability",
    });
  });

  it("records cost accounting under its own interaction source", async ({
    harness,
  }) => {
    const { makeDefinition } = harness;
    await makeDefinition("server__lookup");
    serveCompletions(() => generated("booking"));

    await reconcileToolSearchTexts();

    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .where(
          eq(schema.interactionsTable.source, "tool_search_text:generation"),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.inputTokens).toBe(10);
    });
  });

  it("caches a blank or unindexable answer as empty", async ({ harness }) => {
    const { makeDefinition } = harness;
    const hash = await makeDefinition("server__lookup");
    const prompts = serveCompletions(() => generated("— … —"));

    await reconcileToolSearchTexts();
    await reconcileToolSearchTexts();

    expect(prompts).toHaveLength(1);
    expect(await readRow(hash)).toMatchObject({
      status: "empty",
      searchText: null,
    });
  });

  it("treats an answer over 2000 characters as failed", async ({ harness }) => {
    const { makeDefinition } = harness;
    const hash = await makeDefinition("server__lookup");
    serveCompletions(() => generated("a".repeat(2001)));

    await reconcileToolSearchTexts();

    expect(await readRow(hash)).toMatchObject({
      status: "failed",
      searchText: null,
    });
  });

  it("retries a failed definition only after a day", async ({ harness }) => {
    const { makeDefinition } = harness;
    const hash = await makeDefinition("server__lookup");
    const prompts = serveCompletions(() => ({ status: 400 }));

    await reconcileToolSearchTexts();
    await reconcileToolSearchTexts();
    expect(prompts).toHaveLength(1);

    await makeOlder(hash, DAY_MS - 60_000);
    await reconcileToolSearchTexts();
    expect(prompts).toHaveLength(1);

    await makeOlder(hash, DAY_MS + 60_000);
    await reconcileToolSearchTexts();
    expect(prompts).toHaveLength(2);
  });

  it("keeps the previous text when a regeneration fails", async ({
    harness,
  }) => {
    const { makeDefinition } = harness;
    const hash = await makeDefinition("server__lookup");
    await ToolSearchTextModel.recordAttempt({
      definitionHash: hash,
      promptVersion: TOOL_SEARCH_TEXT_PROMPT_VERSION,
      generator: "openai/previous-model",
      result: { status: "ready", searchText: "previous vocabulary" },
    });
    const prompts = serveCompletions(() => ({ status: 400 }));

    await reconcileToolSearchTexts();
    await reconcileToolSearchTexts();

    expect(prompts).toHaveLength(1);
    expect(await readRow(hash)).toMatchObject({
      status: "failed",
      searchText: "previous vocabulary",
      generator: `openai/${FAST_MODEL}`,
    });
  });

  it("regenerates when the prompt version changes", async ({ harness }) => {
    const { generatorId, makeDefinition } = harness;
    const hash = await makeDefinition("server__lookup");
    await ToolSearchTextModel.recordAttempt({
      definitionHash: hash,
      promptVersion: TOOL_SEARCH_TEXT_PROMPT_VERSION - 1,
      generator: generatorId,
      result: { status: "ready", searchText: "old" },
    });
    serveCompletions(() => generated("new"));

    await reconcileToolSearchTexts();

    expect(await readRow(hash)).toMatchObject({
      searchText: "new",
      promptVersion: TOOL_SEARCH_TEXT_PROMPT_VERSION,
    });
  });

  it("removes text no definition references", async ({ harness }) => {
    const { generatorId, makeDefinition } = harness;
    await makeDefinition("server__lookup");
    await ToolSearchTextModel.recordAttempt({
      definitionHash: "orphan",
      promptVersion: TOOL_SEARCH_TEXT_PROMPT_VERSION,
      generator: generatorId,
      result: { status: "ready", searchText: "gone" },
    });
    serveCompletions(() => generated("kept"));

    await reconcileToolSearchTexts();

    expect(await readRow("orphan")).toBeUndefined();
  });

  it("attempts at most 200 definitions per pass", async ({ harness }) => {
    const { makeDefinition } = harness;
    await Promise.all(
      Array.from({ length: 201 }, (_, i) =>
        makeDefinition(`server__tool_${i}`),
      ),
    );
    const prompts = serveCompletions(() => generated("vocabulary"));

    await reconcileToolSearchTexts();
    expect(prompts).toHaveLength(200);

    await reconcileToolSearchTexts();
    expect(prompts).toHaveLength(201);
  }, 60_000);

  it("makes no call and deletes nothing when no linked model resolves", async ({
    unlinkedHarness,
  }) => {
    const { generatorId, makeDefinition } = unlinkedHarness;
    await makeDefinition("server__lookup");
    await ToolSearchTextModel.recordAttempt({
      definitionHash: "orphan",
      promptVersion: TOOL_SEARCH_TEXT_PROMPT_VERSION,
      generator: generatorId,
      result: { status: "ready", searchText: "kept" },
    });
    const prompts = serveCompletions(() => generated("unused"));

    await reconcileToolSearchTexts();

    expect(prompts).toHaveLength(0);
    expect(await readRow("orphan")).toBeDefined();
  });
});

describe("reconcile inventory", () => {
  test("covers only the generator organization's catalogs", async ({
    makeInternalMcpCatalog,
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
    makeTool,
  }) => {
    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const key = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider: "openai",
      baseUrl: BASE_URL,
    });
    const model = await ModelModel.create({
      provider: "openai",
      modelId: FAST_MODEL,
      externalId: `openai/${FAST_MODEL}`,
      inputModalities: ["text"],
      outputModalities: ["text"],
      outputLength: 4096,
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    await OrganizationModel.patch(organization.id, {
      defaultLlmApiKeyId: key.id,
      defaultFastModelId: model.id,
    });
    const otherOrganization = await makeOrganization();
    const ownCatalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
    });
    const otherCatalog = await makeInternalMcpCatalog({
      organizationId: otherOrganization.id,
    });
    const parameters = { type: "object", properties: {} };
    await makeTool({ name: "own__tool", catalogId: ownCatalog.id, parameters });
    await makeTool({
      name: "other__tool",
      catalogId: otherCatalog.id,
      parameters,
    });
    const prompts = serveCompletions(() => generated("vocabulary"));

    await reconcileToolSearchTexts();

    expect(prompts.map((prompt) => JSON.parse(prompt).name)).toEqual([
      "own__tool",
    ]);
  });
});

describe("hashToolDefinition", () => {
  test("ignores key order and tracks description and schema changes", () => {
    const base = {
      name: "server__lookup",
      description: "Do a thing",
      parameters: { type: "object", properties: { a: { type: "string" } } },
    };
    const reordered = {
      name: "server__lookup",
      description: "Do a thing",
      parameters: { properties: { a: { type: "string" } }, type: "object" },
    };

    expect(hashToolDefinition(reordered)).toBe(hashToolDefinition(base));
    expect(hashToolDefinition({ ...base, description: "Other" })).not.toBe(
      hashToolDefinition(base),
    );
    expect(
      hashToolDefinition({ ...base, parameters: { type: "object" } }),
    ).not.toBe(hashToolDefinition(base));
  });
});
