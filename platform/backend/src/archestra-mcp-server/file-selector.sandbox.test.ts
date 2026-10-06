import {
  getArchestraToolFullName,
  TOOL_DELETE_FILE_SHORT_NAME,
  TOOL_EDIT_FILE_SHORT_NAME,
  TOOL_READ_FILE_SHORT_NAME,
  TOOL_SAVE_FILE_SHORT_NAME,
} from "@archestra/shared";
import config from "@/config";
import { ConversationModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { executeArchestraTool } from "./index";
import type { ArchestraContext } from "./types";

const READ_FILE = getArchestraToolFullName(TOOL_READ_FILE_SHORT_NAME);
const SAVE_FILE = getArchestraToolFullName(TOOL_SAVE_FILE_SHORT_NAME);
const EDIT_FILE = getArchestraToolFullName(TOOL_EDIT_FILE_SHORT_NAME);
const DELETE_FILE = getArchestraToolFullName(TOOL_DELETE_FILE_SHORT_NAME);

// The file tools pick a file by `id` or by `filename`. Models that fill every
// declared field send a blank for the selector they do not mean.
describe("file tools: id or filename", () => {
  let context: ArchestraContext;
  let originalEnabled: boolean;

  beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
    originalEnabled = config.skillsSandbox.enabled;
    config.skillsSandbox.enabled = true;
    const agent = await makeAgent({ name: "File Agent" });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId, { role: "member" });
    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: agent.organizationId,
      agentId: agent.id,
      title: "File Test",
    });
    context = {
      agent: { id: agent.id, name: agent.name },
      organizationId: agent.organizationId,
      userId: user.id,
      conversationId: conversation.id,
    };
  });

  afterEach(() => {
    config.skillsSandbox.enabled = originalEnabled;
  });

  async function save(filename: string, content: string): Promise<string> {
    const result = await executeArchestraTool(
      SAVE_FILE,
      { filename, content },
      context,
    );
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    return (result.structuredContent as { fileId: string }).fileId;
  }

  const textOf = (result: { content: unknown[] }) =>
    (result.content[0] as { text: string }).text;

  test("read_file treats a blank selector as not given", async () => {
    const fileId = await save("notes.md", "first line");

    const byFilename = await executeArchestraTool(
      READ_FILE,
      { id: " ", filename: "notes.md", offset: 1, limit: 2000, project_id: "" },
      context,
    );
    expect(byFilename.isError, JSON.stringify(byFilename.content)).toBe(false);
    expect(byFilename.structuredContent).toMatchObject({ fileId });

    const byId = await executeArchestraTool(
      READ_FILE,
      { id: fileId, filename: "" },
      context,
    );
    expect(byId.isError, JSON.stringify(byId.content)).toBe(false);
    expect(byId.structuredContent).toMatchObject({ filename: "notes.md" });
  });

  test("edit_file and delete_file treat a blank id as not given", async () => {
    const fileId = await save("draft.md", "old text");

    const edited = await executeArchestraTool(
      EDIT_FILE,
      { id: "", filename: "draft.md", old_string: "old", new_string: "new" },
      context,
    );
    expect(edited.isError, JSON.stringify(edited.content)).toBe(false);
    expect(edited.structuredContent).toMatchObject({ fileId, replacements: 1 });

    const deleted = await executeArchestraTool(
      DELETE_FILE,
      { id: "  ", filename: "draft.md" },
      context,
    );
    expect(deleted.isError, JSON.stringify(deleted.content)).toBe(false);
    expect(deleted.structuredContent).toMatchObject({ fileId, deleted: true });
  });

  test("two real selectors are refused with a way out", async () => {
    await save("notes.md", "first line");

    const result = await executeArchestraTool(
      READ_FILE,
      { id: "notes.md", filename: "notes.md" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "provide exactly one of `id` or `filename`; leave the other out or empty",
    );
    expect(textOf(result)).toContain(
      "send only the parameters you need; none is required",
    );
  });

  test("no selector at all is still refused", async () => {
    const result = await executeArchestraTool(
      READ_FILE,
      { id: "", filename: " " },
      context,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "provide exactly one of `id` or `filename`",
    );
  });
});
