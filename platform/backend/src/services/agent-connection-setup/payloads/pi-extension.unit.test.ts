import { describe, expect, test, vi } from "vitest";
import { PI_EXTENSION } from "./pi-extension";

type EventResult =
  | {
      block?: boolean;
      cancel?: boolean;
      compaction?: unknown;
      summary?: { summary: string };
    }
  | undefined;
type EventHandler = (
  event: Record<string, unknown>,
  context: unknown,
) => EventResult | Promise<EventResult>;
type Provider = {
  getModels?: () => unknown[];
  streamSimple: (
    model: Record<string, string>,
    context: unknown,
  ) => AsyncIterable<unknown>;
};
type QuestionArgs = {
  question: string;
  options: { label: string; description?: string }[];
};
type QuestionTool = {
  name: string;
  execute: (
    id: string,
    args: QuestionArgs,
    signal: undefined,
    update: undefined,
    context: unknown,
  ) => Promise<{ content: { text: string }[] }>;
};
type Entry = {
  type: string;
  id?: string;
  parentId?: string | null;
  customType?: string;
  data?: unknown;
  message?: Record<string, unknown>;
  summary?: string;
  label?: string;
  targetId?: string;
};

// Pi is an external host. Execute the shipped payload with only its SDK,
// filesystem and network boundaries replaced; no enforcement logic is mocked.
function host(configOverride: Record<string, unknown> = {}) {
  const handlers = new Map<string, EventHandler>();
  const providers: Record<string, Provider> = {};
  const tools: Record<string, QuestionTool> = {};
  const entries: Entry[] = [];
  let id = "root-session";
  let leaf: string | null = null;
  let result: "allow" | "deny" | "error" | "summary" = "allow";
  const contexts: unknown[] = [];
  let extraEvents: unknown[] = [];
  let beforeFinish: (() => void) | undefined;
  let observedEarlyCall: (() => void) | undefined;
  const calls: Request[] = [];
  const fetch = vi.fn(async (request: Request) => {
    calls.push(request);
    if (result === "error") throw new Error("policy unavailable");
    return new Response("{}");
  });
  const model = {
    provider: "archestra",
    id: "test-model",
    api: "archestra-pi-openai-responses",
  };
  const context = {
    hasUI: true,
    model,
    sessionManager: {
      getSessionId: () => id,
      getEntries: () => entries,
      getBranch: (_from?: string | null) => entries,
      getLeafId: () => leaf,
      getEntry: (entryId: string) =>
        entries.find((entry) => entry.id === entryId),
    },
    modelRegistry: {
      getAll: () => [model, { provider: "openai" }],
      getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
    },
    ui: { select: vi.fn() },
  };
  const pi = {
    getAllTools: () => [],
    on: (name: string, handler: EventHandler) => handlers.set(name, handler),
    registerProvider: (
      name: string | (Provider & { id: string }),
      provider?: Provider,
    ) => {
      if (typeof name === "string" && provider) providers[name] = provider;
      else if (typeof name !== "string") providers[name.id] = name;
    },
    registerTool: (tool: QuestionTool) => (tools[tool.name] = tool),
    appendEntry: (customType: string, data: unknown) => {
      const entryId = `entry-${entries.length + 1}`;
      entries.push({
        type: "custom",
        customType,
        data,
        id: entryId,
        parentId: leaf,
      });
      leaf = entryId;
    },
  };
  const Type = new Proxy({}, { get: () => () => ({}) });
  const streamSimple = async function* (
    _model: unknown,
    _context: unknown,
    options: { fetch: typeof globalThis.fetch },
  ) {
    contexts.push(_context);
    await options.fetch("https://proxy.example/v1/openai/test/responses", {
      method: "POST",
      body: JSON.stringify({ model: (_model as { id: string }).id }),
    });
    yield { type: "toolcall_end" };
    observedEarlyCall?.();
    yield {
      type: "done",
      message: {
        content:
          result === "allow"
            ? [
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "bash",
                  arguments: { command: "echo test" },
                },
              ]
            : result === "summary"
              ? [{ type: "text", text: "Admitted continuation summary." }]
              : [],
      },
    };
    for (const event of extraEvents) yield event;
    beforeFinish?.();
  };
  const source = PI_EXTENSION.replace(/^import .*;\n/gm, "").replace(
    "export default function",
    "return function",
  );
  const install = new Function(
    "readFileSync",
    "homedir",
    "join",
    "Type",
    "createAssistantMessageEventStream",
    "openAIResponsesApi",
    "fetch",
    "convertToLlm",
    "buildSessionProjection",
    source,
  )(
    () =>
      JSON.stringify({
        url: "https://proxy.example/v1/openai/test",
        model: "test-model",
        apiKey: "test-key",
        ...configOverride,
      }),
    () => "/test",
    (...parts: string[]) => parts.join("/"),
    Type,
    eventStream,
    () => ({ streamSimple }),
    fetch,
    (messages: unknown[]) => messages,
    (all: Entry[], leafId: string) => {
      const branch: Entry[] = [];
      let current = all.find((entry) => entry.id === leafId);
      while (current) {
        branch.unshift(current);
        current = all.find((entry) => entry.id === current?.parentId);
      }
      return {
        messages: branch.flatMap((entry) =>
          entry.message ? [entry.message] : [],
        ),
      };
    },
  );
  install(pi);
  const emit = (name: string, event = {}) =>
    handlers.get(name)?.(event, context);
  const request = async () => {
    const events = [];
    for await (const event of (
      providers[model.provider] ?? providers.archestra
    ).streamSimple(model, {}))
      events.push(event);
    return events;
  };
  const execute = (overrides = {}) => {
    const sideEffect = vi.fn();
    const verdict = emit("tool_call", {
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "echo test" },
      ...overrides,
    });
    if (verdict instanceof Promise) throw new Error("Unexpected async gate");
    if (!verdict?.block) sideEffect();
    return sideEffect;
  };
  return {
    emit,
    request,
    execute,
    calls,
    fetch,
    contexts,
    context,
    entries,
    tools,
    providers,
    setStream: (options: {
      events?: unknown[];
      beforeFinish?: () => void;
      onEarly?: () => void;
    }) => {
      extraEvents = options.events ?? [];
      beforeFinish = options.beforeFinish;
      observedEarlyCall = options.onEarly;
    },
    setLeaf: (value: string | null) => {
      leaf = value;
    },
    setId: (value: string) => {
      id = value;
    },
    setResult: (value: typeof result) => {
      result = value;
    },
  };
}

function treeHost() {
  const h = host();
  h.entries.push({ id: "before", parentId: null, type: "model_change" });
  h.setLeaf("before");
  h.context.sessionManager.getBranch = (from) => {
    const branch: Entry[] = [];
    let current = h.context.sessionManager.getEntry(
      from ?? h.context.sessionManager.getLeafId() ?? "",
    );
    while (current) {
      branch.unshift(current);
      current = current.parentId
        ? h.context.sessionManager.getEntry(current.parentId)
        : undefined;
    }
    return branch;
  };
  h.emit("session_start");
  const add = (entry: Entry) => {
    const next = {
      ...entry,
      id: `entry-${h.entries.length + 1}`,
      parentId: h.context.sessionManager.getLeafId(),
    };
    h.entries.push(next);
    h.setLeaf(next.id);
    return next;
  };
  const prepare = (targetId: string, summary: boolean) => {
    const oldLeafId = h.context.sessionManager.getLeafId();
    const branch = h.context.sessionManager.getBranch(oldLeafId);
    const targets = new Set(
      h.context.sessionManager.getBranch(targetId).map((entry) => entry.id),
    );
    const commonAncestorId =
      [...branch].reverse().find((entry) => targets.has(entry.id))?.id ?? null;
    return {
      targetId,
      oldLeafId,
      commonAncestorId,
      userWantsSummary: summary,
      entriesToSummarize: branch.slice(
        commonAncestorId === null
          ? 0
          : branch.findIndex((entry) => entry.id === commonAncestorId) + 1,
      ),
    };
  };
  return { ...h, add, prepare };
}

function eventStream() {
  const queue: unknown[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  return {
    push(event: unknown) {
      queue.push(event);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (!ended || queue.length) {
        if (queue.length) yield queue.shift();
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    },
  };
}

describe("shipped Pi extension", () => {
  test.each([
    "deny",
    "error",
  ] as const)("%s never executes a tool, even when the host catches hook errors", async (result) => {
    const h = host();
    h.emit("session_start");
    h.setResult(result);
    await h.request();
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test("executes each released exact call once, and refuses changed or nested calls", async () => {
    const h = host();
    h.emit("session_start");
    await h.request();
    expect(h.execute()).toHaveBeenCalledOnce();
    expect(h.execute()).not.toHaveBeenCalled();
    await h.request();
    expect(
      h.execute({ input: { command: "different" } }),
    ).not.toHaveBeenCalled();
    await h.request();
    expect(h.execute({ parentToolCallId: "parent" })).not.toHaveBeenCalled();
  });

  test("an invalid binding blocks other providers before Pi catches the hook error", async () => {
    const h = host();
    h.entries.push({ type: "message" });
    expect(() => h.emit("session_start")).toThrow();
    const events = [];
    for await (const event of h.providers.openai.streamSimple(
      { provider: "openai", id: "old-model", api: "openai-responses" },
      { messages: ["private history"] },
    ))
      events.push(event);
    expect(events).toEqual([expect.objectContaining({ type: "error" })]);
    expect(h.calls).toHaveLength(0);
  });

  test.each([
    "malformed",
    "cyclic",
  ])("%s tool input returns an explicit refusal without throwing", async (kind) => {
    const h = host();
    h.emit("session_start");
    await h.request();
    const input: Record<string, unknown> = { command: "echo test" };
    input.extra = kind === "cyclic" ? input : BigInt(1);
    expect(h.execute({ input })).not.toHaveBeenCalled();
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test.each([
    { events: [{ type: "error" }] },
    { events: [{ type: "done", message: { content: [] } }] },
  ])("refuses terminal events after done: %j", async ({ events }) => {
    const h = host();
    h.emit("session_start");
    h.setStream({ events });
    expect(await h.request()).toEqual([
      expect.objectContaining({ type: "error" }),
    ]);
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test("does not release early tool events or calls from a session switched during the stream", async () => {
    const h = host();
    h.emit("session_start");
    h.setStream({
      onEarly: () => expect(h.execute()).not.toHaveBeenCalled(),
      beforeFinish: () => {
        h.setId("fork-session");
        h.emit("session_start", { reason: "fork" });
      },
    });
    expect(await h.request()).toEqual([
      expect.objectContaining({ type: "error" }),
    ]);
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test("requires a binding on the selected branch and refuses contradictory identities", async () => {
    const h = host();
    h.emit("session_start");
    h.context.sessionManager.getBranch = () => [];
    expect(() => h.emit("session_start", { reason: "fork" })).toThrow();
    await h.request();
    expect(h.calls).toHaveLength(0);
    h.context.sessionManager.getBranch = () => h.entries;
    h.entries.push({
      type: "custom",
      customType: "archestra-policy-session",
      data: { sessionId: "new-authority" },
    });
    expect(() => h.emit("session_start", { reason: "resume" })).toThrow();
    await h.request();
    expect(h.calls).toHaveLength(0);
  });

  test("fresh-session model metadata can precede the policy binding", async () => {
    const h = host();
    h.entries.push({ type: "model_change" }, { type: "thinking_level_change" });
    h.emit("session_start", { reason: "startup" });
    await h.request();
    expect(h.calls[0].headers.get("x-pi-session-id")).toBe("root-session");
  });

  test("an empty fork cannot mint a fresh policy binding", async () => {
    const h = host();
    expect(() => h.emit("session_start", { reason: "fork" })).toThrow();
    await h.request();
    expect(h.calls).toHaveLength(0);
  });

  test("a failed request clears earlier permits", async () => {
    const h = host();
    h.emit("session_start");
    await h.request();
    h.setResult("error");
    await h.request();
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test("resume and a fork carrying policy metadata retain identity and discard old permits", async () => {
    const h = host();
    h.emit("session_start");
    await h.request();
    h.emit("session_start", { reason: "resume" });
    expect(h.execute()).not.toHaveBeenCalled();
    h.setId("fork-session");
    h.emit("session_start", { reason: "fork" });
    await h.request();
    expect(
      h.calls.map((request) => request.headers.get("x-pi-session-id")),
    ).toEqual(["root-session", "root-session"]);
    expect(h.execute()).toHaveBeenCalledOnce();
    expect(h.calls[0].redirect).toBe("error");
  });

  test("unbound history fails closed even if Pi catches the session hook exception", async () => {
    const h = host();
    h.entries.push({ type: "message" });
    expect(() => h.emit("session_start", { reason: "resume" })).toThrow();
    await h.request();
    expect(h.calls).toHaveLength(0);
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test("tree navigation before the binding carries the same durable identity across resume", async () => {
    const h = treeHost();
    const original = h.context.sessionManager.getLeafId();
    const preparation = h.prepare("before", false);
    expect(
      await h.emit("session_before_tree", {
        preparation,
        signal: new AbortController().signal,
      }),
    ).toEqual({});
    h.setLeaf("before");
    h.emit("session_tree", { newLeafId: "before", oldLeafId: original });
    expect(h.context.sessionManager.getBranch().at(-1)).toMatchObject({
      data: { sessionId: "root-session" },
    });
    h.emit("session_start", { reason: "resume" });
    await h.request();
    expect(h.calls[0].headers.get("x-pi-session-id")).toBe("root-session");
  });

  test("tree summary preserves structured results and uses only the selected source lineage", async () => {
    const h = treeHost();
    const user = h.add({
      type: "message",
      message: { role: "user", content: "Task" },
    });
    h.add({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "earlier",
            name: "read",
            arguments: { path: "/lab" },
          },
        ],
      },
    });
    const result = {
      role: "toolResult",
      toolCallId: "earlier",
      toolName: "read",
      content: [
        { type: "text", text: "Source result kept behind proxy check" },
      ],
    };
    h.add({ type: "message", message: result });
    h.entries.push({
      id: "other-branch",
      parentId: "before",
      type: "message",
      message: { role: "toolResult", content: "OTHER_BRANCH_RAW" },
    });
    h.setResult("summary");
    const preparation = h.prepare(String(user.id), true);
    const response = await h.emit("session_before_tree", {
      preparation,
      signal: new AbortController().signal,
    });
    expect(response).toEqual({
      summary: { summary: "Admitted continuation summary." },
    });
    expect(h.contexts[0]).toMatchObject({
      messages: expect.arrayContaining([result]),
    });
    expect(JSON.stringify(h.contexts[0])).not.toContain("OTHER_BRANCH_RAW");
    expect(h.calls[0].headers.get("x-pi-session-id")).toBe("root-session");
    h.setLeaf(user.parentId ?? null);
    const summaryEntry = h.add({
      type: "branch_summary",
      summary: response?.summary?.summary,
    });
    h.emit("session_tree", {
      newLeafId: summaryEntry.id,
      summaryEntry,
      fromExtension: true,
    });
    h.emit("model_select");
    await h.request();
    expect(h.calls[1].headers.get("x-pi-session-id")).toBe("root-session");
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test.each([
    false,
    true,
  ])("tree navigation preserves a prepared bookmark with summary=%s", async (summary) => {
    const h = treeHost();
    const user = h.add({
      type: "message",
      message: { role: "user", content: "Bookmarked task" },
    });
    h.add({ type: "message", message: { role: "assistant", content: [] } });
    h.setResult("summary");
    const preparation = {
      ...h.prepare(String(user.id), summary),
      label: "Review point",
    };
    const response = await h.emit("session_before_tree", {
      preparation,
      signal: new AbortController().signal,
    });
    expect(response?.cancel).not.toBe(true);
    h.setLeaf(user.parentId ?? null);
    const summaryEntry = summary
      ? h.add({ type: "branch_summary", summary: response?.summary?.summary })
      : undefined;
    const bookmark = h.add({
      type: "label",
      label: preparation.label,
      targetId: summaryEntry?.id ?? user.id,
    });
    h.emit("session_tree", {
      newLeafId: bookmark.id,
      summaryEntry,
      fromExtension: summary,
    });
    await h.request();
    expect(h.calls.at(-1)?.headers.get("x-pi-session-id")).toBe("root-session");
  });

  test.each([
    "text",
    "target",
    "parent",
  ])("tree completion refuses a changed bookmark %s", async (change) => {
    const h = treeHost();
    const preparation = {
      ...h.prepare("before", false),
      label: "Review point",
    };
    expect(
      await h.emit("session_before_tree", {
        preparation,
        signal: new AbortController().signal,
      }),
    ).toEqual({});
    h.setLeaf("before");
    const bookmark = h.add({
      type: "label",
      label: change === "text" ? "Changed" : preparation.label,
      targetId: change === "target" ? "other" : "before",
    });
    if (change === "parent") bookmark.parentId = "other";
    expect(() => h.emit("session_tree", { newLeafId: bookmark.id })).toThrow();
    expect(await h.request()).toEqual([
      expect.objectContaining({ type: "error" }),
    ]);
    expect(h.calls).toHaveLength(0);
  });

  test.each([
    "deny",
    "error",
    "allow",
  ] as const)("tree summary cancels on %s and never falls back or releases tools", async (outcome) => {
    const h = treeHost();
    const target = h.add({
      type: "message",
      message: { role: "user", content: "Earlier" },
    });
    h.add({
      type: "message",
      message: { role: "toolResult", content: "DENIED_RAW" },
    });
    h.setResult(outcome);
    expect(
      await h.emit("session_before_tree", {
        preparation: h.prepare(String(target.id), true),
        signal: new AbortController().signal,
      }),
    ).toEqual({ cancel: true });
    expect(h.execute()).not.toHaveBeenCalled();
    expect(h.contexts[0]).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "toolResult" }),
      ]),
    });
  });

  test.each([
    "abort",
    "shutdown",
    "model",
    "session",
  ])("tree summary cancels if %s changes while streaming", async (change) => {
    const h = treeHost();
    const target = h.add({
      type: "message",
      message: { role: "user", content: "Earlier" },
    });
    h.add({ type: "message", message: { role: "assistant", content: [] } });
    const controller = new AbortController();
    h.setResult("summary");
    h.setStream({
      beforeFinish: () => {
        if (change === "abort") controller.abort();
        if (change === "shutdown") h.emit("session_shutdown");
        if (change === "model") h.emit("model_select");
        if (change === "session") h.setId("other-session");
      },
    });
    expect(
      await h.emit("session_before_tree", {
        preparation: h.prepare(String(target.id), true),
        signal: controller.signal,
      }),
    ).toEqual({ cancel: true });
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test.each([
    "source",
    "ancestor",
    "binding",
    "leaf",
    "target",
  ])("tree rejects changed %s before inference", async (change) => {
    const h = treeHost();
    const target = h.add({
      type: "message",
      message: { role: "user", content: "Earlier" },
    });
    h.add({ type: "message", message: { role: "assistant", content: [] } });
    const preparation = h.prepare(String(target.id), true);
    if (change === "source") preparation.entriesToSummarize = [];
    if (change === "ancestor") preparation.commonAncestorId = "missing";
    if (change === "binding")
      h.entries.push({
        type: "custom",
        customType: "archestra-policy-session",
        data: { sessionId: "fresh-authority" },
      });
    if (change === "leaf") preparation.oldLeafId = "missing";
    if (change === "target") preparation.targetId = "missing";
    expect(
      await h.emit("session_before_tree", {
        preparation,
        signal: new AbortController().signal,
      }),
    ).toEqual({ cancel: true });
    expect(h.calls).toHaveLength(0);
  });

  test.each([
    "duplicate",
    "binding",
  ])("tree completion rejects %s authority changes and disables inference", async (change) => {
    const h = treeHost();
    const preparation = h.prepare("before", false);
    expect(
      await h.emit("session_before_tree", {
        preparation,
        signal: new AbortController().signal,
      }),
    ).toEqual({});
    h.setLeaf("before");
    const event = { newLeafId: "before" };
    if (change === "duplicate") h.emit("session_tree", event);
    else
      h.entries.push({
        type: "custom",
        customType: "archestra-policy-session",
        data: { sessionId: "changed-after-preparation" },
      });
    expect(() => h.emit("session_tree", event)).toThrow();
    expect(await h.request()).toEqual([
      expect.objectContaining({ type: "error" }),
    ]);
    expect(h.calls).toHaveLength(0);
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test("duplicate or unprepared tree completion fails closed", async () => {
    const h = treeHost();
    expect(() =>
      h.emit("session_tree", {
        newLeafId: h.context.sessionManager.getLeafId(),
      }),
    ).toThrow();
    await h.request();
    expect(h.calls).toHaveLength(0);
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test("compaction sends structured tool results through the governed provider and retains identity", async () => {
    const h = host();
    h.emit("session_start");
    h.setResult("summary");
    const toolResult = {
      role: "toolResult",
      toolCallId: "earlier-call",
      toolName: "read",
      content: [{ type: "text", text: "unchecked raw result" }],
    };
    expect(
      await h.emit("session_before_compact", {
        preparation: {
          messagesToSummarize: [toolResult],
          turnPrefixMessages: [],
          firstKeptEntryId: "kept",
          tokensBefore: 1234,
        },
        signal: new AbortController().signal,
      }),
    ).toEqual({
      compaction: {
        summary: "Admitted continuation summary.",
        firstKeptEntryId: "kept",
        tokensBefore: 1234,
      },
    });
    expect(h.contexts[0]).toMatchObject({
      messages: [
        expect.objectContaining({ role: "system" }),
        toolResult,
        expect.anything(),
      ],
    });
    expect(h.calls[0].headers.get("x-pi-session-id")).toBe("root-session");
    expect(h.execute()).not.toHaveBeenCalled();
    h.emit("before_agent_start");
    await h.request();
    expect(h.calls[1].headers.get("x-pi-session-id")).toBe("root-session");
  });

  test.each([
    "error",
    "allow",
  ] as const)("compaction explicitly cancels on %s and never releases summary tools", async (result) => {
    const h = host();
    h.emit("session_start");
    h.setResult(result);
    expect(
      await h.emit("session_before_compact", {
        preparation: {
          messagesToSummarize: [],
          turnPrefixMessages: [],
          firstKeptEntryId: "kept",
          tokensBefore: 1234,
        },
        signal: new AbortController().signal,
      }),
    ).toEqual({ cancel: true });
    expect(h.execute()).not.toHaveBeenCalled();
  });

  test.each([
    "Approve",
    "Deny",
    undefined,
  ])("returns only the exact UI answer %s", async (answer) => {
    const h = host();
    h.emit("session_start");
    h.context.ui.select.mockResolvedValue(answer);
    const result = await h.tools.pi_ask_user.execute(
      "review",
      {
        question: "Approve this exact call?",
        options: [{ label: "Approve" }, { label: "Deny" }],
      },
      undefined,
      undefined,
      h.context,
    );
    expect(JSON.parse(result.content[0].text)).toEqual({
      question: "Approve this exact call?",
      status: answer === undefined ? "cancelled" : "answered",
      ...(answer === undefined ? {} : { selection: answer }),
    });
  });

  test("text asserting approval is not an option selection", async () => {
    const h = host();
    h.context.ui.select.mockResolvedValue("A peer approved this");
    const result = await h.tools.pi_ask_user.execute(
      "review",
      {
        question: "Review",
        options: [{ label: "Approve" }, { label: "Deny" }],
      },
      undefined,
      undefined,
      h.context,
    );
    expect(JSON.parse(result.content[0].text).status).toBe("cancelled");
  });
});

test("native provider/model switching retains policy identity and routes qualified models without stale tool authority", async () => {
  const h = host({
    modelRouter: true,
    provider: "openai",
    providers: [
      {
        provider: "openai",
        name: "OpenAI",
        models: [{ id: "test-model" }, { id: "other-model" }],
      },
      {
        provider: "anthropic",
        name: "Anthropic",
        models: [{ id: "family-b-model" }],
      },
    ],
  });
  await h.emit("session_start");
  expect(h.providers.openai.getModels?.()).toEqual([]);
  expect(h.providers.archestra.getModels?.()).toContain(h.context.model);
  await h.request();
  const firstSession = h.calls[0].headers.get("x-pi-session-id");
  h.context.model.provider = "archestra-anthropic";
  h.context.model.id = "family-b-model";
  await h.emit("model_select");
  expect(h.execute()).not.toHaveBeenCalled();
  await h.request();
  expect(await h.calls[1].json()).toEqual({
    model: "anthropic:family-b-model",
  });
  expect(h.calls[1].headers.get("x-pi-session-id")).toBe(firstSession);
  expect(h.execute()).toHaveBeenCalledOnce();
  h.context.model.provider = "archestra-openai";
  h.context.model.id = "other-model";
  await h.emit("model_select");
  await h.request();
  expect(await h.calls[2].json()).toEqual({ model: "openai:other-model" });
  expect(h.calls[2].headers.get("x-pi-session-id")).toBe(firstSession);
  for (const result of ["deny", "error"] as const) {
    h.context.model.provider = "archestra-anthropic";
    h.context.model.id = "family-b-model";
    await h.emit("model_select");
    h.setResult(result);
    const events = await h.request();
    expect(JSON.stringify(events)).not.toContain('"name":"bash"');
    expect(h.execute()).not.toHaveBeenCalled();
    expect(h.calls.at(-1)?.headers.get("x-pi-session-id")).toBe(firstSession);
  }
  h.setResult("allow");
  h.context.model.provider = "openai";
  h.context.model.id = "test-model";
  await h.emit("model_select");
  expect(await h.request()).toEqual([
    expect.objectContaining({ type: "error" }),
  ]);
  expect(h.execute()).not.toHaveBeenCalled();
  expect(h.calls).toHaveLength(5);
  h.context.model.provider = "archestra-openai";
  h.context.model.id = "not-in-catalog";
  await h.emit("model_select");
  await h.request();
  expect(h.calls).toHaveLength(5);
  expect(h.execute()).not.toHaveBeenCalled();
});

test.each([
  401, 403, 429, 500,
])("reports safe proxy HTTP %s without releasing tools or exposing response data", async (status) => {
  const h = host();
  await h.emit("session_start");
  await h.request(); // A previous successful call must not leave a usable permit.
  h.fetch.mockResolvedValueOnce(
    new Response("PRIVATE_BODY_WITH_CREDENTIAL_AND_DENIED_TOOL_RESULT", {
      status,
      statusText: "PRIVATE_STATUS_TEXT",
    }),
  );
  const events = await h.request();
  const emitted = JSON.stringify(events);
  expect(emitted).toContain(`HTTP ${status}`);
  expect(emitted).toContain("No local tools were authorized");
  expect(emitted).not.toContain("PRIVATE_");
  expect(events).not.toContainEqual(
    expect.objectContaining({ type: "toolcall_end" }),
  );
  expect(h.execute()).not.toHaveBeenCalled();
});

test("network and SDK failure text cannot become a credential-bearing Pi error", async () => {
  const h = host();
  await h.emit("session_start");
  h.fetch.mockRejectedValueOnce(
    new Error("HTTP 401 PRIVATE_CREDENTIAL https://user:password@example.test"),
  );
  const events = JSON.stringify(await h.request());
  expect(events).toContain("The connected proxy request failed.");
  expect(events).not.toContain("PRIVATE_CREDENTIAL");
  expect(events).not.toContain("password");
  expect(events).not.toContain("HTTP 401");
  expect(h.execute()).not.toHaveBeenCalled();
});
