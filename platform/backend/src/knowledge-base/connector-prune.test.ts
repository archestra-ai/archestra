import { vi } from "vitest";

const mockGetConnector = vi.hoisted(() => vi.fn());
vi.mock("./connectors/registry", () => ({
  getConnector: mockGetConnector,
}));

const mockGetSecret = vi.hoisted(() => vi.fn());
vi.mock("@/secrets-manager", () => ({
  secretManager: () => ({
    getSecret: mockGetSecret,
  }),
}));

import db, { schema } from "@/database";
import {
  ConnectorRunModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { connectorPruneService } from "./connector-prune";

async function createSecret(): Promise<string> {
  const [secret] = await db
    .insert(schema.secretsTable)
    .values({ secret: { access_token: "test-secret" } })
    .returning();
  return secret.id;
}

function setupSecret(
  credentials = { email: "user@test.com", apiToken: "tok-123" },
) {
  mockGetSecret.mockResolvedValue({
    id: "secret-1",
    secret: credentials,
  });
}

describe("ConnectorPruneService", () => {
  test("hard deletes stale documents after full source enumeration", async ({
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "dropbox",
      config: { type: "dropbox" },
    });

    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });
    await KbDocumentModel.create({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "keep-me",
      title: "Keep Me",
      content: "content",
      contentHash: "hash-1",
    });
    const stale = await KbDocumentModel.create({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "delete-me",
      title: "Delete Me",
      content: "content",
      contentHash: "hash-2",
    });

    setupSecret();
    mockGetConnector.mockReturnValue({
      listAllSourceIds: vi.fn().mockImplementation(() =>
        (async function* () {
          yield ["keep-me"];
        })(),
      ),
    });

    const result = await connectorPruneService.executePrune(connector.id);

    expect(result.status).toBe("success");
    expect(result.prunedDocuments).toBe(1);
    expect(await KbDocumentModel.findById(stale.id)).toBeNull();
    expect(
      await KbDocumentModel.findBySourceId({
        connectorId: connector.id,
        sourceId: "keep-me",
      }),
    ).not.toBeNull();

    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.prunedDocuments).toBe(1);

    const updatedConnector = await KnowledgeBaseConnectorModel.findById(
      connector.id,
    );
    expect(updatedConnector?.lastPruneAt).toBeInstanceOf(Date);
  });
});