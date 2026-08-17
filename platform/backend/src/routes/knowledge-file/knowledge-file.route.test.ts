import { HttpResponse, http } from "msw";
import db, { schema } from "@/database";
import { LlmProviderApiKeyModel, OrganizationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { makeTestPdf } from "@/test/pdf";
import type { User } from "@/types";

const textFile = (body: string) =>
  Buffer.from(body, "utf-8").toString("base64");

describe("knowledge file routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  async function bootAs(actor: User, orgId: string) {
    if (app) await app.close();
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = orgId;
      (request as typeof request & { user: User }).user = actor;
    });
    const { default: knowledgeFileRoutes } = await import(
      "./knowledge-file.routes"
    );
    await app.register(knowledgeFileRoutes);
  }

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await bootAs(user, organizationId);
  });

  afterEach(async () => {
    await app.close();
  });

  async function upload(overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: {
        filename: "policy.txt",
        mimeType: "text/plain",
        content: textFile("Data is stored in eu-west-1."),
        ...overrides,
      },
    });
  }

  describe("upload", () => {
    test("stores a readable document", async () => {
      const response = await upload();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        filename: "policy.txt",
        visibility: "org-wide",
        knowledgeBases: [],
      });
      // The response must never carry the bytes.
      expect(response.json()).not.toHaveProperty("data");
    });

    /**
     * The whole point of parsing before storing: an unreadable file that lands
     * in the repository looks uploaded but retrieves nothing, and the user only
     * finds out when an answer comes back empty.
     */
    test("rejects a file it cannot read, and stores nothing", async () => {
      const response = await upload({
        filename: "archive.zip",
        mimeType: "application/zip",
        content: textFile("PK not really"),
      });
      expect(response.statusCode).toBe(400);

      const stored = await db.select().from(schema.kbFilesTable);
      expect(stored).toHaveLength(0);
    });

    test("rejects a directory from another organization", async ({
      makeOrganization,
      makeUser,
    }) => {
      const otherOrg = await makeOrganization();
      const outsider = await makeUser();
      await bootAs(outsider, otherOrg.id);
      const created = await app.inject({
        method: "POST",
        url: "/api/knowledge-directories",
        payload: { name: "Theirs" },
      });
      const foreignDirectoryId = created.json().id;

      await bootAs(user, organizationId);
      const response = await upload({ directoryId: foreignDirectoryId });
      // A foreign key cannot express organization ownership, so this is the
      // check that stops a cross-organization association.
      expect(response.statusCode).toBe(404);
    });
  });

  describe("listing visibility", () => {
    test("a private file is invisible to everyone but its uploader", async ({
      makeUser,
    }) => {
      const uploaded = await upload({
        filename: "personal-notes.txt",
        visibility: "private",
      });
      expect(uploaded.statusCode).toBe(200);

      const mine = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });
      expect(mine.json().data).toHaveLength(1);

      const colleague = await makeUser({ email: "colleague@test.com" });
      await bootAs(colleague, organizationId);
      const theirs = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });
      expect(theirs.json().data).toHaveLength(0);
      // Pagination has to agree with the filter, or the UI shows a count for
      // rows the caller can never see.
      expect(theirs.json().pagination.total).toBe(0);
    });

    test("downloading someone else's private file is a 404", async ({
      makeUser,
    }) => {
      const uploaded = await upload({ visibility: "private" });
      const fileId = uploaded.json().id;

      const colleague = await makeUser({ email: "other@test.com" });
      await bootAs(colleague, organizationId);
      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-files/${fileId}/content`,
      });
      // Retrieval ACLs are enforced at chunk-query time and do nothing for a
      // direct byte read, so this route authorizes per row itself.
      expect(response.statusCode).toBe(404);
    });

    test("an org-wide file is visible to a colleague", async ({ makeUser }) => {
      await upload({ visibility: "org-wide" });

      const colleague = await makeUser({ email: "teammate@test.com" });
      await bootAs(colleague, organizationId);
      const response = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });
      expect(response.json().data).toHaveLength(1);
    });
  });

  describe("team-scoped visibility", () => {
    test("a team-scoped file is visible to team members and invisible to others", async ({
      makeUser,
      makeTeam,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, user.id, {
        name: "Security",
      });
      const member = await makeUser({ email: "member@test.com" });
      await makeTeamMember(team.id, member.id);
      const outsider = await makeUser({ email: "outsider@test.com" });

      const uploaded = await upload({
        filename: "soc2-report.txt",
        visibility: "team-scoped",
        teamIds: [team.id],
      });
      expect(uploaded.statusCode).toBe(200);
      const fileId = uploaded.json().id;

      await bootAs(member, organizationId);
      const asMember = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });
      expect(asMember.json().data).toHaveLength(1);

      await bootAs(outsider, organizationId);
      const asOutsider = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });
      expect(asOutsider.json().data).toHaveLength(0);

      // Content, too: the EXISTS team-membership subquery guards the byte
      // route the same way it guards the listing.
      const content = await app.inject({
        method: "GET",
        url: `/api/knowledge-files/${fileId}/content`,
      });
      expect(content.statusCode).toBe(404);
    });

    test("editing a team-scoped file without touching teams keeps its team audience", async ({
      makeTeam,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, user.id, { name: "Legal" });
      // The fixture does not auto-add the creator; a team-scoped file is
      // visible only to members, its uploader included.
      await makeTeamMember(team.id, user.id);
      const uploaded = await upload({
        filename: "retainer.txt",
        visibility: "team-scoped",
        teamIds: [team.id],
      });
      const fileId = uploaded.json().id;

      // The PATCH the edit dialog sends when only the name changed: the
      // seeded team list rides along unchanged.
      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/knowledge-files/${fileId}`,
        payload: {
          filename: "retainer-2026.txt",
          visibility: "team-scoped",
          teamIds: [team.id],
        },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().teamIds).toEqual([team.id]);

      const listed = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });
      expect(listed.json().data[0].teamIds).toEqual([team.id]);
    });
  });

  describe("directories", () => {
    test("deleting a directory keeps its files, at the root", async () => {
      const directory = await app.inject({
        method: "POST",
        url: "/api/knowledge-directories",
        payload: { name: "Contracts" },
      });
      const directoryId = directory.json().id;

      const uploaded = await upload({ directoryId });
      expect(uploaded.statusCode).toBe(200);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/knowledge-directories/${directoryId}`,
      });
      expect(deleted.statusCode).toBe(200);

      const files = await db.select().from(schema.kbFilesTable);
      expect(files).toHaveLength(1);
      expect(files[0].directoryId).toBeNull();
    });

    test("two files may share a name in different directories but not at the root", async () => {
      const directory = await app.inject({
        method: "POST",
        url: "/api/knowledge-directories",
        payload: { name: "Vendors" },
      });

      expect((await upload({ filename: "terms.txt" })).statusCode).toBe(200);
      expect(
        (
          await upload({
            filename: "terms.txt",
            directoryId: directory.json().id,
          })
        ).statusCode,
      ).toBe(200);

      // Postgres treats NULL directory ids as distinct, so root uniqueness
      // needs its own partial index — without it this second root upload
      // would silently succeed.
      const duplicate = await upload({ filename: "terms.txt" });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().error.message).toContain("already exists");
    });
  });

  describe("scanned PDFs and OCR", () => {
    const server = useMswServer();

    async function configureOcr(
      makeSecret: (over: object) => Promise<{ id: string }>,
    ) {
      const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
      const key = await LlmProviderApiKeyModel.create({
        organizationId,
        name: "Vision Key",
        provider: "anthropic",
        secretId: secret.id,
        scope: "org",
        userId: null,
        teamId: null,
      });
      await OrganizationModel.patch(organizationId, {
        ocrChatApiKeyId: key.id,
        ocrModel: "claude-sonnet-5",
      });
    }

    const scannedUpload = () =>
      upload({
        filename: "signed-agreement.pdf",
        mimeType: "application/pdf",
        content: makeTestPdf([null]).toString("base64"),
      });

    test("rejects a scanned PDF upload when the organization has no OCR", async () => {
      const response = await scannedUpload();
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "no extractable text layer",
      );
    });

    test("accepts a scanned PDF and indexes its transcription when OCR is configured", async ({
      makeSecret,
    }) => {
      await configureOcr(makeSecret);
      // The vision model is the only fake — the real Anthropic adapter
      // serializes the one-page sub-PDF and MSW answers at the wire.
      server.use(
        http.post("https://api.anthropic.com/v1/messages", () =>
          HttpResponse.json({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [
              {
                type: "text",
                text: "SERVICE AGREEMENT — records retained for seven (7) years.",
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1500, output_tokens: 24 },
          }),
        ),
      );

      const uploaded = await scannedUpload();
      expect(uploaded.statusCode).toBe(200);
      const fileId = uploaded.json().id;

      const indexed = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: { fileIds: [fileId], newKnowledgeBaseName: "Contracts" },
      });
      expect(indexed.statusCode).toBe(200);
      expect(indexed.json()).toMatchObject({ indexed: 1, failures: [] });

      const documents = await db.select().from(schema.kbDocumentsTable);
      expect(documents).toHaveLength(1);
      expect(documents[0].content).toContain("retained for seven (7) years");
    });

    test("a scanned file fails indexing with a named reason when its transcription fails", async ({
      makeSecret,
    }) => {
      await configureOcr(makeSecret);
      server.use(
        http.post("https://api.anthropic.com/v1/messages", () =>
          HttpResponse.json(
            { error: { message: "no vision for you" } },
            { status: 500 },
          ),
        ),
      );

      const fileId = (await scannedUpload()).json().id;
      const indexed = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: { fileIds: [fileId], newKnowledgeBaseName: "Contracts" },
      });
      expect(indexed.statusCode).toBe(200);
      const body = indexed.json();
      expect(body.indexed).toBe(0);
      expect(body.failures).toHaveLength(1);
      expect(body.failures[0].error).toContain("OCR could not transcribe");
    });
  });

  describe("indexing", () => {
    test("creates a knowledge base from a selection and links the document", async () => {
      const uploaded = await upload();
      const fileId = uploaded.json().id;

      const response = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: { fileIds: [fileId], newKnowledgeBaseName: "Vendor review" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ indexed: 1, failures: [] });

      const documents = await db.select().from(schema.kbDocumentsTable);
      expect(documents).toHaveLength(1);
      expect(documents[0].content).toContain("eu-west-1");
      // Direct audience tokens, never a `container:` token — that table is
      // owned by the permission-sync pass.
      expect(documents[0].acl).toEqual(["org:*"]);

      const links = await db.select().from(schema.kbFileDocumentsTable);
      expect(links).toHaveLength(1);
    });

    test("re-indexing the same file refreshes rather than duplicates", async () => {
      const fileId = (await upload()).json().id;
      const payload = {
        fileIds: [fileId],
        newKnowledgeBaseName: "First",
      };
      const first = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload,
      });
      const knowledgeBaseId = first.json().knowledgeBaseId;

      await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: { fileIds: [fileId], knowledgeBaseId },
      });

      const documents = await db.select().from(schema.kbDocumentsTable);
      expect(documents).toHaveLength(1);
    });

    test("reuses one upload connector per knowledge base", async () => {
      const first = (await upload({ filename: "a.txt" })).json().id;
      const second = (await upload({ filename: "b.txt" })).json().id;

      const created = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: { fileIds: [first], newKnowledgeBaseName: "Shared" },
      });
      const knowledgeBaseId = created.json().knowledgeBaseId;

      await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: { fileIds: [second], knowledgeBaseId },
      });

      const uploadConnectors = await db
        .select()
        .from(schema.kbUploadConnectorsTable);
      expect(uploadConnectors).toHaveLength(1);
    });

    test("a directory selection only indexes files the caller can see", async ({
      makeUser,
    }) => {
      const directory = await app.inject({
        method: "POST",
        url: "/api/knowledge-directories",
        payload: { name: "Mixed" },
      });
      const directoryId = directory.json().id;

      await upload({ filename: "shared.txt", directoryId });
      await upload({
        filename: "secret.txt",
        directoryId,
        visibility: "private",
      });

      const colleague = await makeUser({ email: "limited@test.com" });
      await bootAs(colleague, organizationId);
      const response = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: {
          directoryIds: [directoryId],
          newKnowledgeBaseName: "Subset",
        },
      });

      expect(response.json().indexed).toBe(1);
      const documents = await db.select().from(schema.kbDocumentsTable);
      expect(documents.map((doc) => doc.title)).toEqual(["shared.txt"]);
    });

    test("rejects a knowledge base from another organization", async ({
      makeOrganization,
      makeUser,
    }) => {
      const fileId = (await upload()).json().id;

      const otherOrg = await makeOrganization();
      const outsider = await makeUser();
      await bootAs(outsider, otherOrg.id);
      const foreign = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: {
          fileIds: [],
          directoryIds: [],
          newKnowledgeBaseName: "Theirs",
        },
      });
      const foreignKnowledgeBaseId = foreign.json()?.knowledgeBaseId;

      await bootAs(user, organizationId);
      const response = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: { fileIds: [fileId], knowledgeBaseId: foreignKnowledgeBaseId },
      });
      expect([400, 404]).toContain(response.statusCode);
    });
  });
});
