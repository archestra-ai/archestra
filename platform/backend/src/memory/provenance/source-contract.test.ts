import { describe, expect, test } from "@/test";
import {
  buildChatExtractionSourceContract,
  buildIdempotencyKey,
  buildManualSourceContract,
  validateSourceContract,
} from "./source-contract";

describe("memory source contract", () => {
  test("validates chat contract requires conversationId", () => {
    expect(() =>
      validateSourceContract({
        sourceType: "chat",
        sourceId: "conversation-1",
        sourceMetadata: {
          origin: {},
          ingestion: { runId: "run-1" },
          actor: { kind: "system" },
          quality: {},
          safety: { policyFlags: [] },
          future: {
            projectId: null,
            workspaceId: null,
            sectionId: null,
          },
        },
      }),
    ).toThrow("chat source requires origin.conversationId");
  });

  test("buildManualSourceContract fills required metadata blocks", () => {
    const contract = buildManualSourceContract({
      requesterUserId: "user-1",
      scopeType: "user",
      scopeId: "user-1",
      policyFlags: ["instruction_like_medium"],
    });

    expect(contract.sourceType).toBe("manual");
    expect(contract.sourceId).toContain("manual:user-1:");
    expect(contract.sourceMetadata.actor).toMatchObject({
      kind: "user",
      userId: "user-1",
    });
    expect(contract.sourceMetadata.future).toEqual({
      projectId: null,
      workspaceId: null,
      sectionId: null,
    });
  });

  test("buildChatExtractionSourceContract keeps traceability fields", () => {
    const contract = buildChatExtractionSourceContract({
      conversationId: "conversation-uuid",
      messageIds: ["message-1"],
      runId: "chat_extract:run-1",
      idempotencyKey: "idem-1",
      dedupKey: "dedup-1",
      extractorVersion: "v1.0.0",
      policyFlags: [],
    });

    expect(contract.sourceType).toBe("chat");
    expect(contract.sourceId).toBe("conversation-uuid");
    expect(contract.sourceMetadata.origin).toMatchObject({
      conversationId: "conversation-uuid",
      messageIds: ["message-1"],
    });
    expect(contract.sourceMetadata.ingestion).toMatchObject({
      runId: "chat_extract:run-1",
      idempotencyKey: "idem-1",
      dedupKey: "dedup-1",
    });
  });

  test("buildIdempotencyKey is deterministic", () => {
    const keyA = buildIdempotencyKey(["a", "b", "c"]);
    const keyB = buildIdempotencyKey(["a", "b", "c"]);
    const keyC = buildIdempotencyKey(["a", "b", "different"]);

    expect(keyA).toBe(keyB);
    expect(keyA).not.toBe(keyC);
  });
});
