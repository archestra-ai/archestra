import type { APIRequestContext } from "@playwright/test";
import {
  getE2eRequestUrl,
  LLM_PROVIDER_API_KEYS_ROUTE,
  UI_BASE_URL,
  WIREMOCK_INTERNAL_URL,
} from "../consts";
import { goToPage } from "../fixtures";
import { expect, test } from "./api-fixtures";

const EMBEDDING_API_KEY = "sk-e2e-embedding-fail-401";
const EMBEDDING_KEY_NAME = "e2e-embedding-fail-401";
const EMBEDDING_MODEL = "text-embedding-3-small";

const ACTIVE_EMBEDDING_STATUSES = new Set(["pending", "processing"]);
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

test.describe("Connector files — embedding error badge", () => {
  test.setTimeout(60_000);

  let embeddingKeyId: string;
  let knowledgeBaseId: string;
  let connectorId: string;

  test.beforeEach(
    async ({
      request,
      createKnowledgeBase,
      createConnector,
      updateKnowledgeSettings,
      syncModels,
    }) => {
      const dropRes = await request.post(
        getE2eRequestUrl("/api/organization/knowledge-settings/drop-embedding"),
        { headers: { Origin: UI_BASE_URL } },
      );
      if (!dropRes.ok() && dropRes.status() !== 400) {
        throw new Error(
          `drop-embedding failed: ${dropRes.status()} ${await dropRes.text()}`,
        );
      }

      const keyResponse = await request.post(
        getE2eRequestUrl(LLM_PROVIDER_API_KEYS_ROUTE),
        {
          headers: { "Content-Type": "application/json", Origin: UI_BASE_URL },
          data: {
            name: EMBEDDING_KEY_NAME,
            provider: "openai",
            apiKey: EMBEDDING_API_KEY,
            scope: "org",
            baseUrl: `${WIREMOCK_INTERNAL_URL}/openai/v1`,
          },
        },
      );

      if (!keyResponse.ok()) {
        throw new Error(
          `Failed to create embedding API key: ${keyResponse.status()} ${await keyResponse.text()}`,
        );
      }

      const key = await keyResponse.json();
      embeddingKeyId = key.id;

      await syncModels(request);

      await updateKnowledgeSettings(request, {
        embeddingModel: EMBEDDING_MODEL,
        embeddingChatApiKeyId: embeddingKeyId,
      });

      const kbResponse = await createKnowledgeBase(request);
      const kb = await kbResponse.json();
      knowledgeBaseId = kb.id;

      const connectorResponse = await createConnector(
        request,
        knowledgeBaseId,
        "e2e-embedding-error-connector",
        {
          connectorType: "file_upload",
          config: { type: "file_upload" },
        },
      );
      const connector = await connectorResponse.json();
      connectorId = connector.id;

      await uploadTextFile(request, connectorId, "sample.txt", "Hello world");

      await pollUntilEmbeddingSettled(request, connectorId);
    },
  );

  test.afterEach(async ({ request, deleteConnector, deleteKnowledgeBase }) => {
    await request
      .post(
        getE2eRequestUrl("/api/organization/knowledge-settings/drop-embedding"),
        { headers: { Origin: UI_BASE_URL } },
      )
      .catch(() => {});

    if (connectorId) {
      await deleteConnector(request, knowledgeBaseId, connectorId);
    }

    if (knowledgeBaseId) {
      await deleteKnowledgeBase(request, knowledgeBaseId);
    }

    if (embeddingKeyId) {
      await request
        .delete(
          getE2eRequestUrl(`${LLM_PROVIDER_API_KEYS_ROUTE}/${embeddingKeyId}`),
          { headers: { Origin: UI_BASE_URL } },
        );
    }
  });

  test("Failed badge shows tooltip with the embedding error reason", async ({
    page,
  }) => {
    await goToPage(page, `/knowledge/connectors/${connectorId}`);

    const failedBadge = page.getByText("Failed").first();
    await expect(failedBadge).toBeVisible({ timeout: 10_000 });

    await failedBadge.hover();

    await expect(page.getByRole("tooltip")).toContainText(
      "Unauthorized. Check API key",
    );
  });
});

async function uploadTextFile(
  request: APIRequestContext,
  connectorId: string,
  filename: string,
  content: string,
): Promise<void> {
  const response = await request.post(
    getE2eRequestUrl(`/api/connectors/${connectorId}/files`),
    {
      headers: { "Content-Type": "application/json", Origin: UI_BASE_URL },
      data: {
        files: [
          {
            name: filename,
            mimeType: "text/plain",
            content: Buffer.from(content).toString("base64"),
          },
        ],
      },
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Failed to upload file: ${response.status()} ${await response.text()}`,
    );
  }
}

async function pollUntilEmbeddingSettled(
  request: APIRequestContext,
  connectorId: string,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await request.get(
      getE2eRequestUrl(`/api/connectors/${connectorId}/files`),
      { headers: { Origin: UI_BASE_URL } },
    );

    if (response.ok()) {
      const body = await response.json();
      const files: Array<{ embeddingStatus: string }> = body.data ?? [];

      if (
        files.length > 0 &&
        files.every((f) => !ACTIVE_EMBEDDING_STATUSES.has(f.embeddingStatus))
      ) {
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Embedding status did not settle within ${POLL_TIMEOUT_MS}ms for connector ${connectorId}`,
  );
}
