import config from "@/config";
import { retrievalEvaluationService } from "@/services/retrieval-evaluation";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

describe("retrievalEvaluationService", () => {
  let originalEvaluationEnabled: boolean;
  let originalHybridSearchEnabled: boolean;

  beforeEach(() => {
    originalEvaluationEnabled = config.kb.evaluationEnabled;
    originalHybridSearchEnabled = config.kb.hybridSearchEnabled;
    config.kb.evaluationEnabled = true;
  });

  afterEach(() => {
    config.kb.evaluationEnabled = originalEvaluationEnabled;
    config.kb.hybridSearchEnabled = originalHybridSearchEnabled;
  });
  test("persists a blocked artifact when the live organization has no embedding pair", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const run = await retrievalEvaluationService.startRun({
      organizationId: organization.id,
      userId: user.id,
      queryLimit: 10,
      components: ["text-embedding"],
    });

    await retrievalEvaluationService.executeRun(run.id);

    const completed = await retrievalEvaluationService.getRun({
      organizationId: organization.id,
      id: run.id,
    });
    expect(completed).toMatchObject({
      status: "blocked",
      stage: "completed",
      fixtureKnowledgeBaseId: null,
      fixtureConnectorId: null,
    });
    expect(completed?.artifact).toMatchObject({
      schemaVersion: 2,
      status: "blocked",
    });
    expect(completed?.artifact?.skippedQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "text-semantic",
          component: "text-embedding",
        }),
      ]),
    );
    expect(
      completed?.artifact?.skippedQueries.filter(
        (query) => query.component === "text-embedding",
      ),
    ).toHaveLength(6);
  });

  test("compares two persisted terminal artifacts", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const before = await retrievalEvaluationService.startRun({
      organizationId: organization.id,
      userId: user.id,
      name: "Before",
      queryLimit: 10,
      components: ["text-embedding"],
    });
    await retrievalEvaluationService.executeRun(before.id);
    const after = await retrievalEvaluationService.startRun({
      organizationId: organization.id,
      userId: user.id,
      name: "After",
      queryLimit: 10,
      components: ["text-embedding"],
    });
    await retrievalEvaluationService.executeRun(after.id);

    const comparison = await retrievalEvaluationService.compare({
      organizationId: organization.id,
      beforeId: before.id,
      afterId: after.id,
    });
    expect(comparison).toMatchObject({
      a: { name: "Before" },
      b: { name: "After" },
      fingerprintMismatch: [],
    });
  });

  test("defaults only never-tested or changed component configurations", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const initial = await retrievalEvaluationService.getCapabilities({
      organizationId: organization.id,
    });
    expect(
      initial.components.find((component) => component.id === "chunking"),
    ).toMatchObject({ mode: "offline", selectedByDefault: true });
    expect(
      initial.components.find(
        (component) => component.id === "keyword-ranking",
      ),
    ).toMatchObject({ mode: "offline", selectedByDefault: true });
    expect(
      initial.components.find((component) => component.id === "text-embedding"),
    ).toMatchObject({
      status: "disabled",
      changedSinceLastEvaluation: true,
      selectedByDefault: false,
    });

    const run = await retrievalEvaluationService.startRun({
      organizationId: organization.id,
      userId: user.id,
      queryLimit: 10,
      components: ["chunking", "keyword-ranking"],
    });
    await retrievalEvaluationService.executeRun(run.id);

    const unchanged = await retrievalEvaluationService.getCapabilities({
      organizationId: organization.id,
    });
    expect(
      unchanged.components.find((component) => component.id === "chunking"),
    ).toMatchObject({
      selectedByDefault: false,
      changedSinceLastEvaluation: false,
      lastRunId: run.id,
    });
    expect(
      unchanged.components.find(
        (component) => component.id === "keyword-ranking",
      ),
    ).toMatchObject({
      selectedByDefault: false,
      changedSinceLastEvaluation: false,
      lastRunId: run.id,
    });

    const { default: OrganizationModel } = await import(
      "@/models/organization"
    );
    await OrganizationModel.patch(organization.id, { kbBm25K1: 2.1 });
    const changed = await retrievalEvaluationService.getCapabilities({
      organizationId: organization.id,
    });
    expect(
      changed.components.find(
        (component) => component.id === "keyword-ranking",
      ),
    ).toMatchObject({
      selectedByDefault: true,
      changedSinceLastEvaluation: true,
    });
    expect(
      changed.components.find((component) => component.id === "chunking"),
    ).toMatchObject({
      selectedByDefault: false,
      changedSinceLastEvaluation: false,
    });
  });

  test("reports only the requirements that are actually missing", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const embeddingMissing = await retrievalEvaluationService.getCapabilities({
      organizationId: organization.id,
    });
    expect(
      embeddingMissing.components.find(
        (component) => component.id === "hybrid-retrieval",
      ),
    ).toMatchObject({
      detail: "Configure a valid text embedding key and model.",
    });

    config.kb.hybridSearchEnabled = false;
    const embeddingAndDeploymentMissing =
      await retrievalEvaluationService.getCapabilities({
        organizationId: organization.id,
      });
    expect(
      embeddingAndDeploymentMissing.components.find(
        (component) => component.id === "keyword-ranking",
      ),
    ).toMatchObject({
      detail:
        "Ask a platform operator to enable hybrid search for this deployment.",
    });
    expect(
      embeddingAndDeploymentMissing.components.find(
        (component) => component.id === "hybrid-retrieval",
      ),
    ).toMatchObject({
      detail:
        "Configure a valid text embedding key and model. Ask a platform operator to enable hybrid search for this deployment.",
    });
  });

  test("persists run-only BM25 and contextual settings without changing the organization", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const { default: OrganizationModel } = await import(
      "@/models/organization"
    );
    await OrganizationModel.patch(organization.id, {
      kbBm25K1: 1.5,
      kbBm25B: 0.3,
      kbContextualRetrievalMode: "disabled",
    });
    const user = await makeUser();
    const run = await retrievalEvaluationService.startRun({
      organizationId: organization.id,
      userId: user.id,
      queryLimit: 10,
      components: ["keyword-ranking"],
      settingsOverrides: {
        bm25K1: 0.6,
        bm25B: 0.35,
        contextualRetrievalMode: "chunk",
      },
    });
    expect(run.settingsOverrides).toEqual({
      bm25K1: 0.6,
      bm25B: 0.35,
      contextualRetrievalMode: "chunk",
    });

    await retrievalEvaluationService.executeRun(run.id);
    const completed = await retrievalEvaluationService.getRun({
      organizationId: organization.id,
      id: run.id,
    });
    expect(completed?.artifact?.fingerprint.effectiveConfig).toMatchObject({
      bm25K1: 0.6,
      bm25B: 0.35,
      contextualRetrievalMode: "chunk",
      contextualRetrievalEnabled: true,
    });

    expect(await OrganizationModel.getById(organization.id)).toMatchObject({
      kbBm25K1: 1.5,
      kbBm25B: 0.3,
      kbContextualRetrievalMode: "disabled",
    });
  });

  test("resolves run-only embedding and reranking models without saving them", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const { default: LlmProviderApiKeyModel } = await import(
      "@/models/llm-provider-api-key"
    );
    const key = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      name: "Evaluation key",
      provider: "ollama",
      secretId: null,
      scope: "org",
      userId: null,
      teamId: null,
    });
    const settingsOverrides = {
      embedding: { chatApiKeyId: key.id, model: "nomic-embed-text" },
      reranker: { chatApiKeyId: key.id, model: "test-chat-model" },
      contextualRetrievalMode: "document" as const,
    };
    const preview = await retrievalEvaluationService.getCapabilities({
      organizationId: organization.id,
      userId: user.id,
      settingsOverrides,
    });
    expect(
      preview.components.find((component) => component.id === "text-embedding"),
    ).toMatchObject({ status: "active" });
    expect(
      preview.components.find((component) => component.id === "reranking"),
    ).toMatchObject({ status: "active" });
    expect(
      preview.components.find(
        (component) => component.id === "contextual-retrieval",
      ),
    ).toMatchObject({ status: "active" });
    const run = await retrievalEvaluationService.startRun({
      organizationId: organization.id,
      userId: user.id,
      queryLimit: 10,
      components: ["keyword-ranking"],
      settingsOverrides,
    });
    expect(run.settingsOverrides).toMatchObject(settingsOverrides);

    await retrievalEvaluationService.executeRun(run.id);
    const completed = await retrievalEvaluationService.getRun({
      organizationId: organization.id,
      id: run.id,
    });
    expect(completed?.artifact?.fingerprint).toMatchObject({
      embedding: { provider: "ollama", model: "nomic-embed-text" },
      reranker: { provider: "ollama", model: "test-chat-model" },
    });
    const { default: OrganizationModel } = await import(
      "@/models/organization"
    );
    expect(await OrganizationModel.getById(organization.id)).toMatchObject({
      embeddingChatApiKeyId: null,
      embeddingModel: null,
      rerankerChatApiKeyId: null,
      rerankerModel: null,
    });
  });

  test("rejects temporary API keys the requesting user cannot access", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const requester = await makeUser();
    const { default: LlmProviderApiKeyModel } = await import(
      "@/models/llm-provider-api-key"
    );
    const privateKey = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      name: "Private evaluation key",
      provider: "ollama",
      secretId: null,
      scope: "personal",
      userId: owner.id,
      teamId: null,
    });

    await expect(
      retrievalEvaluationService.startRun({
        organizationId: organization.id,
        userId: requester.id,
        queryLimit: 10,
        components: ["keyword-ranking"],
        settingsOverrides: {
          embedding: {
            chatApiKeyId: privateKey.id,
            model: "nomic-embed-text",
          },
        },
      }),
    ).rejects.toThrow("unavailable to this user");
  });

  test("fails queued beta work if the deployment disables the gate", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const run = await retrievalEvaluationService.startRun({
      organizationId: organization.id,
      userId: user.id,
      queryLimit: 10,
      components: ["chunking"],
    });
    config.kb.evaluationEnabled = false;

    await retrievalEvaluationService.executeRun(run.id);

    expect(
      await retrievalEvaluationService.getRun({
        organizationId: organization.id,
        id: run.id,
      }),
    ).toMatchObject({
      status: "failed",
      error: "Knowledge configuration evaluation beta is disabled",
    });
  });
});
