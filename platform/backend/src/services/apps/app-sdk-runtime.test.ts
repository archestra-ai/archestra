import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * Executes the REAL static SDK file (static/archestra-app-sdk.js) in this
 * process: a minimal `window` carries the two injected globals, and the
 * ext-apps guest module — a true process boundary — is stubbed via a
 * `data:` URL so `archestra.*` runs the SDK's own logic end to end (tool-name
 * wiring, scope plumbing, isError/auth_required mapping).
 */

type StubCall = { name: string; arguments: Record<string, unknown> };
type StubResult = Record<string, unknown>;

const calls: StubCall[] = [];
const results: StubResult[] = [];

declare global {
  var __sdkTestCalls: StubCall[];
  var __sdkTestResults: StubResult[];
}

const GUEST_MODULE = `
export class App {
  constructor() {}
  async connect() {}
  async callServerTool(params) {
    globalThis.__sdkTestCalls.push(params);
    const result = globalThis.__sdkTestResults.shift();
    if (!result) throw new Error("sdk test: no stub result queued");
    return result;
  }
}
export class PostMessageTransport {
  constructor() {}
}
`;

// biome-ignore lint/suspicious/noExplicitAny: the SDK's window surface is untyped by design
let archestra: any;
const originalConsoleError = console.error;

beforeAll(async () => {
  globalThis.__sdkTestCalls = calls;
  globalThis.__sdkTestResults = results;
  // biome-ignore lint/suspicious/noExplicitAny: minimal browser-shaped global
  (globalThis as any).window = {
    addEventListener: () => {},
    parent: { postMessage: () => {} },
    __ARCHESTRA_APP_SDK_URL__: `data:text/javascript,${encodeURIComponent(GUEST_MODULE)}`,
    __ARCHESTRA_APP_CONTEXT__: {
      user: { id: "u1", name: "Alice" },
      tools: [
        { name: "hf__paper_search", description: "search", inputSchema: {} },
      ],
    },
  };

  const sdkUrl = pathToFileURL(
    join(__dirname, "../../static/archestra-app-sdk.js"),
  ).href;
  await import(sdkUrl);
  // biome-ignore lint/suspicious/noExplicitAny: see above
  archestra = (globalThis as any).window.archestra;
  await archestra.ready;
});

afterAll(() => {
  // the SDK wraps console.error for diagnostics; don't leak that to other suites
  console.error = originalConsoleError;
  // biome-ignore lint/suspicious/noExplicitAny: cleanup
  delete (globalThis as any).window;
});

describe("Apps SDK runtime", () => {
  test("exposes the frozen viewer identity and the bootstrap tool list", async () => {
    expect(archestra.user).toEqual({ id: "u1", name: "Alice" });
    expect(Object.isFrozen(archestra.user)).toBe(true);
    expect(await archestra.tools.list()).toEqual([
      { name: "hf__paper_search", description: "search", inputSchema: {} },
    ]);
  });

  test("storage partitions wire key, scope, and value through the data tools", async () => {
    results.push({
      structuredContent: { value: { n: 1 }, revision: 1, owner: null },
    });
    expect(await archestra.storage.user.get("fav")).toEqual({
      value: { n: 1 },
      revision: 1,
      owner: null,
    });
    expect(calls.pop()).toEqual({
      name: "archestra__app_data_get",
      arguments: { key: "fav", scope: "user" },
    });

    results.push({ structuredContent: { key: "fav" } });
    await archestra.storage.shared.set("fav", "x");
    expect(calls.pop()).toEqual({
      name: "archestra__app_data_set",
      arguments: { key: "fav", value: "x", scope: "app" },
    });

    results.push({ structuredContent: { entries: [{ key: "k", value: 1 }] } });
    expect(await archestra.storage.user.list()).toEqual([
      { key: "k", value: 1 },
    ]);
    expect(calls.pop()).toEqual({
      name: "archestra__app_data_list",
      arguments: { scope: "user" },
    });

    results.push({ content: [] });
    await archestra.storage.user.delete("fav");
    expect(calls.pop()).toEqual({
      name: "archestra__app_data_delete",
      arguments: { key: "fav", scope: "user" },
    });
  });

  test("set guards on the revision last seen for the key, so a stale write conflicts instead of silently overwriting", async () => {
    // A read establishes the key's current revision.
    results.push({
      structuredContent: { value: { items: [] }, revision: 4, owner: null },
    });
    await archestra.storage.user.get("rmw_default");
    calls.pop();

    // A later write of the same key carries that revision as expectedRevision
    // without the app passing ifRevision — the backend then rejects it as a
    // conflict if another instance wrote in between, rather than clobbering.
    results.push({
      structuredContent: { key: "rmw_default", revision: 5, owner: null },
    });
    await archestra.storage.user.set("rmw_default", { items: ["a"] });
    expect(calls.pop()).toEqual({
      name: "archestra__app_data_set",
      arguments: {
        key: "rmw_default",
        value: { items: ["a"] },
        scope: "user",
        expectedRevision: 4,
      },
    });
  });

  test("set omits the guard for a key never read this session (a blind write stays last-writer-wins)", async () => {
    results.push({
      structuredContent: { key: "blind_key", revision: 1, owner: null },
    });
    await archestra.storage.user.set("blind_key", "v");
    expect(calls.pop()).toEqual({
      name: "archestra__app_data_set",
      arguments: { key: "blind_key", value: "v", scope: "user" },
    });
  });

  test("an explicit ifRevision overrides the tracked revision", async () => {
    results.push({
      structuredContent: { value: 1, revision: 9, owner: null },
    });
    await archestra.storage.user.get("explicit_key");
    calls.pop();

    results.push({
      structuredContent: { key: "explicit_key", revision: 3, owner: null },
    });
    await archestra.storage.user.set("explicit_key", 2, { ifRevision: 2 });
    expect(calls.pop()).toEqual({
      name: "archestra__app_data_set",
      arguments: {
        key: "explicit_key",
        value: 2,
        scope: "user",
        expectedRevision: 2,
      },
    });
  });

  test("ifRevision null opts out of the guard, forcing last-writer-wins after a read", async () => {
    results.push({
      structuredContent: { value: 1, revision: 9, owner: null },
    });
    await archestra.storage.user.get("optout_key");
    calls.pop();

    results.push({
      structuredContent: { key: "optout_key", revision: 10, owner: null },
    });
    await archestra.storage.user.set("optout_key", 2, { ifRevision: null });
    expect(calls.pop()).toEqual({
      name: "archestra__app_data_set",
      arguments: { key: "optout_key", value: 2, scope: "user" },
    });
  });

  test("a set after get returned absent guards insert-if-absent, so a racing create conflicts", async () => {
    results.push({
      structuredContent: { value: null, revision: null, owner: null },
    });
    expect(await archestra.storage.shared.get("absent_key")).toBeNull();
    calls.pop();

    results.push({
      structuredContent: { key: "absent_key", revision: 1, owner: null },
    });
    await archestra.storage.shared.set("absent_key", { first: true });
    expect(calls.pop()).toEqual({
      name: "archestra__app_data_set",
      arguments: {
        key: "absent_key",
        value: { first: true },
        scope: "app",
        expectedRevision: 0,
      },
    });
  });

  test("a set after list guards on the revision list returned for the key", async () => {
    results.push({
      structuredContent: {
        entries: [
          { key: "list_a", value: 1, revision: 7, owner: null },
          { key: "list_b", value: 2, revision: 8, owner: null },
        ],
      },
    });
    await archestra.storage.user.list();
    calls.pop();

    results.push({
      structuredContent: { key: "list_b", revision: 9, owner: null },
    });
    await archestra.storage.user.set("list_b", 22);
    expect(calls.pop()).toEqual({
      name: "archestra__app_data_set",
      arguments: {
        key: "list_b",
        value: 22,
        scope: "user",
        expectedRevision: 8,
      },
    });
  });

  test("tools.call resolves with structuredContent when present, over text", async () => {
    results.push({
      content: [{ type: "text", text: '{"other": true}' }],
      structuredContent: { papers: [{ id: 1 }] },
    });
    expect(await archestra.tools.call("hf__paper_search", { q: "x" })).toEqual({
      papers: [{ id: 1 }],
    });
    expect(calls.pop()).toEqual({
      name: "hf__paper_search",
      arguments: { q: "x" },
    });
  });

  test("tools.call parses JSON-as-text results, joining text blocks", async () => {
    results.push({
      content: [
        { type: "text", text: '{"tasks": [' },
        { type: "text", text: '{"id": 7}]}' },
      ],
    });
    expect(await archestra.tools.call("t", {})).toEqual({
      tasks: [{ id: 7 }],
    });
    calls.pop();
  });

  test("tools.call parses JSON scalars and arrays in text, not just objects", async () => {
    results.push({ content: [{ type: "text", text: '[{"id": 1}]' }] });
    expect(await archestra.tools.call("t", {})).toEqual([{ id: 1 }]);
    calls.pop();
    results.push({ content: [{ type: "text", text: "false" }] });
    expect(await archestra.tools.call("t", {})).toBe(false);
    calls.pop();
  });

  test("tools.call falls back to the joined string when text blocks are separate JSON documents", async () => {
    results.push({
      content: [
        { type: "text", text: '{"a": 1}' },
        { type: "text", text: '{"b": 2}' },
      ],
    });
    expect(await archestra.tools.call("t", {})).toBe('{"a": 1}\n{"b": 2}');
    calls.pop();
  });

  test("tools.call passes non-JSON text through as the string", async () => {
    results.push({ content: [{ type: "text", text: "plain answer" }] });
    expect(await archestra.tools.call("t", {})).toBe("plain answer");
    calls.pop();
  });

  test("tools.call normalizes image/audio-only results into media data URLs", async () => {
    results.push({
      content: [
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "audio", data: "c28=", mimeType: "audio/mpeg" },
      ],
    });
    expect(await archestra.tools.call("t", {})).toEqual({
      media: [
        {
          type: "image",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,aGk=",
        },
        {
          type: "audio",
          mimeType: "audio/mpeg",
          dataUrl: "data:audio/mpeg;base64,c28=",
        },
      ],
    });
    calls.pop();
  });

  test("tools.call drops media blocks whose mimeType or data could break out of a data URL", async () => {
    results.push({
      content: [
        {
          type: "image",
          data: "aGk=",
          mimeType: 'image/png" onerror="alert(1)',
        },
        { type: "image", data: 'aGk="><script>', mimeType: "image/png" },
      ],
    });
    expect(await archestra.tools.call("t", {})).toBeNull();
    calls.pop();
  });

  test("tools.call resolves null when the result has no text, structured, or media data", async () => {
    results.push({ content: [] });
    expect(await archestra.tools.call("t", {})).toBeNull();
    calls.pop();
  });

  test("auth_required surfaces as a typed error with the action url", async () => {
    results.push({
      isError: true,
      content: [{ type: "text", text: "needs auth" }],
      _meta: {
        archestraError: {
          type: "auth_required",
          actionUrl: "https://x/mcp/registry?reauth",
        },
      },
    });
    await expect(
      archestra.tools.call("hf__paper_search", {}),
    ).rejects.toMatchObject({
      code: "auth_required",
      url: "https://x/mcp/registry?reauth",
    });
  });

  test("auth_expired in structuredContent maps to the same typed error", async () => {
    results.push({
      isError: true,
      content: [],
      structuredContent: {
        archestraError: {
          type: "auth_expired",
          reauthUrl: "https://x/reauth",
        },
      },
    });
    await expect(archestra.tools.call("t", {})).rejects.toMatchObject({
      code: "auth_required",
      url: "https://x/reauth",
    });
  });

  test("a generic tool failure rejects with its text and code tool_error", async () => {
    results.push({
      isError: true,
      content: [{ type: "text", text: "boom: bad arguments" }],
    });
    await expect(archestra.tools.call("t", {})).rejects.toMatchObject({
      code: "tool_error",
      message: "boom: bad arguments",
    });
  });

  test("llm.complete wires prompt/opts through the reserved tool and returns text", async () => {
    results.push({
      content: [{ type: "text", text: "a summary" }],
      structuredContent: { text: "a summary" },
    });
    const text = await archestra.llm.complete("summarize this", {
      system: "be terse",
      jsonMode: false,
    });
    expect(text).toBe("a summary");
    expect(calls.pop()).toEqual({
      name: "archestra__llm_complete",
      arguments: {
        prompt: "summarize this",
        system: "be terse",
        jsonMode: false,
      },
    });
  });

  test("llm.complete maps llm_quota to a typed error code", async () => {
    results.push({
      isError: true,
      content: [{ type: "text", text: "limit reached" }],
      _meta: {
        archestraError: { type: "llm_quota", message: "limit reached" },
      },
    });
    await expect(archestra.llm.complete("x")).rejects.toMatchObject({
      code: "llm_quota",
    });
  });

  test("llm.complete maps llm_unavailable to a typed error code", async () => {
    results.push({
      isError: true,
      content: [],
      structuredContent: {
        archestraError: { type: "llm_unavailable", message: "no key" },
      },
    });
    await expect(archestra.llm.complete("x")).rejects.toMatchObject({
      code: "llm_unavailable",
    });
  });

  test("llm.prompt builds a string with no host round-trip", () => {
    const before = calls.length;
    const built = archestra.llm.prompt`Hello ${"world"} (${42})`;
    expect(built).toBe("Hello world (42)");
    // a template with no interpolations returns the literal unchanged
    expect(archestra.llm.prompt`just text`).toBe("just text");
    expect(calls.length).toBe(before);
  });
});
