import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { fileStore } from "@/skills-sandbox/file-store";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { App, User } from "@/types";

describe("GET /api/apps/:appId/files/raw", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let agentId: string;
  let user: User;
  let ownedApp: App;
  let conversationId: string;

  beforeEach(
    async ({ makeAgent, makeUser, makeMember, makeApp, makeConversation }) => {
      // The file surface is gated on the sandbox flag; config is restored
      // pristine before every test, so this is per test.
      (config.skillsSandbox as { enabled: boolean }).enabled = true;

      const agent = await makeAgent();
      agentId = agent.id;
      organizationId = agent.organizationId;
      user = await makeUser();
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

      ownedApp = await makeApp({ organizationId });
      const conversation = await makeConversation(agentId, {
        userId: user.id,
        organizationId,
      });
      conversationId = conversation.id;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (
          request as typeof request & { organizationId: string; user: User }
        ).organizationId = organizationId;
        (request as typeof request & { user: User }).user = user;
      });
      const { default: appRoutes } = await import("./app.routes");
      await app.register(appRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  async function putConversationFile(params: {
    filename: string;
    data: Buffer;
    mimeType?: string;
    userId?: string;
  }) {
    await fileStore.put({
      organizationId,
      userId: params.userId ?? user.id,
      projectId: null,
      conversationId,
      filename: params.filename,
      mimeType: params.mimeType ?? "application/octet-stream",
      sizeBytes: params.data.byteLength,
      data: params.data,
    });
  }

  const rawUrl = (query: Record<string, string>) =>
    `/api/apps/${ownedApp.id}/files/raw?${new URLSearchParams(query)}`;

  test("streams a binary file's exact bytes with metadata headers", async () => {
    // NUL bytes and an invalid-UTF-8 sequence: bytes the model-facing file
    // tools refuse as text.
    const binary = Buffer.from([
      0x00, 0xff, 0xfe, 0x80, 0x53, 0x54, 0x4c, 0x00,
    ]);
    await putConversationFile({ filename: "model.stl", data: binary });

    const response = await app.inject({
      method: "GET",
      url: rawUrl({ conversationId, filename: "model.stl" }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(binary)).toBe(true);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["x-archestra-file-mime"]).toBe(
      "application/octet-stream",
    );
    expect(
      decodeURIComponent(String(response.headers["x-archestra-file-name"])),
    ).toBe("model.stl");
    expect(String(response.headers["x-archestra-file-id"])).not.toBe("");
  });

  test("refuses when the sandbox flag is dark", async () => {
    await putConversationFile({
      filename: "notes.txt",
      data: Buffer.from("hello"),
      mimeType: "text/plain",
    });
    (config.skillsSandbox as { enabled: boolean }).enabled = false;

    const response = await app.inject({
      method: "GET",
      url: rawUrl({ conversationId, filename: "notes.txt" }),
    });
    expect(response.statusCode).toBe(403);
  });

  test("404s a conversation the viewer cannot access", async ({
    makeUser,
    makeMember,
    makeConversation,
  }) => {
    const stranger = await makeUser();
    await makeMember(stranger.id, organizationId, { role: ADMIN_ROLE_NAME });
    const foreign = await makeConversation(agentId, {
      userId: stranger.id,
      organizationId,
    });

    const response = await app.inject({
      method: "GET",
      url: rawUrl({ conversationId: foreign.id, filename: "notes.txt" }),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Conversation");
  });

  test("404s a missing file", async () => {
    const response = await app.inject({
      method: "GET",
      url: rawUrl({ conversationId, filename: "no-such-file.bin" }),
    });
    expect(response.statusCode).toBe(404);
  });

  test("rejects a query with neither or both of id and filename", async () => {
    const neither = await app.inject({
      method: "GET",
      url: rawUrl({ conversationId }),
    });
    expect(neither.statusCode).toBe(400);

    const both = await app.inject({
      method: "GET",
      url: rawUrl({ conversationId, id: "x", filename: "y" }),
    });
    expect(both.statusCode).toBe(400);
  });
});
