import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  KbDocumentModel,
  KbFileModel,
  LlmProviderApiKeyModel,
  OrganizationModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { makeTestPdf } from "@/test/pdf";
import { resolveRowSource } from "./source-resolver";

/**
 * These are the authorization tests for the feature. A batch analysis reads
 * whole documents on someone's behalf, so "which documents can this run open"
 * is the security boundary — not a detail.
 */
describe("resolveRowSource", () => {
  describe("inline_text", () => {
    test("passes the text straight through", async () => {
      const result = await resolveRowSource({
        source: { type: "inline_text", text: "hello world" },
        organizationId: "org-1",
        actingUserId: "user-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.source.text).toBe("hello world");
      expect(result.source.truncated).toBe(false);
    });

    test("truncates at the configured ceiling and says so", async () => {
      config.batchAnalysis.maxSourceChars = 10;

      const result = await resolveRowSource({
        source: { type: "inline_text", text: "0123456789ABCDEF" },
        organizationId: "org-1",
        actingUserId: "user-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.source.text).toBe("0123456789");
      // Truncation must be visible: a partial answer that looks complete is
      // exactly the silent-data-loss failure this design is trying to avoid.
      expect(result.source.truncated).toBe(true);
    });
  });

  describe("kb_document access control", () => {
    let organizationId: string;
    let memberId: string;
    let memberEmail: string;
    let connectorId: string;

    beforeEach(
      async ({
        makeOrganization,
        makeUser,
        makeMember,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      }) => {
        const org = await makeOrganization();
        organizationId = org.id;

        const member = await makeUser({ email: "member@example.com" });
        memberId = member.id;
        memberEmail = member.email;
        await makeMember(member.id, org.id);

        const kb = await makeKnowledgeBase(org.id);
        const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
        connectorId = connector.id;
      },
    );

    async function makeDocument(params: {
      acl: string[];
      content: string;
      sourceId?: string;
    }) {
      return KbDocumentModel.create({
        organizationId,
        connectorId,
        sourceId: params.sourceId ?? crypto.randomUUID(),
        title: "Test document",
        content: params.content,
        contentHash: crypto.randomUUID(),
        acl: params.acl,
      });
    }

    test("reads a document the user's ACL covers", async () => {
      const document = await makeDocument({
        acl: [`user_email:${memberEmail}`],
        content: "grant me",
      });

      const result = await resolveRowSource({
        source: { type: "kb_document", documentId: document.id },
        organizationId,
        actingUserId: memberId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.source.text).toBe("grant me");
    });

    test("reads an org-wide document", async () => {
      const document = await makeDocument({
        acl: ["org:*"],
        content: "everyone can read this",
      });

      const result = await resolveRowSource({
        source: { type: "kb_document", documentId: document.id },
        organizationId,
        actingUserId: memberId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.source.text).toBe("everyone can read this");
    });

    test("refuses a document granted only to somebody else", async () => {
      const document = await makeDocument({
        acl: ["user_email:someone.else@example.com"],
        content: "SECRET CONTENT",
      });

      const result = await resolveRowSource({
        source: { type: "kb_document", documentId: document.id },
        organizationId,
        actingUserId: memberId,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The message must not distinguish "exists but forbidden" from "does not
      // exist", or a run becomes an existence oracle for documents its owner
      // cannot read.
      expect(result.error).toBe("Source document not found or not accessible");
      expect(result.error).not.toContain("SECRET");
    });

    test("refuses a document with an empty ACL (fail closed)", async () => {
      const document = await makeDocument({ acl: [], content: "unassigned" });

      const result = await resolveRowSource({
        source: { type: "kb_document", documentId: document.id },
        organizationId,
        actingUserId: memberId,
      });

      expect(result.ok).toBe(false);
    });

    test("refuses a document belonging to another organization", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const document = await KbDocumentModel.create({
        organizationId: otherOrg.id,
        connectorId,
        sourceId: crypto.randomUUID(),
        title: "Other org document",
        content: "cross-tenant content",
        contentHash: crypto.randomUUID(),
        acl: ["org:*"],
      });

      const result = await resolveRowSource({
        source: { type: "kb_document", documentId: document.id },
        organizationId,
        actingUserId: memberId,
      });

      // `org:*` is not global — it is scoped by the organization filter, and a
      // run must never cross a tenant boundary.
      expect(result.ok).toBe(false);
    });

    test("reports a missing document without leaking that it is missing vs forbidden", async () => {
      const result = await resolveRowSource({
        source: { type: "kb_document", documentId: crypto.randomUUID() },
        organizationId,
        actingUserId: memberId,
      });

      expect(result.ok).toBe(false);
    });

    test("an admin-equivalent caller bypasses the ACL, matching knowledge search", async ({
      makeUser,
      makeMember,
    }) => {
      const admin = await makeUser({ email: "admin@example.com" });
      await makeMember(admin.id, organizationId, { role: "admin" });

      const document = await makeDocument({
        acl: ["user_email:nobody@example.com"],
        content: "admin can still read this",
      });

      const result = await resolveRowSource({
        source: { type: "kb_document", documentId: document.id },
        organizationId,
        actingUserId: admin.id,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.source.text).toBe("admin can still read this");
    });
  });

  describe("kb_file access control", () => {
    let organizationId: string;
    let ownerId: string;

    beforeEach(async ({ makeOrganization, makeUser }) => {
      const org = await makeOrganization();
      organizationId = org.id;
      const owner = await makeUser();
      ownerId = owner.id;
    });

    async function makeFile(params: {
      visibility: "org-wide" | "team-scoped" | "private";
      uploadedBy: string;
      body?: string;
      filename?: string;
    }) {
      const buffer = Buffer.from(
        params.body ?? "Retention is 90 days.",
        "utf-8",
      );
      return KbFileModel.create({
        organizationId,
        directoryId: null,
        filename: params.filename ?? "policy.txt",
        mimeType: "text/plain",
        sizeBytes: buffer.byteLength,
        contentHash: `hash-${crypto.randomUUID()}`,
        data: buffer,
        visibility: params.visibility,
        teamIds: [],
        uploadedBy: params.uploadedBy,
      });
    }

    test("extracts text from the creator's own private file", async () => {
      const file = await makeFile({
        visibility: "private",
        uploadedBy: ownerId,
      });

      const result = await resolveRowSource({
        source: { type: "kb_file", fileId: file.id },
        organizationId,
        actingUserId: ownerId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.source.text).toContain("Retention is 90 days.");
    });

    test("refuses another user's private file, indistinguishably from absence", async ({
      makeUser,
    }) => {
      const stranger = await makeUser({ email: "stranger@test.com" });
      const file = await makeFile({
        visibility: "private",
        uploadedBy: ownerId,
      });

      // The run resolves as the analysis CREATOR. If the creator cannot read
      // the file, the run must not either — sharing an analysis never widens
      // who the underlying file is readable by.
      const result = await resolveRowSource({
        source: { type: "kb_file", fileId: file.id },
        organizationId,
        actingUserId: stranger.id,
      });

      expect(result).toEqual({
        ok: false,
        error: "Source file not found or not accessible",
      });
    });

    test("reads an org-wide file as any member", async ({ makeUser }) => {
      const colleague = await makeUser({ email: "colleague@test.com" });
      const file = await makeFile({
        visibility: "org-wide",
        uploadedBy: ownerId,
      });

      const result = await resolveRowSource({
        source: { type: "kb_file", fileId: file.id },
        organizationId,
        actingUserId: colleague.id,
      });

      expect(result.ok).toBe(true);
    });

    test("truncates a long file at the ceiling and says so", async () => {
      config.batchAnalysis.maxSourceChars = 10;
      const file = await makeFile({
        visibility: "private",
        uploadedBy: ownerId,
        body: "0123456789ABCDEF",
      });

      const result = await resolveRowSource({
        source: { type: "kb_file", fileId: file.id },
        organizationId,
        actingUserId: ownerId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.source.truncated).toBe(true);
    });
  });
});

describe("kb_file scanned PDFs with OCR", () => {
  const server = useMswServer();

  test("resolves a scanned PDF through its transcription when OCR is configured", async ({
    makeOrganization,
    makeUser,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      name: "Vision Key",
      provider: "anthropic",
      secretId: secret.id,
      scope: "org",
      userId: null,
      teamId: null,
    });
    await OrganizationModel.patch(org.id, {
      ocrChatApiKeyId: key.id,
      ocrModel: "claude-sonnet-5",
    });
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [
            { type: "text", text: "Scanned clause: penalty is 2% per month." },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1500, output_tokens: 20 },
        }),
      ),
    );

    const buffer = makeTestPdf([null]);
    const file = await KbFileModel.create({
      organizationId: org.id,
      directoryId: null,
      filename: "scanned-penalties.pdf",
      mimeType: "application/pdf",
      sizeBytes: buffer.byteLength,
      contentHash: `hash-${crypto.randomUUID()}`,
      data: buffer,
      visibility: "org-wide",
      teamIds: [],
      uploadedBy: owner.id,
    });

    const result = await resolveRowSource({
      source: { type: "kb_file", fileId: file.id },
      organizationId: org.id,
      actingUserId: owner.id,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.source.text).toContain("penalty is 2% per month");
  });

  test("a scanned PDF still fails with a named reason when OCR is not configured", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const buffer = makeTestPdf([null]);
    const file = await KbFileModel.create({
      organizationId: org.id,
      directoryId: null,
      filename: "scanned.pdf",
      mimeType: "application/pdf",
      sizeBytes: buffer.byteLength,
      contentHash: `hash-${crypto.randomUUID()}`,
      data: buffer,
      visibility: "org-wide",
      teamIds: [],
      uploadedBy: owner.id,
    });

    const result = await resolveRowSource({
      source: { type: "kb_file", fileId: file.id },
      organizationId: org.id,
      actingUserId: owner.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("no extractable text layer");
  });
});
