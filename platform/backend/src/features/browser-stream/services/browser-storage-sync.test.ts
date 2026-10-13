import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { BrowserStorageStateModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import { browserStorageSync } from "./browser-storage-sync";

const SAVED_STATE = JSON.stringify({
  cookies: [{ name: "li_at", value: "secret", domain: ".linkedin.com" }],
  origins: [],
});

describe("browserStorageSync", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("restores the user's saved state into a new browser context", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    await BrowserStorageStateModel.upsert(user.id, SAVED_STATE);
    const client = fakePlaywrightClient();

    await browserStorageSync.ensureRestored({
      client: client.asClient,
      sessionId: crypto.randomUUID(),
      userId: user.id,
    });

    expect(client.codes).toHaveLength(1);
    expect(client.codes[0]).toContain("addCookies");
    expect(client.codes[0]).toContain('"li_at"');
  });

  test("restores each session once", async ({ makeUser }) => {
    const user = await makeUser();
    await BrowserStorageStateModel.upsert(user.id, SAVED_STATE);
    const client = fakePlaywrightClient();
    const target = {
      client: client.asClient,
      sessionId: crypto.randomUUID(),
      userId: user.id,
    };

    await browserStorageSync.ensureRestored(target);
    await browserStorageSync.ensureRestored(target);

    expect(client.codes).toHaveLength(1);
  });

  test("saves the context's state after a tool call", async ({ makeUser }) => {
    const user = await makeUser();
    const client = fakePlaywrightClient({ storageState: SAVED_STATE });
    const target = {
      client: client.asClient,
      sessionId: crypto.randomUUID(),
      userId: user.id,
    };

    await browserStorageSync.ensureRestored(target);
    browserStorageSync.scheduleSave(target);
    browserStorageSync.scheduleSave(target);
    await vi.runAllTimersAsync();

    expect(await BrowserStorageStateModel.get(user.id)).toBe(SAVED_STATE);
    // Debounced: two tool calls, one save
    expect(
      client.codes.filter((c) => c.includes("storageState()")),
    ).toHaveLength(1);
  });

  test("a context whose restore failed never overwrites the saved login", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    await BrowserStorageStateModel.upsert(user.id, SAVED_STATE);
    const client = fakePlaywrightClient({
      storageState: JSON.stringify({ cookies: [], origins: [] }),
      failRestore: true,
    });
    const target = {
      client: client.asClient,
      sessionId: crypto.randomUUID(),
      userId: user.id,
    };

    await browserStorageSync.ensureRestored(target);
    browserStorageSync.scheduleSave(target);
    await vi.runAllTimersAsync();

    expect(await BrowserStorageStateModel.get(user.id)).toBe(SAVED_STATE);
  });

  test("saved state is encrypted at rest", async ({ makeUser }) => {
    const user = await makeUser();
    await BrowserStorageStateModel.upsert(user.id, SAVED_STATE);

    const { default: db, schema } = await import("@/database");
    const [row] = await db.select().from(schema.browserStorageStatesTable);

    expect(JSON.stringify(row.encryptedState)).not.toContain("li_at");
    expect(await BrowserStorageStateModel.get(user.id)).toBe(SAVED_STATE);
  });
});

/**
 * Stand-in for the Playwright MCP server, the process boundary: records the
 * code sent to browser_run_code and answers in its "### Result" format.
 */
function fakePlaywrightClient(options?: {
  storageState?: string;
  failRestore?: boolean;
}) {
  const codes: string[] = [];
  const callTool = vi.fn(
    async ({ arguments: args }: { arguments: { code: string } }) => {
      codes.push(args.code);
      if (args.code.includes("addCookies") && options?.failRestore) {
        return {
          isError: true,
          content: [{ type: "text", text: "### Error\nboom" }],
        };
      }
      const value = args.code.includes("storageState()")
        ? (options?.storageState ?? "{}")
        : JSON.stringify("restored");
      return {
        content: [
          {
            type: "text",
            text: `### Result\n${value}\n### Ran Playwright code\n\`\`\`js\n...\n\`\`\``,
          },
        ],
      };
    },
  );
  return { codes, asClient: { callTool } as unknown as Client };
}
