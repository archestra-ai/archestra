import {
  getArchestraToolFullName,
  TOOL_COPY_FILE_SHORT_NAME,
  TOOL_SAVE_FILE_SHORT_NAME,
  TOOL_SEARCH_FILES_SHORT_NAME,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { ConversationAttachmentModel, ConversationModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { executeArchestraTool } from "./index";
import type { ArchestraContext } from "./types";

/** PGlite returns bytea as Uint8Array; decode uniformly. */
const decode = (data: Uint8Array | null | undefined) =>
  data == null ? undefined : Buffer.from(data).toString("utf8");

const COPY_FILE = getArchestraToolFullName(TOOL_COPY_FILE_SHORT_NAME);
const SAVE_FILE = getArchestraToolFullName(TOOL_SAVE_FILE_SHORT_NAME);
const SEARCH_FILES = getArchestraToolFullName(TOOL_SEARCH_FILES_SHORT_NAME);

// copy_file is the one sanctioned bridge across the app namespace's hermetic
// boundary: agent-side only, keyed off the access-verified openedAppId, never
// off a tool argument. These tests pin every decision-#3 behaviour: both
// directions, the attachment source, per-viewer isolation, the no-open-app and
// headless refusals, overwrite semantics, and that a copy never moves the
// source.
describe("copy_file", () => {
  let context: ArchestraContext;
  let organizationId: string;
  let userId: string;
  let appId: string;
  let conversationId: string;
  let originalEnabled: boolean;

  beforeEach(async ({ makeAgent, makeUser, makeMember, makeApp }) => {
    originalEnabled = config.skillsSandbox.enabled;
    config.skillsSandbox.enabled = true;
    const agent = await makeAgent({ name: "Copy Agent" });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId, { role: "member" });
    const app = await makeApp({ organizationId: agent.organizationId });
    organizationId = agent.organizationId;
    userId = user.id;
    appId = app.id;
    const conversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: agent.id,
      title: "Copy Test",
    });
    conversationId = conversation.id;
    context = {
      agent: { id: agent.id, name: agent.name },
      organizationId,
      userId,
      conversationId,
      openedAppId: appId,
    };
  });

  afterEach(() => {
    config.skillsSandbox.enabled = originalEnabled;
  });

  async function saveInto(
    ctx: ArchestraContext,
    filename: string,
    content: string,
  ) {
    const result = await executeArchestraTool(
      SAVE_FILE,
      { filename, content },
      ctx,
    );
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
  }

  function appRuntimeCtx(): ArchestraContext {
    // How the app MCP proxy dispatches: appId bound, no conversation.
    return { agent: { id: appId, name: "app" }, organizationId, userId, appId };
  }

  async function fileRows(filename: string) {
    return db
      .select()
      .from(schema.filesTable)
      .where(eq(schema.filesTable.filename, filename));
  }

  test("copies a chat file into the open app's per-viewer store, without moving the source", async () => {
    await saveInto(context, "input.stl", "solid gear");
    const result = await executeArchestraTool(
      COPY_FILE,
      {
        from: { type: "chat_file", filename: "input.stl" },
        to: { scope: "app" },
      },
      context,
    );
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect(result.structuredContent).toMatchObject({
      destination: "app",
      filename: "input.stl",
      overwritten: false,
    });

    const rows = await fileRows("input.stl");
    expect(rows).toHaveLength(2);
    const appRow = rows.find((row) => row.appId === appId);
    const chatRow = rows.find((row) => row.conversationId === conversationId);
    expect(appRow).toMatchObject({
      appId,
      userId,
      conversationId: null,
      projectId: null,
    });
    expect(chatRow).toMatchObject({ appId: null, conversationId });
    expect(decode(appRow?.data)).toBe("solid gear");
  });

  test("copies a file the app produced out into the chat's files", async () => {
    await saveInto(appRuntimeCtx(), "report.csv", "a,b\n1,2");
    const result = await executeArchestraTool(
      COPY_FILE,
      {
        from: { type: "app_file", filename: "report.csv" },
        to: { scope: "chat" },
      },
      context,
    );
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect(result.structuredContent).toMatchObject({
      destination: "conversation",
    });
    const rows = await fileRows("report.csv");
    const chatRow = rows.find((row) => row.conversationId === conversationId);
    expect(chatRow).toMatchObject({ appId: null, userId });
    expect(decode(chatRow?.data)).toBe("a,b\n1,2");
    // The app's own copy is untouched.
    expect(rows.find((row) => row.appId === appId)).toBeDefined();
  });

  test("copies a chat attachment into the app; a foreign conversation's attachment is refused", async ({
    makeAgent,
  }) => {
    const attachment = await ConversationAttachmentModel.create({
      organizationId,
      conversationId,
      uploadedByUserId: userId,
      originalName: "model.stl",
      mimeType: "model/stl",
      fileSize: 9,
      contentHash: "hash-1",
      fileData: Buffer.from("solid att"),
    });
    const result = await executeArchestraTool(
      COPY_FILE,
      {
        from: { type: "chat_attachment", attachmentId: attachment.id },
        to: { scope: "app" },
      },
      context,
    );
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const rows = await fileRows("model.stl");
    expect(decode(rows.find((row) => row.appId === appId)?.data)).toBe(
      "solid att",
    );

    // Same attachment addressed from a different conversation: refused with
    // the same conversation-binding rule upload_file enforces.
    const otherAgent = await makeAgent({ organizationId });
    const otherConversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: otherAgent.id,
      title: "Other",
    });
    const foreign = await executeArchestraTool(
      COPY_FILE,
      {
        from: { type: "chat_attachment", attachmentId: attachment.id },
        to: { scope: "app" },
      },
      { ...context, conversationId: otherConversation.id },
    );
    expect(foreign.isError).toBe(true);
    expect(JSON.stringify(foreign.content)).toContain("different conversation");
  });

  test("refuses when no app is open, and in headless runs", async () => {
    await saveInto(context, "x.txt", "x");
    const noApp = await executeArchestraTool(
      COPY_FILE,
      { from: { type: "chat_file", filename: "x.txt" }, to: { scope: "app" } },
      { ...context, openedAppId: undefined },
    );
    expect(noApp.isError).toBe(true);
    expect(JSON.stringify(noApp.content)).toContain("No app is open");

    const headless = await executeArchestraTool(
      COPY_FILE,
      { from: { type: "chat_file", filename: "x.txt" }, to: { scope: "app" } },
      { ...context, conversationId: undefined },
    );
    expect(headless.isError).toBe(true);
    expect(JSON.stringify(headless.content)).toContain("no chat conversation");
  });

  test("rejects a copy where no side (or both sides) is the app", async () => {
    const chatToChat = await executeArchestraTool(
      COPY_FILE,
      { from: { type: "chat_file", filename: "x" }, to: { scope: "chat" } },
      context,
    );
    expect(chatToChat.isError).toBe(true);
    expect(JSON.stringify(chatToChat.content)).toContain(
      "exactly one side must be the app",
    );
    const appToApp = await executeArchestraTool(
      COPY_FILE,
      { from: { type: "app_file", filename: "x" }, to: { scope: "app" } },
      context,
    );
    expect(appToApp.isError).toBe(true);
  });

  test("duplicate destination name errors; to.overwrite replaces in place keeping the id", async () => {
    await saveInto(context, "doc.md", "v1");
    const first = await executeArchestraTool(
      COPY_FILE,
      { from: { type: "chat_file", filename: "doc.md" }, to: { scope: "app" } },
      context,
    );
    expect(first.isError).toBe(false);
    const firstId = (first.structuredContent as { fileId: string }).fileId;

    const dup = await executeArchestraTool(
      COPY_FILE,
      { from: { type: "chat_file", filename: "doc.md" }, to: { scope: "app" } },
      context,
    );
    expect(dup.isError).toBe(true);
    expect(JSON.stringify(dup.content)).toContain("already exists");

    await saveInto({ ...context }, "doc2.md", "v2");
    const replaced = await executeArchestraTool(
      COPY_FILE,
      {
        from: { type: "chat_file", filename: "doc2.md" },
        to: { scope: "app", filename: "doc.md", overwrite: true },
      },
      context,
    );
    expect(replaced.isError, JSON.stringify(replaced.content)).toBe(false);
    expect(replaced.structuredContent).toMatchObject({
      overwritten: true,
      fileId: firstId,
    });
    const rows = await fileRows("doc.md");
    expect(decode(rows.find((row) => row.appId === appId)?.data)).toBe("v2");
  });

  test("a stringified arg with a semantic error surfaces the semantic error, not the string one", async () => {
    // A model that always stringifies unions AND picked the wrong variant must
    // see the actual problem (one side must be the app) — the pre-repair
    // "expected object, received string" would trap it in a retry loop.
    const result = await executeArchestraTool(
      COPY_FILE,
      {
        from: JSON.stringify({ type: "app_file", filename: "x.stl" }),
        to: { scope: "app" },
      },
      context,
    );
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("exactly one side must be the app");
    expect(text).not.toContain("received string");
  });

  test("copies an attachment selected by filename; latest attachment of that name wins", async () => {
    await ConversationAttachmentModel.create({
      organizationId,
      conversationId,
      uploadedByUserId: userId,
      originalName: "bit.stl",
      mimeType: "model/stl",
      fileSize: 8,
      contentHash: "hash-v1",
      fileData: Buffer.from("solid v1"),
    });
    await ConversationAttachmentModel.create({
      organizationId,
      conversationId,
      uploadedByUserId: userId,
      originalName: "bit.stl",
      mimeType: "model/stl",
      fileSize: 8,
      contentHash: "hash-v2",
      fileData: Buffer.from("solid v2"),
    });
    const result = await executeArchestraTool(
      COPY_FILE,
      {
        from: { type: "chat_attachment", filename: "bit.stl" },
        to: { scope: "app" },
      },
      context,
    );
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const rows = await fileRows("bit.stl");
    expect(decode(rows.find((row) => row.appId === appId)?.data)).toBe(
      "solid v2",
    );

    const missing = await executeArchestraTool(
      COPY_FILE,
      {
        from: { type: "chat_attachment", filename: "nope.stl" },
        to: { scope: "app" },
      },
      context,
    );
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("No attachment named");
  });

  test("accepts JSON-stringified object arguments (small-model compat), but not garbage strings", async () => {
    await saveInto(context, "strung.txt", "payload");
    // Some models JSON-encode union-typed nested objects as strings; the
    // validator reparses exactly the failing keys and re-validates.
    const result = await executeArchestraTool(
      COPY_FILE,
      {
        from: JSON.stringify({ type: "chat_file", filename: "strung.txt" }),
        to: JSON.stringify({ scope: "app" }),
      },
      context,
    );
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const rows = await fileRows("strung.txt");
    expect(decode(rows.find((row) => row.appId === appId)?.data)).toBe(
      "payload",
    );

    const garbage = await executeArchestraTool(
      COPY_FILE,
      { from: "not json at all", to: { scope: "app" } },
      context,
    );
    expect(garbage.isError).toBe(true);
    expect(JSON.stringify(garbage.content)).toContain("Validation error");
  });

  test("the app store stays per-viewer: another member cannot copy out a file they don't own", async ({
    makeUser,
    makeMember,
  }) => {
    await saveInto(appRuntimeCtx(), "private.txt", "mine");
    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId, { role: "member" });
    const otherConversation = await ConversationModel.create({
      userId: otherUser.id,
      organizationId,
      agentId: context.agent.id,
      title: "Other viewer",
    });
    const result = await executeArchestraTool(
      COPY_FILE,
      {
        from: { type: "app_file", filename: "private.txt" },
        to: { scope: "chat" },
      },
      {
        ...context,
        userId: otherUser.id,
        conversationId: otherConversation.id,
      },
    );
    expect(result.isError).toBe(true);
  });

  // An app is opaque to the agent apart from its file store, and copying a
  // file OUT needs a name. Without a listing the model invents one — it
  // reaches for the file it copied IN — and copies out the wrong file while
  // reporting success. search_files with scope "app" is that listing.
  describe('search_files scope: "app"', () => {
    test("lists the open app's files, not the chat's", async () => {
      await saveInto(context, "chat-only.txt", "chat");
      await saveInto(appRuntimeCtx(), "made-by-app.stl", "solid app");

      const appListing = await executeArchestraTool(
        SEARCH_FILES,
        { scope: "app" },
        context,
      );
      expect(appListing.isError, JSON.stringify(appListing.content)).toBe(
        false,
      );
      expect(
        (
          appListing.structuredContent as { files: { filename: string }[] }
        ).files.map((f) => f.filename),
      ).toEqual(["made-by-app.stl"]);

      // Default scope stays the chat's files.
      const chatListing = await executeArchestraTool(SEARCH_FILES, {}, context);
      expect(
        (
          chatListing.structuredContent as { files: { filename: string }[] }
        ).files.map((f) => f.filename),
      ).toEqual(["chat-only.txt"]);
    });

    test("refuses when no app is open instead of falling back to chat files", async () => {
      await saveInto(context, "chat-only.txt", "chat");
      const result = await executeArchestraTool(
        SEARCH_FILES,
        { scope: "app" },
        { ...context, openedAppId: undefined },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("No app is open");
    });

    test("an app runtime stays confined to its own store even asking for chat scope", async () => {
      await saveInto(context, "chat-only.txt", "chat");
      await saveInto(appRuntimeCtx(), "made-by-app.stl", "solid app");
      const result = await executeArchestraTool(
        SEARCH_FILES,
        { scope: "chat" },
        appRuntimeCtx(),
      );
      expect(
        (
          result.structuredContent as { files: { filename: string }[] }
        ).files.map((f) => f.filename),
      ).toEqual(["made-by-app.stl"]);
    });
  });
});
