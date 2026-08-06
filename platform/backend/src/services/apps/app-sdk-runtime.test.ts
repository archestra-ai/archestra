import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/**
 * Executes the REAL static SDK file (static/archestra-app-sdk.js) in this
 * process: a minimal `window` carries the two injected globals, and the
 * ext-apps guest module — a true process boundary — is stubbed via a
 * `data:` URL so `archestra.*` runs the SDK's own logic end to end (tool-name
 * wiring, scope plumbing, isError/auth_required mapping).
 */

type StubCall = { name: string; arguments: Record<string, unknown> };
type StubResult = Record<string, unknown>;
type StubApp = {
  fallbackNotificationHandler?: (notification: unknown) => Promise<void>;
};

const calls: StubCall[] = [];
const results: StubResult[] = [];
const modelContextCalls: StubResult[] = [];

declare global {
  var __sdkTestCalls: StubCall[];
  var __sdkTestResults: StubResult[];
  var __sdkTestApp: StubApp;
  var __sdkTestModelContext: StubResult[];
}

const GUEST_MODULE = `
export class App {
  constructor() {
    globalThis.__sdkTestApp = this;
  }
  async connect() {}
  async updateModelContext(params) {
    globalThis.__sdkTestModelContext.push(params);
  }
  async callServerTool(params, options) {
    globalThis.__sdkTestCalls.push(params);
    const queued = globalThis.__sdkTestResults.shift();
    if (!queued) throw new Error("sdk test: no stub result queued");
    if (!queued.__slow) return queued;
    // Slow-result path mirrors the request-timeout contract of
    // @modelcontextprotocol/sdk shared/protocol.js for a host that emits no
    // progress notifications: the per-request timer is options.timeout
    // (60s when the caller passes none), and firing it rejects with the
    // RequestTimeout McpError (-32001).
    const timeout =
      options && options.timeout != null ? options.timeout : 60000;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          Object.assign(new Error("MCP error -32001: Request timed out"), {
            code: -32001,
          }),
        );
      }, timeout);
      setTimeout(() => {
        clearTimeout(timer);
        resolve(queued.result);
      }, queued.delayMs);
    });
  }
}
export class PostMessageTransport {
  constructor() {}
}
`;

// biome-ignore lint/suspicious/noExplicitAny: the SDK's window surface is untyped by design
let archestra: any;
const originalConsoleError = console.error;

// The SDK reports model context fire-and-forget: it hops the (already
// resolved) connect promise before calling the guest, so give the microtask
// queue a beat before asserting a report did — or did not — land.
const settleModelContextReports = () =>
  new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  globalThis.__sdkTestCalls = calls;
  globalThis.__sdkTestResults = results;
  globalThis.__sdkTestModelContext = modelContextCalls;
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

  test("llm.complete resolves for a completion that outlasts the MCP SDK's 60s default request timeout (reasoning models think for minutes)", async () => {
    vi.useFakeTimers();
    try {
      const reasoningLatencyMs = 3 * 60_000;
      results.push({
        __slow: true,
        delayMs: reasoningLatencyMs,
        result: {
          content: [{ type: "text", text: "a slowly reasoned answer" }],
          structuredContent: { text: "a slowly reasoned answer" },
        },
      });
      const pending = archestra.llm.complete("prove it step by step");
      const settled = expect(pending).resolves.toBe("a slowly reasoned answer");
      await vi.advanceTimersByTimeAsync(reasoningLatencyMs);
      await settled;
      calls.pop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("llm.complete stays bounded: a completion beyond the 10-minute tool-call ceiling still times out", async () => {
    vi.useFakeTimers();
    try {
      const ceilingMs = 10 * 60_000;
      results.push({
        __slow: true,
        delayMs: ceilingMs + 60_000,
        result: {
          content: [{ type: "text", text: "too late" }],
          structuredContent: { text: "too late" },
        },
      });
      const pending = archestra.llm.complete("run forever");
      const settled = expect(pending).rejects.toThrow("MCP error -32001");
      await vi.advanceTimersByTimeAsync(ceilingMs + 60_000);
      await settled;
      calls.pop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("llm.prompt builds a string with no host round-trip", () => {
    const before = calls.length;
    const built = archestra.llm.prompt`Hello ${"world"} (${42})`;
    expect(built).toBe("Hello world (42)");
    // a template with no interpolations returns the literal unchanged
    expect(archestra.llm.prompt`just text`).toBe("just text");
    expect(calls.length).toBe(before);
  });

  test("files.list wires through search_files, with and without a query", async () => {
    const entries = [
      {
        id: "f1",
        ref: "file:f1",
        filename: "model.stl",
        mimeType: "model/stl",
        sizeBytes: 10,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    results.push({ structuredContent: { files: entries } });
    expect(await archestra.files.list()).toEqual(entries);
    expect(calls.pop()).toEqual({
      name: "archestra__search_files",
      arguments: {},
    });

    results.push({ structuredContent: { files: [] } });
    expect(await archestra.files.list("stl")).toEqual([]);
    expect(calls.pop()).toEqual({
      name: "archestra__search_files",
      arguments: { query: "stl" },
    });
  });

  test("files.read resolves a browser File carrying the exact decoded bytes", async () => {
    const bytes = new Uint8Array([0x73, 0x6f, 0x6c, 0x69, 0x64, 0x00, 0xff]);
    results.push({
      structuredContent: {
        fileId: "f1",
        filename: "model.stl",
        mimeType: "model/stl",
        sizeBytes: bytes.length,
        contentBase64: Buffer.from(bytes).toString("base64"),
      },
    });
    const file = await archestra.files.read("model.stl");
    expect(calls.pop()).toEqual({
      name: "archestra__read_file_raw",
      arguments: { filename: "model.stl" },
    });
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("model.stl");
    expect(file.type).toBe("model/stl");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  test("files.read accepts an {id} selector and rejects an empty one", async () => {
    results.push({
      structuredContent: {
        fileId: "f2",
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 2,
        contentBase64: Buffer.from("hi").toString("base64"),
      },
    });
    expect(await (await archestra.files.read({ id: "f2" })).text()).toBe("hi");
    expect(calls.pop()).toEqual({
      name: "archestra__read_file_raw",
      arguments: { id: "f2" },
    });

    await expect(archestra.files.read({})).rejects.toBeInstanceOf(TypeError);
    await expect(archestra.files.read("")).rejects.toBeInstanceOf(TypeError);
  });

  test("files.save sends text as content and upserts by default", async () => {
    results.push({
      structuredContent: {
        fileId: "f3",
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        overwritten: true,
      },
    });
    expect(await archestra.files.save("notes.txt", "hello")).toEqual({
      id: "f3",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      overwritten: true,
    });
    expect(calls.pop()).toEqual({
      name: "archestra__save_file",
      arguments: { filename: "notes.txt", content: "hello", overwrite: true },
    });
  });

  test("files.save base64-encodes binary data and takes the mime type from a Blob", async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    results.push({
      structuredContent: {
        fileId: "f4",
        filename: "a.bin",
        mimeType: "application/x-thing",
        sizeBytes: 4,
        overwritten: false,
      },
    });
    await archestra.files.save(
      "a.bin",
      new Blob([bytes], { type: "application/x-thing" }),
      { overwrite: false },
    );
    expect(calls.pop()).toEqual({
      name: "archestra__save_file",
      arguments: {
        filename: "a.bin",
        contentBase64: Buffer.from(bytes).toString("base64"),
        mimeType: "application/x-thing",
        overwrite: false,
      },
    });

    // a typed array views only its own window of the underlying buffer
    const window = new Uint8Array(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2);
    results.push({
      structuredContent: {
        fileId: "f5",
        filename: "b.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 2,
        overwritten: false,
      },
    });
    await archestra.files.save("b.bin", window);
    expect(calls.pop()).toEqual({
      name: "archestra__save_file",
      arguments: {
        filename: "b.bin",
        contentBase64: Buffer.from([8, 7]).toString("base64"),
        overwrite: true,
      },
    });

    await expect(archestra.files.save("c.bin", 42)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  test("files.delete wires the selector through delete_file", async () => {
    results.push({
      structuredContent: { fileId: "f1", filename: "model.stl", deleted: true },
    });
    await expect(archestra.files.delete("model.stl")).resolves.toBeUndefined();
    expect(calls.pop()).toEqual({
      name: "archestra__delete_file",
      arguments: { filename: "model.stl" },
    });
  });

  test("files.onChange echoes save and delete locally to every listener, even past one that throws, until unsubscribed", async () => {
    const seen: string[] = [];
    const unsubscribeThrowing = archestra.files.onChange(() => {
      seen.push("thrower");
      throw new Error("listener boom");
    });
    const unsubscribeQuiet = archestra.files.onChange(() => {
      seen.push("quiet");
    });

    results.push({
      structuredContent: {
        fileId: "f6",
        filename: "echo.txt",
        mimeType: "text/plain",
        sizeBytes: 2,
        overwritten: false,
      },
    });
    await archestra.files.save("echo.txt", "hi");
    calls.pop();
    // the throwing listener is contained and does not starve the next one
    expect(seen).toEqual(["thrower", "quiet"]);

    results.push({
      structuredContent: { fileId: "f6", filename: "echo.txt", deleted: true },
    });
    await archestra.files.delete("echo.txt");
    calls.pop();
    expect(seen).toEqual(["thrower", "quiet", "thrower", "quiet"]);

    unsubscribeThrowing();
    unsubscribeQuiet();

    results.push({
      structuredContent: {
        fileId: "f6",
        filename: "echo.txt",
        mimeType: "text/plain",
        sizeBytes: 2,
        overwritten: true,
      },
    });
    await archestra.files.save("echo.txt", "hi");
    calls.pop();
    expect(seen).toHaveLength(4);
  });

  test("the host's resources/list_changed notification fires onChange listeners; other methods do not", async () => {
    const app = globalThis.__sdkTestApp;
    expect(typeof app.fallbackNotificationHandler).toBe("function");

    const seen: string[] = [];
    const unsubscribe = archestra.files.onChange(() => {
      seen.push("changed");
    });
    try {
      await app.fallbackNotificationHandler?.({
        method: "notifications/resources/list_changed",
      });
      expect(seen).toEqual(["changed"]);

      await app.fallbackNotificationHandler?.({
        method: "notifications/progress",
      });
      expect(seen).toEqual(["changed"]);
    } finally {
      unsubscribe();
    }
  });

  test("a successful envelope without its structured payload is a tool_error: read without contentBase64, save without fileId", async () => {
    results.push({ content: [{ type: "text", text: "ok but empty" }] });
    await expect(archestra.files.read("ghost.txt")).rejects.toMatchObject({
      code: "tool_error",
      message: "archestra.files.read: the file tool returned no content",
    });
    calls.pop();

    results.push({ structuredContent: { filename: "ghost.txt" } });
    await expect(archestra.files.save("ghost.txt", "x")).rejects.toMatchObject({
      code: "tool_error",
      message: "archestra.files.save: the file tool returned no result",
    });
    calls.pop();
  });

  // One test on purpose: the suite shares a single SDK instance and vitest
  // shuffles test order, so the auto-report assertion must run before the
  // explicit report permanently disables it — only intra-test order is
  // guaranteed.
  test("files.read auto-reports the shown file as model context until ui.updateModelContext reports explicitly (explicit wins, permanently)", async () => {
    modelContextCalls.length = 0;
    results.push({
      structuredContent: {
        fileId: "f7",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
        contentBase64: Buffer.from("pdf").toString("base64"),
      },
    });
    await archestra.files.read("invoice.pdf");
    calls.pop();
    await settleModelContextReports();
    expect(modelContextCalls).toEqual([
      {
        content: [
          {
            type: "text",
            text: 'The app is showing the file "invoice.pdf" (application/pdf, 3 bytes) from its file store.',
          },
        ],
      },
    ]);

    archestra.ui.updateModelContext("Comparing invoice.pdf against the ledger");
    await settleModelContextReports();
    expect(modelContextCalls[1]).toEqual({
      content: [
        { type: "text", text: "Comparing invoice.pdf against the ledger" },
      ],
    });

    // a later read no longer auto-reports — the explicit report won
    results.push({
      structuredContent: {
        fileId: "f8",
        filename: "ledger.csv",
        mimeType: "text/csv",
        sizeBytes: 2,
        contentBase64: Buffer.from("a,").toString("base64"),
      },
    });
    await archestra.files.read("ledger.csv");
    calls.pop();
    await settleModelContextReports();
    expect(modelContextCalls).toHaveLength(2);

    expect(() => archestra.ui.updateModelContext("")).toThrow(TypeError);
    expect(() => archestra.ui.updateModelContext("   ")).toThrow(TypeError);
    // biome-ignore lint/suspicious/noExplicitAny: exercising the non-string guard
    expect(() => (archestra.ui.updateModelContext as any)(42)).toThrow(
      TypeError,
    );
  });
});
