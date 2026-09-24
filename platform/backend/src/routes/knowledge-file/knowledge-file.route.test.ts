import { HttpResponse, http } from "msw";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { KnowledgeBaseModel, OrganizationModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { makeTestPdf } from "@/test/pdf";
import type { User } from "@/types";

const textFile = (body: string) =>
  Buffer.from(body, "utf-8").toString("base64");

/** `initialGrants` that share a file with everyone in the organization. */
const everyone = [
  {
    subject: { type: "organization", id: "*" },
    actions: ["read", "use"],
  },
];

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
      // With no `initialGrants` the uploader alone reads the file, and the
      // response's audience fields say so.
      expect(response.json()).toMatchObject({
        filename: "policy.txt",
        visibility: "private",
        teamIds: [],
        knowledgeBases: [],
      });
      // The response must never carry the bytes.
      expect(response.json()).not.toHaveProperty("data");
    });

    test("stores labels supplied during upload", async () => {
      const response = await upload({
        labels: [{ key: "region", value: "eu" }],
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().labels).toEqual([
        expect.objectContaining({ key: "region", value: "eu" }),
      ]);

      const listed = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });
      expect(listed.json().data[0].labels).toEqual([
        expect.objectContaining({ key: "region", value: "eu" }),
      ]);
    });

    /**
     * The whole point of parsing before storing: an unreadable file that lands
     * in the repository looks uploaded but retrieves nothing, and the user only
     * finds out when an answer comes back empty.
     */
    test("refuses the retired visibility and team fields", async () => {
      for (const retired of [
        { visibility: "org-wide" },
        { teamIds: [crypto.randomUUID()] },
      ]) {
        const response = await upload(retired);
        expect(response.statusCode).toBe(400);
      }
      expect(await db.select().from(schema.kbFilesTable)).toHaveLength(0);
    });

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
      const uploaded = await upload({ filename: "personal-notes.txt" });
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
      const uploaded = await upload();
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

    test("a file shared with the organization is visible to a colleague", async ({
      makeUser,
      makeMember,
    }) => {
      await makeMember(user.id, organizationId, { role: "admin" });
      await upload({ initialGrants: everyone });

      const colleague = await makeUser({ email: "teammate@test.com" });
      await makeMember(colleague.id, organizationId);
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
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      // Sharing with a team is a delegation the uploader must be allowed to
      // make, so the uploader is an administrator here.
      await makeMember(user.id, organizationId, { role: "admin" });
      const team = await makeTeam(organizationId, user.id, {
        name: "Security",
      });
      const member = await makeUser({ email: "member@test.com" });
      await makeTeamMember(team.id, member.id);
      const outsider = await makeUser({ email: "outsider@test.com" });

      // The grant decides who lists the file and who retrieves it.
      const uploaded = await upload({
        filename: "soc2-report.txt",
        initialGrants: [
          { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
        ],
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

    test("editing a team-shared file without touching teams keeps its team audience", async ({
      makeMember,
      makeTeam,
    }) => {
      await makeMember(user.id, organizationId, { role: "admin" });
      const team = await makeTeam(organizationId, user.id, { name: "Legal" });
      const uploaded = await upload({
        filename: "retainer.txt",
        initialGrants: [
          { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
        ],
      });
      const fileId = uploaded.json().id;

      // The PATCH the edit dialog sends: name, directory and labels only.
      // The audience comes from the grants, which a rename does not touch.
      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/knowledge-files/${fileId}`,
        payload: { filename: "retainer-2026.txt" },
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

  describe("retired audience fields", () => {
    // These fields only wrote the retired column and team rows; a file's
    // grants decide who reads and retrieves it. They are refused, not dropped.
    test("editing a file refuses visibility and teams and changes nothing", async () => {
      const fileId = (await upload({ filename: "kept.txt" })).json().id;
      for (const retired of [
        { visibility: "private" },
        { teamIds: [crypto.randomUUID()] },
      ]) {
        const response = await app.inject({
          method: "PATCH",
          url: `/api/knowledge-files/${fileId}`,
          payload: { filename: "renamed.txt", ...retired },
        });
        expect(response.statusCode).toBe(400);
      }
      const [stored] = await db.select().from(schema.kbFilesTable);
      expect(stored.filename).toBe("kept.txt");
    });

    test("creating or editing a directory refuses visibility and teams", async () => {
      for (const retired of [
        { visibility: "private" },
        { teamIds: [crypto.randomUUID()] },
      ]) {
        const created = await app.inject({
          method: "POST",
          url: "/api/knowledge-directories",
          payload: { name: "Refused", ...retired },
        });
        expect(created.statusCode).toBe(400);
      }
      expect(await db.select().from(schema.kbDirectoriesTable)).toHaveLength(0);

      const directoryId = (
        await app.inject({
          method: "POST",
          url: "/api/knowledge-directories",
          payload: { name: "Contracts" },
        })
      ).json().id;
      const edited = await app.inject({
        method: "PATCH",
        url: `/api/knowledge-directories/${directoryId}`,
        payload: { name: "Vendor contracts", visibility: "team-scoped" },
      });
      expect(edited.statusCode).toBe(400);
      const [stored] = await db.select().from(schema.kbDirectoriesTable);
      expect(stored.name).toBe("Contracts");
    });

    test("the bulk audience endpoints for files and directories are gone", () => {
      for (const url of [
        "/api/knowledge-files/bulk",
        "/api/knowledge-directories/bulk",
      ]) {
        expect(app.hasRoute({ method: "PATCH", url })).toBe(false);
        expect(app.hasRoute({ method: "DELETE", url })).toBe(true);
      }
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

    async function configureOcr(fixtures: {
      makeSecret: (over: object) => Promise<{ id: string }>;
      makeLlmProviderApiKey: (
        organizationId: string,
        secretId: string,
        overrides: { name: string; provider: "anthropic" },
      ) => Promise<{ id: string }>;
    }) {
      const { makeSecret, makeLlmProviderApiKey } = fixtures;
      const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
      const key = await makeLlmProviderApiKey(organizationId, secret.id, {
        name: "Vision Key",
        provider: "anthropic",
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
      makeLlmProviderApiKey,
    }) => {
      await configureOcr({ makeSecret, makeLlmProviderApiKey });
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
      makeLlmProviderApiKey,
    }) => {
      await configureOcr({ makeSecret, makeLlmProviderApiKey });
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
    test("hides restricted knowledge bases on readable files and denies indexing into them", async ({
      makeTeam,
      makeUser,
    }) => {
      const fileId = (await upload()).json().id;
      const indexed = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: {
          fileIds: [fileId],
          newKnowledgeBaseName: "Restricted handbook",
        },
      });
      expect(indexed.statusCode).toBe(200);
      const knowledgeBaseId = indexed.json().knowledgeBaseId;
      const team = await makeTeam(organizationId, (await makeUser()).id);
      await KnowledgeBaseModel.update(knowledgeBaseId, {
        visibility: "team-scoped",
        teamIds: [team.id],
      });
      const listed = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });
      expect(listed.statusCode).toBe(200);
      expect(
        listed.json().data.find((file: { id: string }) => file.id === fileId),
      ).toMatchObject({ knowledgeBases: [] });
      const denied = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: { fileIds: [fileId], knowledgeBaseId },
      });
      expect(denied.statusCode).toBe(404);
    });

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
      // owned by the permission-sync pass. No `initialGrants`: the uploader's
      // own grant is the only audience.
      expect(documents[0].acl).toEqual([`user_email:${user.email}`]);

      const links = await db.select().from(schema.kbFileDocumentsTable);
      expect(links).toHaveLength(1);
    });

    // The indexed documents' audience is the file's grants, never wider:
    // the team it is shared with and the uploader, not the organization.
    test("a new file's documents reach only the file's grant holders", async ({
      makeMember,
      makeTeam,
    }) => {
      await makeMember(user.id, organizationId, { role: "admin" });
      const team = await makeTeam(organizationId, user.id, { name: "Audit" });
      const uploaded = await upload({
        initialGrants: [
          { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
        ],
      });
      const fileId = uploaded.json().id;

      const response = await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: { fileIds: [fileId], newKnowledgeBaseName: "Audit" },
      });
      expect(response.json()).toMatchObject({ indexed: 1, failures: [] });

      const [document] = await db.select().from(schema.kbDocumentsTable);
      expect([...document.acl].sort()).toEqual(
        [`team:${team.id}`, `user_email:${user.email}`].sort(),
      );
      const chunks = await db.select().from(schema.kbChunksTable);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) expect(chunk.acl).toEqual(document.acl);
    });

    // Editing the file's permissions re-writes its documents' audience, so a
    // revocation reaches retrieval too.
    test("editing a file's grants rewrites its documents' audience", async ({
      makeMember,
      makeTeam,
    }) => {
      await makeMember(user.id, organizationId, { role: "admin" });
      const team = await makeTeam(organizationId, user.id, { name: "Ops" });
      const fileId = (
        await upload({
          initialGrants: [
            {
              subject: { type: "team", id: team.id },
              actions: ["read", "use"],
            },
          ],
        })
      ).json().id;
      await app.inject({
        method: "POST",
        url: "/api/knowledge-files/index",
        payload: { fileIds: [fileId], newKnowledgeBaseName: "Ops" },
      });

      const { ResourcePermissions } = await import(
        "@/services/resource-permissions"
      );
      const { default: ResourcePermissionPolicyModel } = await import(
        "@/models/resource-permission-policy"
      );
      const policy = await ResourcePermissionPolicyModel.find({
        organizationId,
        resource: "knowledgeFile",
        scope: fileId,
      });
      await ResourcePermissions.updatePolicy({
        organizationId,
        userId: user.id,
        resource: "knowledgeFile",
        scope: fileId,
        revision: policy?.revision ?? 0,
        grants: (policy?.grants ?? []).filter(
          (grant) => grant.subject.type !== "team",
        ),
      });

      const [document] = await db.select().from(schema.kbDocumentsTable);
      expect(document.acl).toEqual([`user_email:${user.email}`]);
      const chunks = await db.select().from(schema.kbChunksTable);
      for (const chunk of chunks)
        expect(chunk.acl).toEqual([`user_email:${user.email}`]);
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
      makeMember,
      makeUser,
    }) => {
      const directory = await app.inject({
        method: "POST",
        url: "/api/knowledge-directories",
        payload: { name: "Mixed" },
      });
      const directoryId = directory.json().id;

      await makeMember(user.id, organizationId, { role: "admin" });
      await upload({
        filename: "shared.txt",
        directoryId,
        initialGrants: everyone,
      });
      await upload({ filename: "secret.txt", directoryId });

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

/**
 * The repository is admin-relevant state: who added, renamed, exposed, or
 * removed a document is exactly what the org audit log exists to answer.
 * These tests pin the registry wiring end to end — action names, resource
 * ids, and non-empty before/after diffs.
 */
describe("knowledge file audit records", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    const actor = await makeUser();
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = actor;
    });
    registerAuditLogHook(app);
    const { default: knowledgeFileRoutes } = await import(
      "./knowledge-file.routes"
    );
    await app.register(knowledgeFileRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  // Audit rows are written fire-and-forget from the onResponse hook.
  const settleAuditWrites = () =>
    new Promise((resolve) => setTimeout(resolve, 50));

  async function auditRows(resourceType: string) {
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType,
      sortDirection: "asc",
      limit: 50,
      offset: 0,
    });
    return data;
  }

  test("the file lifecycle writes created/updated/deleted records with diffs", async () => {
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: {
        filename: "policy.txt",
        mimeType: "text/plain",
        content: textFile("Data is stored in eu-west-1."),
      },
    });
    const fileId = uploaded.json().id;
    await app.inject({
      method: "PATCH",
      url: `/api/knowledge-files/${fileId}`,
      payload: { filename: "renamed.txt" },
    });
    await app.inject({
      method: "DELETE",
      url: `/api/knowledge-files/${fileId}`,
    });
    await settleAuditWrites();

    const rows = await auditRows("knowledgeFile");
    expect(rows.map((row) => [row.action, row.outcome])).toEqual([
      ["knowledgeFile.created", "success"],
      ["knowledgeFile.updated", "success"],
      ["knowledgeFile.deleted", "success"],
    ]);
    for (const row of rows) expect(row.resourceId).toBe(fileId);

    const [created, updated, deleted] = rows;
    // Snapshots carry metadata, never the file bytes.
    expect(created.after).toMatchObject({ filename: "policy.txt" });
    expect(created.after).not.toHaveProperty("data");
    expect(updated.before).toMatchObject({ filename: "policy.txt" });
    expect(updated.after).toMatchObject({ filename: "renamed.txt" });
    expect(deleted.before).toMatchObject({ filename: "renamed.txt" });
  });

  test("the directory lifecycle writes created/updated/deleted records with diffs", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/knowledge-directories",
      payload: { name: "Contracts" },
    });
    const directoryId = created.json().id;
    await app.inject({
      method: "PATCH",
      url: `/api/knowledge-directories/${directoryId}`,
      payload: { name: "Vendor contracts" },
    });
    await app.inject({
      method: "DELETE",
      url: `/api/knowledge-directories/${directoryId}`,
    });
    await settleAuditWrites();

    const rows = await auditRows("knowledgeDirectory");
    expect(rows.map((row) => [row.action, row.resourceId])).toEqual([
      ["knowledgeDirectory.created", directoryId],
      ["knowledgeDirectory.updated", directoryId],
      ["knowledgeDirectory.deleted", directoryId],
    ]);
    expect(rows[1].before).toMatchObject({ name: "Contracts" });
    expect(rows[1].after).toMatchObject({ name: "Vendor contracts" });
  });

  test("indexing writes a knowledgeBase.updated record naming the base and files", async () => {
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: {
        filename: "policy.txt",
        mimeType: "text/plain",
        content: textFile("Data is stored in eu-west-1."),
      },
    });
    const fileId = uploaded.json().id;
    const response = await app.inject({
      method: "POST",
      url: "/api/knowledge-files/index",
      payload: { fileIds: [fileId], newKnowledgeBaseName: "Vendor review" },
    });
    const knowledgeBaseId = response.json().knowledgeBaseId;
    await settleAuditWrites();

    const rows = await auditRows("knowledgeBase");
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("knowledgeBase.updated");
    expect(rows[0].resourceId).toBe(knowledgeBaseId);
    // The handler-supplied post-state names the base, the files, and whether
    // the base was created by this call.
    expect(rows[0].after).toMatchObject({
      knowledgeBaseId,
      createdKnowledgeBase: true,
      fileIds: [fileId],
      indexed: 1,
      failures: [],
    });
  });
});
