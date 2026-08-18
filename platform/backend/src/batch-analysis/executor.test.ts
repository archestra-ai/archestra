import { vi } from "vitest";

// Mock only true boundaries: the model call and the model/credential resolution.
// The source resolver, the prompt builder, the parser and the database are real.
vi.mock("@/utils/generate-tagged-text", () => ({
  generateTaggedText: vi.fn(),
}));
vi.mock("@/clients/llm-client", () => ({
  createLLMModel: vi.fn(() => ({})),
  isApiKeyRequired: vi.fn(() => false),
}));
vi.mock("@/utils/llm-resolution", () => ({
  resolveAgentLlmOrDefault: vi.fn(async () => ({
    provider: "anthropic",
    modelName: "claude-test",
    apiKey: "test-key",
    baseUrl: null,
    chatApiKeyId: "key-row-1",
  })),
}));

import { createLLMModel, isApiKeyRequired } from "@/clients/llm-client";
import { AgentModel, BatchAnalysisModel } from "@/models";
import ModelModel from "@/models/model";
import { beforeEach, describe, expect, test } from "@/test";
import type {
  BatchAnalysis,
  BatchAnalysisColumn,
  BatchAnalysisRow,
} from "@/types";
import { generateTaggedText } from "@/utils/generate-tagged-text";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";
import { executeRow } from "./executor";

const SOURCE_TEXT =
  "The agreement is effective 2026-01-01. SSO is supported via SAML.";

const columns: BatchAnalysisColumn[] = [
  {
    key: "effective_date",
    name: "Effective date",
    prompt: "When is it effective?",
    format: "date",
  },
  {
    key: "has_sso",
    name: "SSO",
    prompt: "Is SSO supported?",
    format: "boolean",
  },
];

describe("executeRow", () => {
  let analysis: BatchAnalysis;
  let row: BatchAnalysisRow;

  beforeEach(async ({ makeOrganization, makeUser, makeAgent }) => {
    vi.mocked(isApiKeyRequired).mockReturnValue(false);

    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    analysis = await BatchAnalysisModel.create({
      organizationId: org.id,
      name: "Test analysis",
      agentId: agent.id,
      columns,
      createdBy: user.id,
    });

    const [created] = await BatchAnalysisModel.addRows(analysis.id, [
      {
        label: "Doc A",
        source: { type: "inline_text", text: SOURCE_TEXT },
        sortIndex: 0,
      },
    ]);
    row = created;
  });

  test("omits the sampling temperature for thinking-by-default models", async () => {
    // Anthropic 400s the whole row ("temperature may only be set to 1 when
    // thinking is enabled or in adaptive mode") if the executor pins 0.
    vi.mocked(resolveAgentLlmOrDefault).mockResolvedValueOnce({
      provider: "anthropic",
      modelName: "claude-sonnet-5",
      apiKey: "sk-ant-test",
      baseUrl: null,
      chatApiKeyId: "key-row-1",
    } as Awaited<ReturnType<typeof resolveAgentLlmOrDefault>>);
    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({
        effective_date: { value: "2026-01-01", quote: "effective 2026-01-01" },
        has_sso: { value: "yes", quote: "SSO is supported via SAML" },
      }),
    );

    await executeRow({ analysis, row, columns });

    expect(generateTaggedText).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: undefined }),
    );
  });

  test("keeps temperature 0 for conventional models", async () => {
    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({
        effective_date: { value: "2026-01-01", quote: "effective 2026-01-01" },
        has_sso: { value: "yes", quote: "SSO is supported via SAML" },
      }),
    );

    await executeRow({ analysis, row, columns });

    expect(generateTaggedText).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0 }),
    );
  });

  test("routes a Responses-API-only model by its catalogued surface", async () => {
    // GitHub Copilot's codex models reject /chat/completions; which surface a
    // model needs lives on the synced model row. Without this lookup the run
    // fails with "model … is not accessible via the /chat/completions
    // endpoint" while the same model works in chat.
    vi.mocked(resolveAgentLlmOrDefault).mockResolvedValueOnce({
      provider: "github-copilot",
      modelName: "gpt-5.3-codex",
      apiKey: "gho_test",
      baseUrl: null,
      chatApiKeyId: "key-row-1",
    } as Awaited<ReturnType<typeof resolveAgentLlmOrDefault>>);
    await ModelModel.create({
      externalId: "github-copilot/gpt-5.3-codex",
      provider: "github-copilot",
      modelId: "gpt-5.3-codex",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedEndpoints: ["/responses"],
    });
    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({
        effective_date: { value: "2026-01-01", quote: "effective 2026-01-01" },
        has_sso: { value: "yes", quote: "SSO is supported via SAML" },
      }),
    );

    await executeRow({ analysis, row, columns });

    expect(createLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        modelName: "gpt-5.3-codex",
        supportedEndpoints: ["/responses"],
      }),
    );
  });

  test("answers every column from one model call", async () => {
    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({
        effective_date: {
          value: "2026-01-01",
          quote: "effective 2026-01-01",
        },
        has_sso: { value: "yes", quote: "SSO is supported via SAML" },
      }),
    );

    const { outcomes } = await executeRow({ analysis, row, columns });

    // One call, not one per column — that is the efficiency the row-shaped unit
    // of work exists for.
    expect(generateTaggedText).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);

    const date = outcomes.find((o) => o.columnKey === "effective_date");
    expect(date?.ok && date.content).toBe("2026-01-01");
    expect(date?.ok && date.citations).toEqual([
      { quote: "effective 2026-01-01" },
    ]);
  });

  test("attributes the spend to the batch analysis source", async () => {
    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({
        effective_date: { value: "N/A", quote: null },
        has_sso: { value: "no", quote: null },
      }),
    );

    await executeRow({ analysis, row, columns });

    expect(createLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "batch_analysis:cell",
        // Forwarding the key row id is what stops a rotating subscription
        // credential from being burned on redemption.
        chatApiKeyId: "key-row-1",
      }),
    );
  });

  test("fails only the columns the model omitted", async () => {
    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({ effective_date: { value: "2026-01-01", quote: null } }),
    );

    const { outcomes } = await executeRow({ analysis, row, columns });

    const date = outcomes.find((o) => o.columnKey === "effective_date");
    const sso = outcomes.find((o) => o.columnKey === "has_sso");
    // A partially useful response stays partially useful.
    expect(date?.ok).toBe(true);
    expect(sso?.ok).toBe(false);
    expect(sso?.ok === false && sso.error).toContain(
      "did not return an answer",
    );
  });

  test("drops a quote that does not appear in the source", async () => {
    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({
        effective_date: {
          value: "2026-01-01",
          quote: "This sentence was never in the document.",
        },
        has_sso: { value: "yes", quote: null },
      }),
    );

    const { outcomes } = await executeRow({ analysis, row, columns });

    const date = outcomes.find((o) => o.columnKey === "effective_date");
    // The answer survives; the fabricated citation does not.
    expect(date?.ok).toBe(true);
    expect(date?.ok && date.content).toBe("2026-01-01");
    expect(date?.ok && date.citations).toBeNull();
  });

  test("treats an exact_quote answer as its own citation, and grounds it", async () => {
    const quoteColumns: BatchAnalysisColumn[] = [
      {
        key: "sso_clause",
        name: "SSO clause",
        prompt: "Quote the SSO clause",
        format: "exact_quote",
      },
    ];

    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({
        sso_clause: { value: "SSO is supported via SAML", quote: null },
      }),
    );

    const { outcomes } = await executeRow({
      analysis,
      row,
      columns: quoteColumns,
    });

    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[0].ok && outcomes[0].citations).toEqual([
      { quote: "SSO is supported via SAML" },
    ]);
  });

  test("drops an exact_quote citation the source does not contain", async () => {
    const quoteColumns: BatchAnalysisColumn[] = [
      {
        key: "sso_clause",
        name: "SSO clause",
        prompt: "Quote the SSO clause",
        format: "exact_quote",
      },
    ];

    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({
        sso_clause: { value: "SSO is mandatory for all tiers", quote: null },
      }),
    );

    const { outcomes } = await executeRow({
      analysis,
      row,
      columns: quoteColumns,
    });

    expect(outcomes[0].ok && outcomes[0].citations).toBeNull();
  });

  test("reports a parse failure across every requested column", async () => {
    vi.mocked(generateTaggedText).mockResolvedValue("not json at all");

    const { outcomes } = await executeRow({ analysis, row, columns });

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => !o.ok)).toBe(true);
  });

  test("reports an unusable model result rather than throwing", async () => {
    vi.mocked(generateTaggedText).mockResolvedValue(null);

    const { outcomes } = await executeRow({ analysis, row, columns });

    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(outcomes[0].ok === false && outcomes[0].error).toContain(
      "did not return a usable result",
    );
  });

  test("converts a thrown model error into failed cells, never a throw", async () => {
    vi.mocked(generateTaggedText).mockRejectedValue(new Error("upstream 500"));

    // This is the contract that keeps runs from hanging: the handler must be
    // able to record an outcome and advance the run's counter no matter what
    // the provider did.
    const { outcomes } = await executeRow({ analysis, row, columns });

    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(outcomes[0].ok === false && outcomes[0].error).toContain(
      "upstream 500",
    );
  });

  test("does not call the model when the source has no text", async () => {
    const [emptyRow] = await BatchAnalysisModel.addRows(analysis.id, [
      {
        label: "Empty",
        source: { type: "inline_text", text: "   " },
        sortIndex: 1,
      },
    ]);

    const { outcomes } = await executeRow({ analysis, row: emptyRow, columns });

    expect(generateTaggedText).not.toHaveBeenCalled();
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    // An empty source is an ingestion problem worth surfacing, not something to
    // spend tokens asking a model about.
    expect(outcomes[0].ok === false && outcomes[0].error).toContain(
      "no extractable text",
    );
  });

  test("does not call the model when no API key is configured", async () => {
    vi.mocked(isApiKeyRequired).mockReturnValue(true);

    const { outcomes } = await executeRow({ analysis, row, columns });

    expect(generateTaggedText).not.toHaveBeenCalled();
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(outcomes[0].ok === false && outcomes[0].error).toContain(
      "No API key configured",
    );
  });

  test("reports a soft-deleted agent instead of falling back to some other model", async () => {
    // Agents are soft-deleted, so the FK never fires and the analysis outlives
    // the configuration it depends on. Silently resolving some other model would
    // spend money under a configuration nobody chose.
    await AgentModel.delete(analysis.agentId);

    const { outcomes } = await executeRow({ analysis, row, columns });

    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(outcomes[0].ok === false && outcomes[0].error).toContain(
      "agent no longer exists",
    );
  });

  test("returns nothing to do when there are no columns", async () => {
    const { outcomes } = await executeRow({ analysis, row, columns: [] });
    expect(outcomes).toEqual([]);
    expect(generateTaggedText).not.toHaveBeenCalled();
  });
});
