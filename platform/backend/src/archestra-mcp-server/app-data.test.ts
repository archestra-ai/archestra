// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  getArchestraToolFullName,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
} from "@archestra/shared";
import { beforeEach, describe, expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

function archestraError(result: { structuredContent?: unknown }): any {
  return (result.structuredContent as any)?.archestraError;
}

const setTool = getArchestraToolFullName(TOOL_APP_DATA_SET_SHORT_NAME);
const deleteTool = getArchestraToolFullName(TOOL_APP_DATA_DELETE_SHORT_NAME);

describe("app data store typed errors", () => {
  let context: ArchestraContext;

  beforeEach(async ({ makeApp, makeUser, makeMember }) => {
    const app = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, app.organizationId, { role: "member" });
    context = {
      agent: { id: "app-runtime", name: "app" },
      organizationId: app.organizationId,
      userId: user.id,
      appId: app.id,
    };
  });

  test("a revision conflict surfaces archestraError type conflict in both channels", async () => {
    await executeArchestraTool(
      setTool,
      { key: "k", value: 1, scope: "app" },
      context,
    );

    const conflict = await executeArchestraTool(
      setTool,
      { key: "k", value: 2, scope: "app", expectedRevision: 99 },
      context,
    );

    expect(conflict.isError).toBe(true);
    expect(archestraError(conflict)?.type).toBe("conflict");
    expect((conflict as any)._meta?.archestraError?.type).toBe("conflict");
  });

  test("insert-if-absent conflict on an existing key surfaces type conflict", async () => {
    await executeArchestraTool(
      setTool,
      { key: "k", value: 1, scope: "app" },
      context,
    );

    const conflict = await executeArchestraTool(
      setTool,
      { key: "k", value: 2, scope: "app", expectedRevision: 0 },
      context,
    );

    expect(conflict.isError).toBe(true);
    expect(archestraError(conflict)?.type).toBe("conflict");
  });

  test("writing/deleting another user's owned shared key surfaces type forbidden", async ({
    makeUser,
    makeMember,
  }) => {
    // owner claims the shared key
    await executeArchestraTool(
      setTool,
      { key: "owned", value: "mine", scope: "app", claimOwner: true },
      context,
    );

    // a different member (non-author, non-admin) cannot overwrite or delete it
    const other = await makeUser();
    await makeMember(other.id, context.organizationId as string, {
      role: "member",
    });
    const otherContext = { ...context, userId: other.id };

    const write = await executeArchestraTool(
      setTool,
      { key: "owned", value: "theirs", scope: "app" },
      otherContext,
    );
    expect(write.isError).toBe(true);
    expect(archestraError(write)?.type).toBe("forbidden");
    expect((write as any)._meta?.archestraError?.type).toBe("forbidden");

    const del = await executeArchestraTool(
      deleteTool,
      { key: "owned", scope: "app" },
      otherContext,
    );
    expect(del.isError).toBe(true);
    expect(archestraError(del)?.type).toBe("forbidden");
  });

  test("the app author may override another user's owned shared key", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const author = await makeUser();
    const authoredApp = await makeApp({ authorId: author.id });
    await makeMember(author.id, authoredApp.organizationId, { role: "member" });

    const owner = await makeUser();
    await makeMember(owner.id, authoredApp.organizationId, { role: "member" });

    const ownerContext: ArchestraContext = {
      agent: { id: "app-runtime", name: "app" },
      organizationId: authoredApp.organizationId,
      userId: owner.id,
      appId: authoredApp.id,
    };
    const authorContext: ArchestraContext = {
      ...ownerContext,
      userId: author.id,
    };

    await executeArchestraTool(
      setTool,
      { key: "owned", value: "owner's", scope: "app", claimOwner: true },
      ownerContext,
    );

    const overridden = await executeArchestraTool(
      setTool,
      { key: "owned", value: "author's", scope: "app" },
      authorContext,
    );
    expect(overridden.isError).toBe(false);
    expect((overridden.structuredContent as any).owner).toBe(owner.id);
  });
});
