import { vi } from "vitest";
import config, { parseOpenAppaConfig } from "@/config";
import * as database from "@/database";
import { withDbTransaction } from "@/database";
import {
  ConnectedClientModel,
  ConnectionSetupModel,
  MemberModel,
} from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaYellModel from "@/models/openappa-yell";
import { openappaActor } from "@/openappa/actor";
import { recallYellSession } from "@/openappa/yell-session";
import { CURSOR_DISCONNECT_UNTIL_HEADER } from "@/services/agent-connection-setup/payloads/cursor-guardrails-hook";
import {
  CURSOR_WEB_CALL_ARGUMENT,
  CURSOR_WEB_CALL_HEADER,
  CURSOR_WEB_FETCH_TOOL,
  CURSOR_WEB_SEARCH_TOOL,
  CURSOR_WEB_SETUP_TOOL,
} from "@/services/agent-connection-setup/payloads/cursor-web-tools";
import { issueDisconnectReference } from "@/services/connection-disconnect-reference";
import { issueConnectionHooksToken } from "@/services/connection-hooks-token";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./connection-setup.routes";

const native = vi.hoisted(() => ({
  collectOpenappaMetrics: vi.fn(() => ""),
  initializeOpenappa: vi.fn(),
  dispatchHook: vi.fn(),
  listBundledOpenappaBatteries: vi.fn(async () => []),
  parseOpenappaDeclarations: vi.fn(async () => ({
    include: [],
    serverAliases: [],
    credentials: [],
    routedAnnotators: [],
    runtimeCredentials: [],
    errors: [],
  })),
  validateHostedOpenappaPolicy: vi.fn(async () => []),
  composeOpenappaPolicy: vi.fn(async (input: { root: string }) => ({
    content: input.root,
    errors: [],
  })),
}));
vi.mock("@archestra/openappa-rs", () => native);
vi.mock("@/auth");
vi.mock("@/cache-manager");

import { userHasPermission } from "@/auth";

const RULING =
  '[appa] Blocked: Shell(rm -rf /)\n\nWhy:\n  - destructive command\n\nContinue:\n  - execute_remedy_plan(offer_id: "offer-1")';

const REVIEW_RULING =
  '[appa] Blocked: Shell cannot run yet.\n\nWhy:\n  - requires attention: human-approval\n\nContinue:\n  - archestra__execute_remedy_plan(offer_id: "offer-review", plan: "Submit for approval")';

const NO_REMEDY_RULING =
  "[appa] Blocked: Shell cannot run.\n\nWhy:\n  - readers outside the allowed audience";

const SANITIZER_RULING = [
  "[appa] Blocked: Read cannot run yet.",
  "",
  "Why:",
  "  - reading its result would lower this session's trust: trusted -> suspicious",
  "",
  "Continue:",
  '  - archestra__execute_remedy_plan(offer_id: "offer-accept", plan: "Run this call; this session\'s trust drops to suspicious for the rest of this session")',
  '  - archestra__execute_remedy_plan(offer_id: "offer-clean", plan: "Use sanitizer strip-secrets\'s result")',
  "  An output sanitizer above can admit this result without changing this session's label, if its required steps succeed. You then receive its rewrite, not the raw result: choose it when the rewrite still serves the task.",
].join("\n");

const WEB_RULING = [
  "[appa] Blocked: WebSearch cannot run yet.",
  "Continue:",
  '  - archestra__execute_remedy_plan(offer_id: "offer-web", plan: "Run this call; this session\'s trust drops to suspicious")',
  '  - archestra__execute_remedy_plan(offer_id: "offer-scrub", plan: "Use sanitizer scrub\'s result")',
].join("\n");

// biome-ignore lint/correctness/useHookAtTopLevel: registers Vitest route fixtures, not a React hook
const ctx = useRouteTestApp(routes);

describe("Cursor hooks report chats to Guardrails", () => {
  let openappa: typeof config.openappa;
  let events: Array<Record<string, unknown>>;
  let sessionRecords: boolean;
  let token: string;

  beforeEach(async ({ makeAgent, makeMember }) => {
    openappa = config.openappa;
    config.openappa = parseOpenAppaConfig();
    await GuardrailsDeploymentModel.setEnabled(true);
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      "postgresql://test:test@localhost/test?schema=public",
    );
    native.initializeOpenappa.mockResolvedValue(undefined);
    events = [];
    sessionRecords = false;
    const open = new Set<string>();
    native.dispatchHook.mockReset();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      // Like the runtime: a stop that says which calls it answered holds on
      // any other open call, and a stop that says nothing closes them all.
      if (event.event === "turn_end") {
        if (event.answered_call_ids && open.size > 0)
          return JSON.stringify({ decision: "held", running: [...open] });
        open.clear();
        return JSON.stringify({ decision: "ack" });
      }
      // Like the runtime: a session's first event leaves its record. Only
      // the tests about the marks ask for it; a chat without a record gets
      // no mark, which keeps every other test's answers to its own subject.
      if (event.event === "session_start" && sessionRecords)
        await database.default
          .insert(database.schema.openappaSessionsTable)
          .values({
            actor: openappaActor(event.session_id),
            root: openappaActor(event.session_id),
            organizationId: event.organization_id,
            callerId: event.caller_id,
            sessionId: event.session_id,
            startDecision: { decision: "ack" },
          })
          .onConflictDoNothing();
      if (event.event === "tool_result")
        open.delete(`call:${event.tool_call_id}`);
      if (event.event === "tool_call") {
        open.add(event.operation_id);
        const command = String(event.arguments?.cmd ?? "");
        if (command.includes("needs-review"))
          return JSON.stringify({
            decision: "deny_call",
            feedback: REVIEW_RULING,
            offers: [{ offer_id: "offer-review" }],
            review: [
              { offer_id: "offer-review", text: "Approve the Shell call?" },
            ],
          });
        if (command.includes("no-remedy"))
          return JSON.stringify({
            decision: "deny_call",
            feedback: NO_REMEDY_RULING,
            offers: [],
          });
        if (String(event.arguments?.query ?? "").includes("needs-plan"))
          return JSON.stringify({
            decision: "deny_call",
            feedback: WEB_RULING,
            offers: [{ offer_id: "offer-web" }, { offer_id: "offer-scrub" }],
          });
        if (String(event.arguments?.file_path ?? "").includes("customers"))
          return JSON.stringify({
            decision: "deny_call",
            feedback: SANITIZER_RULING,
            offers: [{ offer_id: "offer-accept" }, { offer_id: "offer-clean" }],
          });
        return JSON.stringify(
          command.includes("rm -rf")
            ? { decision: "deny_call", feedback: RULING }
            : { decision: "allow_call" },
        );
      }
      if (event.event === "tool_result") {
        if (String(event.output).includes("UNRULED"))
          throw new Error(
            "OpenAPPA processing interrupted: annotator=archestra.llm-annotator error=refused",
          );
        return JSON.stringify(
          String(event.output).includes("SECRET")
            ? {
                decision: "replace_output",
                output_source: "runtime",
                approved_output: "[appa] Tool output withheld: secret data",
              }
            : {
                decision: "replace_output",
                output_source: "tool",
                approved_output: event.output,
              },
        );
      }
      return JSON.stringify({ decision: "ack" });
    });
    await makeMember(ctx.user.id, ctx.organizationId);
    vi.mocked(userHasPermission).mockResolvedValue(true);
    const gateway = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "mcp_gateway",
    });
    const { setup, rawToken } = await ConnectionSetupModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      clientId: "cursor",
      platform: "windows",
      baseUrl: "https://example.com/v1",
      mcpGatewayId: gateway.id,
      expiresAt: new Date(Date.now() + 60000),
    });
    await ConnectionSetupModel.claimByToken({ rawToken });
    token = issueConnectionHooksToken({
      setupId: setup.id,
      secret: config.auth.secret ?? "",
    });
  });

  afterEach(() => {
    config.openappa = openappa;
  });

  const report = (
    step: string,
    event: Record<string, unknown>,
    credential = token,
    parentCall?: string,
  ) =>
    ctx.app.inject({
      method: "POST",
      url: "/v1/connection-hooks/cursor",
      headers: {
        authorization: `Bearer ${credential}`,
        ...(parentCall ? { [CURSOR_WEB_CALL_HEADER]: parentCall } : {}),
      },
      payload: {
        step,
        event: {
          conversation_id: "chat-1",
          generation_id: "gen-1",
          model: "composer-1",
          ...event,
        },
      },
    });

  test("a chat on Cursor's own model is one session, and each step reaches the runtime", async () => {
    const started = await report("sessionStart", {});
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().additional_context).toContain("Archestra Guardrails");

    expect(
      (await report("beforeSubmitPrompt", { prompt: "hi" })).json(),
    ).toEqual({});
    const allowed = await report("preToolUse", {
      tool_use_id: "call-1",
      tool_name: "Shell",
      tool_input: { command: "ls" },
    });
    expect(allowed.json()).toEqual({});
    const result = await report("postToolUse", {
      tool_use_id: "call-1",
      tool_name: "Shell",
      tool_input: { command: "ls" },
      tool_output: "README.md",
    });
    expect(result.json()).toEqual({});
    expect((await report("stop", { status: "completed" })).json()).toEqual({});

    const sessionId = `user:${ctx.user.id}|cursor-chat-1`;
    expect(
      events.map((event) => [
        event.event,
        event.operation_id ?? event.tool_call_id,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["prompt", "prompt:gen-1"],
        [
          "tool_call",
          expect.stringMatching(/^call:call-1:Shell:[0-9a-f]{12}$/),
        ],
        ["tool_result", expect.stringMatching(/^call-1:Shell:[0-9a-f]{12}$/)],
        ["turn_end", "turn_end:gen-1"],
      ]),
    );
    for (const event of events) {
      expect(event.session_id).toBe(sessionId);
      expect(event.caller_id).toBe(`user:${ctx.user.id}`);
      expect(event.organization_id).toBe(ctx.organizationId);
    }
    const call = events.find((event) => event.event === "tool_call");
    expect(call?.tool).toBe("Shell");
    expect(call?.arguments).toMatchObject({ cmd: "ls" });
  });

  test("a denied call never runs, and its ruling reaches the agent and the person", async () => {
    const denied = await report("preToolUse", {
      tool_use_id: "call-2",
      tool_name: "Shell",
      tool_input: { command: "rm -rf /" },
    });
    // Cursor hands the model only user_message, so the remedy must be in it.
    expect(denied.json()).toEqual({
      permission: "deny",
      user_message: RULING,
      agent_message: RULING,
    });
  });

  test("the chat that disconnects Cursor is not checked, and no other chat shares its reference", async () => {
    const { reference, expiresAt } = issueDisconnectReference({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      secret: config.auth.secret,
    });
    const prompt = `Read https://example.com/disconnect.md?client=cursor&ref=${reference} and disconnect Cursor.`;
    const destructive = (conversation: string, id: string) =>
      report("preToolUse", {
        conversation_id: conversation,
        tool_use_id: id,
        tool_name: "Shell",
        tool_input: { command: "rm -rf /" },
      });

    // Before its prompt, the chat is checked like any other.
    expect(
      (await destructive("chat-disconnect", "call-0")).json(),
    ).toMatchObject({ permission: "deny" });
    events.length = 0;
    expect(
      (
        await report("beforeSubmitPrompt", {
          conversation_id: "chat-disconnect",
          prompt,
        })
      ).json(),
    ).toEqual({});
    // A call the policy would block runs, and the runtime is told nothing.
    // The hook is told how long that holds, so the chat can finish when this
    // deployment stops answering.
    const exempt = await destructive("chat-disconnect", "call-1");
    expect(exempt.json()).toEqual({});
    expect(exempt.headers[CURSOR_DISCONNECT_UNTIL_HEADER]).toBe(
      String(expiresAt),
    );
    expect(
      (
        await report("postToolUse", {
          conversation_id: "chat-disconnect",
          tool_use_id: "call-1",
          tool_name: "Shell",
          tool_input: { command: "rm -rf /" },
          tool_output: "done",
        })
      ).json(),
    ).toEqual({});
    expect(events).toEqual([]);

    // The same reference in a second chat, and a chat without one, are checked.
    await report("beforeSubmitPrompt", {
      conversation_id: "chat-copy",
      generation_id: "gen-copy",
      prompt,
    });
    const copy = await destructive("chat-copy", "call-2");
    expect(copy.json()).toMatchObject({ permission: "deny" });
    expect(copy.headers[CURSOR_DISCONNECT_UNTIL_HEADER]).toBeUndefined();
    expect((await destructive("chat-other", "call-3")).json()).toMatchObject({
      permission: "deny",
    });
  });

  test("a disconnect reference of another person exempts nothing", async ({
    makeUser,
  }) => {
    const other = await makeUser();
    const { reference } = issueDisconnectReference({
      organizationId: ctx.organizationId,
      userId: other.id,
      secret: config.auth.secret,
    });
    await report("beforeSubmitPrompt", {
      prompt: `Read https://example.com/disconnect.md?ref=${reference}`,
    });
    const denied = await report("preToolUse", {
      tool_use_id: "call-1",
      tool_name: "Shell",
      tool_input: { command: "rm -rf /" },
    });
    expect(denied.json()).toMatchObject({ permission: "deny" });
  });

  test("a call Cursor names with two joined ids is ruled on, and reports under the same id", async () => {
    // Cursor 3.29 sends this id for Read and Grep; the runtime refuses a
    // line break in an identity.
    const id = "call-b351e59d-1\nfc_6b13a36b_1";
    const call = {
      tool_use_id: id,
      tool_name: "Read",
      tool_input: { file_path: "notes.txt" },
    };
    expect((await report("preToolUse", call)).json()).toEqual({});
    expect(
      (await report("postToolUse", { ...call, tool_output: "hello" })).json(),
    ).toEqual({});
    const ruled = events.find((event) => event.event === "tool_call");
    const reported = events.find((event) => event.event === "tool_result");
    expect(ruled?.operation_id).toMatch(/^call:cursor-call-[0-9a-f]{32}$/);
    expect(`call:${reported?.tool_call_id}`).toBe(ruled?.operation_id);
  });

  test("two calls Cursor gives one id are ruled on separately", async () => {
    // Cursor reads a file before it writes it, under the same id.
    const shared = { tool_use_id: "call-9" };
    await report("preToolUse", {
      ...shared,
      tool_name: "Read",
      tool_input: { file_path: "scratch.txt" },
    });
    await report("preToolUse", {
      ...shared,
      tool_name: "Write",
      tool_input: { file_path: "scratch.txt", content: "alpha" },
    });
    expect(
      events
        .filter((event) => event.event === "tool_call")
        .map((event) => event.operation_id),
    ).toEqual([
      expect.stringMatching(/^call:call-9:Read:[0-9a-f]{12}$/),
      expect.stringMatching(/^call:call-9:Write:[0-9a-f]{12}$/),
    ]);
  });

  test("two calls of one tool that Cursor gives one id are told apart by their input", async () => {
    // Cursor saves each web result into a file of its own, as a Write under
    // the id of the call that fetched it. One key for both made the runtime
    // refuse the second, and the hook then blocked it.
    const saved = (name: string) => ({
      tool_use_id: "call-9b\nfc_1_0",
      tool_name: "Write",
      tool_input: { file_path: `agent-tools/${name}.txt`, content: "page" },
    });
    for (const name of ["one", "two"]) {
      const before = await report("preToolUse", saved(name));
      expect(before.statusCode, before.body).toBe(200);
      expect(before.json()).toEqual({});
      expect(
        (
          await report("postToolUse", { ...saved(name), tool_output: "ok" })
        ).json(),
      ).toEqual({});
    }
    const ids = (kind: string, key: string) =>
      events.filter((event) => event.event === kind).map((event) => event[key]);
    const calls = ids("tool_call", "operation_id") as string[];
    expect(new Set(calls).size).toBe(2);
    // Each result answers the call it belongs to.
    expect(ids("tool_result", "tool_call_id")).toEqual(
      calls.map((id) => id.slice("call:".length)),
    );
  });

  test("a Windows file path is ruled on with forward slashes", async () => {
    await report("preToolUse", {
      tool_use_id: "call-10",
      tool_name: "Write",
      tool_input: {
        file_path: "C:\\Users\\me\\.cursor\\hooks.json",
        content: "{}",
      },
    });
    const ruled = events.find((event) => event.event === "tool_call");
    expect(ruled?.arguments).toMatchObject({
      file_path: "C:/Users/me/.cursor/hooks.json",
      content: "{}",
    });
  });

  test("a call that was refused reports no result", async () => {
    // Cursor reports a refusal, Guardrails' or the person's, as a failure.
    const refused = await report("postToolUseFailure", {
      tool_use_id: "call-11",
      tool_name: "Shell",
      tool_input: { command: "rm -rf /" },
      error_message: RULING,
      failure_type: "permission_denied",
    });
    expect(refused.json()).toEqual({});
    expect(events).toEqual([]);
  });

  test("a withheld result of one of Cursor's own tools ends what the chat may do", async () => {
    // Cursor hands the model the result before any hook sees it, so the
    // runtime's label no longer describes what the chat has read.
    const withheld = await report("postToolUse", {
      tool_use_id: "call-3",
      tool_name: "Read",
      tool_input: { path: ".env" },
      tool_output: "SECRET=1",
    });
    expect(withheld.json().additional_context).toContain(
      "[appa] Tool output withheld: secret data",
    );
    expect(withheld.json().additional_context).toContain(
      "Tell the user to continue in a new chat.",
    );

    const next = await report("preToolUse", {
      tool_use_id: "call-3b",
      tool_name: "Shell",
      tool_input: { command: "ls" },
    });
    expect(next.json().permission).toBe("deny");
    expect(next.json().user_message).toContain("refuses the tool calls");
    // Another chat of the same person is not touched.
    const other = await report("preToolUse", {
      conversation_id: "chat-2",
      tool_use_id: "call-3c",
      tool_name: "Shell",
      tool_input: { command: "ls" },
    });
    expect(other.json()).toEqual({});
  });

  test("a result the hook could hand over only in part is not taken as checked", async () => {
    // The hook cuts a very long result and says so. One of Cursor's own
    // tools has reached the model whole, so the chat ends there.
    const own = await report("postToolUse", {
      conversation_id: "chat-long",
      tool_use_id: "call-long-1",
      tool_name: "Read",
      tool_input: { path: "build.log" },
      tool_output: "x".repeat(64),
      tool_output_truncated: true,
    });
    expect(own.json().additional_context).toContain(
      "could check only the first 64 characters of the result of tool call",
    );
    const next = await report("preToolUse", {
      conversation_id: "chat-long",
      tool_use_id: "call-long-2",
      tool_name: "Shell",
      tool_input: { command: "ls" },
    });
    expect(next.json().permission).toBe("deny");
    expect(next.json().user_message).toContain("too large to check");

    // An MCP result is cut to the part that was checked, and the chat goes on.
    const mcp = await report("postToolUse", {
      conversation_id: "chat-long-mcp",
      tool_use_id: "call-long-3",
      tool_name: "MCP:docs__search",
      tool_input: { query: "release" },
      tool_output: "The first part.",
      tool_output_truncated: true,
    });
    expect(mcp.json().updated_mcp_tool_output).toMatch(
      /^The first part\.\n\n\[.* checked the first 15 characters of this result and removed the rest/,
    );
    expect(mcp.json().additional_context).toBeUndefined();
    const after = await report("preToolUse", {
      conversation_id: "chat-long-mcp",
      tool_use_id: "call-long-4",
      tool_name: "Shell",
      tool_input: { command: "ls" },
    });
    expect(after.json()).toEqual({});
  });

  test("a withheld result of an MCP tool is replaced before the model reads it", async () => {
    const withheld = await report("postToolUse", {
      tool_use_id: "call-3d",
      tool_name: "MCP:docs__search",
      tool_input: { query: "keys" },
      tool_output: '{"content":[{"type":"text","text":"SECRET=1"}]}',
    });
    expect(withheld.json()).toEqual({
      updated_mcp_tool_output: "[appa] Tool output withheld: secret data",
    });
    const next = await report("preToolUse", {
      tool_use_id: "call-3e",
      tool_name: "Shell",
      tool_input: { command: "ls" },
    });
    expect(next.json()).toEqual({});
  });

  test("a web tool's call is ruled on as a web search, and its result is checked under the same call", async () => {
    const allowed = await report("preToolUse", {
      tool_use_id: "web-1",
      tool_name: `MCP:${CURSOR_WEB_SEARCH_TOOL}`,
      // A model cannot name the call its CLI process reports for.
      tool_input: { query: "node lts", [CURSOR_WEB_CALL_ARGUMENT]: "made-up" },
    });
    const stamped = allowed.json().updated_input;
    expect(stamped).toEqual({
      query: "node lts",
      [CURSOR_WEB_CALL_ARGUMENT]: expect.stringMatching(/^[\w-]{20,}$/),
    });
    expect(stamped[CURSOR_WEB_CALL_ARGUMENT]).not.toBe("made-up");
    const call = events.find((event) => event.event === "tool_call");
    expect(call?.tool).toBe("WebSearch");
    expect(call?.arguments).toEqual({ query: "node lts" });

    // Cursor reports the result with the id in the call's arguments.
    const result = await report("postToolUse", {
      tool_use_id: "web-1",
      tool_name: `MCP:${CURSOR_WEB_SEARCH_TOOL}`,
      tool_input: stamped,
      tool_output: '{"content":[{"type":"text","text":"SECRET results"}]}',
    });
    expect(result.json()).toEqual({
      updated_mcp_tool_output: "[appa] Tool output withheld: secret data",
    });
    const reported = events.find((event) => event.event === "tool_result");
    expect(`call:${reported?.tool_call_id}`).toBe(call?.operation_id);

    const fetched = await report("preToolUse", {
      tool_use_id: "web-2",
      tool_name: `MCP:${CURSOR_WEB_FETCH_TOOL}`,
      tool_input: { url: "https://example.com" },
    });
    expect(fetched.json().updated_input).toMatchObject({
      url: "https://example.com",
    });
    expect(
      events.filter((event) => event.event === "tool_call").at(-1)?.tool,
    ).toBe("WebFetch");
  });

  test("the web tools' setup tool is ruled on under its own policy name, with no id for a CLI process", async () => {
    const allowed = await report("preToolUse", {
      tool_use_id: "web-setup-1",
      tool_name: `MCP:${CURSOR_WEB_SETUP_TOOL}`,
      tool_input: {},
    });
    expect(allowed.json()).toEqual({});
    expect(
      events.filter((event) => event.event === "tool_call").at(-1)?.tool,
    ).toBe("CursorWebSetup");
  });

  test("a blocked web call is named as Cursor lists the tool, with every plan of its ruling", async () => {
    const blocked = await report("preToolUse", {
      tool_use_id: "web-3",
      tool_name: `MCP:${CURSOR_WEB_SEARCH_TOOL}`,
      tool_input: { query: "needs-plan" },
    });
    const { permission, user_message: message } = blocked.json();
    expect(permission).toBe("deny");
    expect(message).toContain(
      `Blocked: ${CURSOR_WEB_SEARCH_TOOL} cannot run yet.`,
    );
    // The hook can replace this tool's result, so a sanitizer's plan holds.
    expect(message).toContain("Use sanitizer scrub's result");
    expect(blocked.json().updated_input).toBeUndefined();
  });

  test("the CLI process a web call starts reports as a subagent of the calling chat", async () => {
    const allowed = await report("preToolUse", {
      tool_use_id: "web-4",
      tool_name: `MCP:${CURSOR_WEB_FETCH_TOOL}`,
      tool_input: { url: "https://example.com" },
    });
    const webCall = allowed.json().updated_input[CURSOR_WEB_CALL_ARGUMENT];
    const child = (step: string, event: Record<string, unknown>) =>
      report(
        step,
        { conversation_id: "cli-1", generation_id: "cli-gen", ...event },
        token,
        webCall,
      );
    const before = events.length;

    // Its start, its prompt and its end are not the calling chat's.
    expect((await child("sessionStart", {})).json()).toEqual({});
    expect((await child("beforeSubmitPrompt", { prompt: "x" })).json()).toEqual(
      {},
    );
    expect((await child("stop", { status: "completed" })).json()).toEqual({});
    expect(events.slice(before)).toEqual([]);

    // A tool call of its own is ruled on in the calling chat's session.
    const own = await child("preToolUse", {
      tool_use_id: "cli-call-1",
      tool_name: "Shell",
      tool_input: { command: "rm -rf /" },
    });
    expect(own.json().permission).toBe("deny");
    const calls = () => events.filter((event) => event.event === "tool_call");
    expect(calls().at(-1)).toMatchObject({
      tool: "Shell",
      session_id: `user:${ctx.user.id}|cursor-chat-1`,
    });

    // Its own copy of the web result is not a call of the chat, however
    // large: the result is checked when the web tool returns it.
    const copies = calls().length;
    const copy = {
      tool_use_id: "cli-call-copy",
      tool_name: "Write",
      tool_input: {
        path: "C:\\Users\\x\\AppData\\Local\\Temp\\archestra-cursor-web-cli\\projects\\C-Users-x-web-cli-workspace\\agent-tools\\89b12da5.txt",
        contents: "x".repeat(300_000),
      },
    };
    expect((await child("preToolUse", copy)).json()).toEqual({});
    expect(
      (await child("postToolUse", { ...copy, tool_output: "{}" })).json(),
    ).toEqual({});
    expect(calls()).toHaveLength(copies);
    // A write anywhere else is still ruled on.
    await child("preToolUse", {
      ...copy,
      tool_use_id: "cli-call-elsewhere",
      tool_input: { path: "C:\\Users\\x\\notes.txt", contents: "x" },
    });
    expect(calls()).toHaveLength(copies + 1);

    // An id nobody issued names no chat: the process is a chat of its own.
    await report(
      "preToolUse",
      {
        conversation_id: "cli-2",
        tool_use_id: "cli-call-2",
        tool_name: "Shell",
        tool_input: { command: "ls" },
      },
      token,
      "never-issued-0000000000",
    );
    expect(calls().at(-1)?.session_id).toBe(`user:${ctx.user.id}|cursor-cli-2`);
  });

  test("one of Cursor's own tools is not offered an output sanitizer, and cannot take one", async () => {
    const denied = await report("preToolUse", {
      tool_use_id: "call-20",
      tool_name: "Read",
      tool_input: { file_path: "C:\\data\\customers.csv" },
    });
    const ruling = denied.json().user_message as string;
    expect(ruling).toContain('offer_id: "offer-accept"');
    expect(ruling).not.toContain("offer-clean");
    expect(ruling).not.toContain("An output sanitizer above");

    // The model learned the plan some other way: it is refused, with why.
    const sanitizer = await report("preToolUse", {
      tool_use_id: "call-21",
      tool_name: "MCP:archestra__execute_remedy_plan",
      tool_input: {
        offer_id: "offer-clean",
        plan: "Use sanitizer strip-secrets's result",
      },
    });
    expect(sanitizer.json().permission).toBe("deny");
    expect(sanitizer.json().user_message).toContain("Choose another plan");
    // The plan that can be honoured goes on to the gateway.
    const accept = await report("preToolUse", {
      tool_use_id: "call-22",
      tool_name: "MCP:archestra__execute_remedy_plan",
      tool_input: {
        offer_id: "offer-accept",
        plan: "Run this call; this session's trust drops to suspicious for the rest of this session",
      },
    });
    expect(accept.json().updated_input.offer_id).toBe("offer-accept");
  });

  test("a ruling with no remedy tells the agent to stop", async () => {
    const denied = await report("preToolUse", {
      tool_use_id: "call-23",
      tool_name: "Shell",
      tool_input: { command: "echo no-remedy" },
    });
    expect(denied.json().user_message).toBe(
      `${NO_REMEDY_RULING}\n\n[appa] This ruling offers no remedy plan. Explain the ruling to the user and STOP this blocked action. Do not retry the same call, directly or through a wrapper.`,
    );
  });

  test("a subagent's steps join its chat's session, however deep it is", async () => {
    const child = { conversation_id: "sub-1", parent_agent_id: "chat-1" };
    const grandchild = { conversation_id: "sub-2", parent_agent_id: "sub-1" };
    // The child starts a subagent of its own: Cursor names only the direct
    // parent on the grandchild's steps.
    const spawn = await report("preToolUse", {
      ...child,
      tool_use_id: "task-2",
      tool_name: "Task",
      tool_input: { prompt: "go" },
    });
    expect(spawn.json()).toEqual({});
    for (const [who, id] of [
      [child, "call-30"],
      [grandchild, "call-31"],
    ] as const) {
      const call = {
        tool_use_id: id,
        tool_name: "Shell",
        tool_input: { command: "ls" },
      };
      expect((await report("preToolUse", { ...who, ...call })).json()).toEqual(
        {},
      );
      expect(
        (
          await report("postToolUse", { ...who, ...call, tool_output: "ok" })
        ).json(),
      ).toEqual({});
    }
    expect(events.length).toBeGreaterThan(4);
    for (const event of events)
      expect(event.session_id).toBe(`user:${ctx.user.id}|cursor-chat-1`);
  });

  test("a background subagent's running call stays open when the main loop ends and at a new prompt", async () => {
    const child = { conversation_id: "sub-1", parent_agent_id: "chat-1" };
    const call = {
      ...child,
      tool_use_id: "call-40",
      tool_name: "Shell",
      tool_input: { command: "sleep 60" },
    };
    expect((await report("preToolUse", call)).json()).toEqual({});
    // The main agent answers and its loop ends while the command still runs.
    await report("stop", { status: "completed" });
    // The person sends the main agent another message meanwhile.
    await report("beforeSubmitPrompt", { generation_id: "gen-2" });
    await report("stop", { generation_id: "gen-2", status: "completed" });
    // Nothing told the runtime to close the call: every stop named what it
    // answered, and the prompt, which ends the turn before it, was not sent.
    const between = events.filter(
      (event) => event.event === "turn_end" || event.event === "prompt",
    );
    expect(between).toHaveLength(3);
    for (const event of between)
      expect(event).toMatchObject({ event: "turn_end", answered_call_ids: [] });

    // The result arrives and is checked like any other.
    expect(
      (await report("postToolUse", { ...call, tool_output: "done" })).json(),
    ).toEqual({});
    expect(events.at(-1)).toMatchObject({
      event: "tool_result",
      tool_call_id: expect.stringContaining("call-40"),
    });
    // With the call reported, the next prompt reaches the runtime again.
    await report("beforeSubmitPrompt", { generation_id: "gen-3" });
    expect(events.at(-1)).toMatchObject({
      event: "prompt",
      operation_id: "prompt:gen-3",
    });
  });

  test("a subagent's call that the person refused is closed when the main loop ends", async () => {
    const call = {
      conversation_id: "sub-1",
      parent_agent_id: "chat-1",
      tool_use_id: "call-41",
      tool_name: "Shell",
      tool_input: { command: "echo skipped" },
    };
    expect((await report("preToolUse", call)).json()).toEqual({});
    // The person pressed Skip in Cursor's own prompt: the call never runs.
    await report("postToolUseFailure", {
      ...call,
      failure_type: "permission_denied",
      error_message: "Rejected by user",
    });
    await report("stop", { status: "completed" });
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        event: "turn_end",
        operation_id: "turn_end:gen-1",
      }),
    );
    expect(events.at(-1)).not.toHaveProperty("answered_call_ids");
  });

  test("a chat's model is told to show the session mark on each tool result until an answer shows it", async () => {
    sessionRecords = true;
    // Cursor does not pass a new chat's opening context on to the model, so
    // the mark is not asked for there.
    const started = await report("sessionStart", { generation_id: "" });
    expect(started.json().additional_context).not.toContain(
      "protected session",
    );
    let calls = 0;
    const result = async () => {
      const call = {
        tool_use_id: `call-5${calls++}`,
        tool_name: "Shell",
        tool_input: { command: `echo ${calls}` },
      };
      await report("preToolUse", call);
      const answer = await report("postToolUse", {
        ...call,
        tool_output: "ok",
      });
      return answer.json().additional_context as string | undefined;
    };
    const first = await result();
    const mark = first?.match(
      /▄█▄▄▄█▄ {2}protected session [0-9A-Z]{3}-[0-9A-Z]{4}/,
    )?.[0];
    expect(mark).toBeDefined();
    // Asked for as a heading, which Cursor renders on a line of its own
    // even when the model leaves no empty line around it.
    expect(first).toContain(
      `at the start of your next answer to them, and do not repeat it later: ###### ${mark}`,
    );
    // The loop's later results repeat the line, so the one that comes last
    // before the answer carries it.
    expect(await result()).toContain(
      `unless an answer of yours in this chat already shows it: ###### ${mark}`,
    );

    // An answer that leaves the mark out keeps the request going.
    await report("afterAgentResponse", { text: "Done." });
    expect(await result()).toContain(`###### ${mark}`);

    // An answer that shows it settles it: nothing more is asked.
    await report("afterAgentResponse", { text: `###### ${mark}\nDone.` });
    expect(await result()).toBeUndefined();
  });

  test("a chat that keeps leaving the session mark out is no longer asked", async () => {
    sessionRecords = true;
    const result = async (id: string) => {
      const call = {
        tool_use_id: id,
        tool_name: "Shell",
        tool_input: { command: `echo ${id}` },
      };
      await report("preToolUse", call);
      const answer = await report("postToolUse", {
        ...call,
        tool_output: "ok",
      });
      return answer.json().additional_context as string | undefined;
    };
    expect(await result("call-70")).toContain("protected session");
    for (const id of ["call-71", "call-72"]) {
      await report("afterAgentResponse", { text: "Done." });
      expect(await result(id)).toContain("protected session");
    }
    await report("afterAgentResponse", { text: "Done." });
    expect(await result("call-73")).toBeUndefined();
  });

  test("a subagent is told to show its marks in its own view, and the agent that started it is told they are not part of the reply", async () => {
    sessionRecords = true;
    const task = {
      tool_use_id: "task-60",
      tool_name: "Task",
      tool_input: { prompt: "go" },
    };
    await report("preToolUse", task);
    const call = {
      conversation_id: "sub-60",
      parent_agent_id: "chat-1",
      tool_use_id: "call-60",
      tool_name: "Shell",
      tool_input: { command: "ls" },
    };
    await report("preToolUse", call);
    const first = await report("postToolUse", { ...call, tool_output: "ok" });
    const context = first.json().additional_context as string;
    // The subagent shows that it started now, and that it finished as the
    // last line of its reply; the chat's own session mark is the main agent's.
    expect(context).toMatch(
      /at the start of your next message: ###### ▄█▄▄▄█▄ {2}started subagent ([0-9A-Z]{3}-[0-9A-Z]{4}) End your final reply with this exact line, on a line of its own and with its six # signs, as its last line after everything else: ###### ▄█▄▄▄█▄ {2}finished subagent \1/,
    );
    expect(context).toContain("even when your task asks for an exact reply");
    expect(context).not.toContain("protected session");
    // Asked once.
    const second = { ...call, tool_use_id: "call-61" };
    await report("preToolUse", second);
    expect(
      (await report("postToolUse", { ...second, tool_output: "ok" })).json(),
    ).toEqual({});

    // Cursor hands the reply to the main agent as written, mark included.
    const returned = await report("postToolUse", {
      ...task,
      tool_output: JSON.stringify({
        status: "success",
        agentId: "sub-60",
        isBackground: false,
      }),
    });
    expect(returned.json().additional_context).toContain(
      "not part of its answer",
    );
    expect(returned.json().additional_context).not.toMatch(
      /(?:started|finished) subagent [0-9A-Z]{3}-/,
    );

    // A subagent that called no tool showed no mark: nothing to say.
    const quiet = { ...task, tool_use_id: "task-62" };
    await report("preToolUse", quiet);
    const silent = await report("postToolUse", {
      ...quiet,
      tool_output: JSON.stringify({
        status: "success",
        agentId: "sub-62",
        isBackground: false,
      }),
    });
    expect(silent.json().additional_context ?? "").not.toContain(
      "not part of its answer",
    );
    // A background subagent replies later, so the note comes with its start.
    const background = { ...task, tool_use_id: "task-63" };
    await report("preToolUse", background);
    const launched = await report("postToolUse", {
      ...background,
      tool_output: JSON.stringify({
        status: "success",
        agentId: "sub-63",
        isBackground: true,
      }),
    });
    expect(launched.json().additional_context).toContain("may carry");
  });

  test("a subagent's question is handed back to the agent that started it", async () => {
    const asked = await report("preToolUse", {
      conversation_id: "sub-1",
      parent_agent_id: "chat-1",
      tool_use_id: "call-32",
      tool_name: "MCP:archestra__ask_user",
      tool_input: {
        question: "Approve?",
        options: [{ label: "Approve" }, { label: "Deny" }],
        remedy_offer_ids: ["offer-review"],
      },
    });
    expect(asked.json().permission).toBe("deny");
    // The subagent's own plan call opened the review, so the parent is told
    // to ask first: a second plan call before the question records nothing.
    expect(asked.json().user_message).toMatch(
      /review for that offer is already open.*asks the person in the main chat with ask_user.*execute_remedy_plan only after the person has approved/,
    );
    expect(events).toEqual([]);

    const plain = await report("preToolUse", {
      conversation_id: "sub-1",
      parent_agent_id: "chat-1",
      tool_use_id: "call-32b",
      tool_name: "MCP:archestra__ask_user",
      tool_input: {
        question: "Which folder?",
        options: [{ label: "src" }, { label: "docs" }],
      },
    });
    expect(plain.json().permission).toBe("deny");
    expect(plain.json().user_message).toContain("put the question in it");
    expect(plain.json().user_message).not.toContain("execute_remedy_plan");
    expect(events).toEqual([]);
  });

  test("a subagent's return needs no declaration, and the agent is told so", async () => {
    const declared = await report("preToolUse", {
      tool_use_id: "call-33",
      tool_name: "MCP:archestra__execute_remedy_plan",
      tool_input: { label: { trust: "suspicious", audience: ["self"] } },
    });
    expect(declared.json().permission).toBe("deny");
    expect(declared.json().user_message).toContain(
      "Start the subagent with the Task tool now.",
    );
  });

  test("Break the glass lets a call that waits for approval run, on the record", async () => {
    // On this line the approval mode is a deployment setting.
    config.openappa = { ...config.openappa, humanApprovalMode: "everywhere" };
    const call = {
      tool_use_id: "call-34",
      tool_name: "Shell",
      tool_input: { command: "echo needs-review" },
    };
    expect((await report("preToolUse", call)).json()).toEqual({});
    // The runtime never released the call, so its result is not reported.
    const reported = events.length;
    expect(
      (
        await report("postToolUse", { ...call, tool_output: "needs-review" })
      ).json(),
    ).toEqual({});
    expect(events.filter((event) => event.event === "tool_result")).toEqual([]);
    expect(events.length).toBe(reported);
    const yells = await OpenAppaYellModel.list({
      organizationId: ctx.organizationId,
      status: "all",
      limit: 10,
    });
    expect(yells.data.map((yell) => [yell.kind, yell.sessionId])).toEqual([
      ["approval_waived", `user:${ctx.user.id}|cursor-chat-1`],
    ]);
  });

  test("without that setting the same call waits for a person", async () => {
    const denied = await report("preToolUse", {
      tool_use_id: "call-35",
      tool_name: "Shell",
      tool_input: { command: "echo needs-review" },
    });
    expect(denied.json().user_message).toBe(REVIEW_RULING);
  });

  test("a yell names this chat to the gateway, and its result is the gateway's own", async () => {
    const args = { message: "stuck on a block", with_trajectory: true };
    const call = {
      tool_use_id: "call-36",
      tool_name: "MCP:archestra__yell",
      tool_input: args,
    };
    expect((await report("preToolUse", call)).json()).toEqual({});
    expect(
      await recallYellSession({ organizationId: ctx.organizationId, args }),
    ).toEqual({
      session: {
        organization_id: ctx.organizationId,
        caller_id: `user:${ctx.user.id}`,
        session_id: `user:${ctx.user.id}|cursor-chat-1`,
      },
      callId: expect.stringMatching(
        /^call-36:MCP:archestra__yell:[0-9a-f]{12}$/,
      ),
    });
    const before = events.length;
    expect(
      (
        await report("postToolUse", {
          ...call,
          tool_output: '{"content":[{"type":"text","text":"Report recorded"}]}',
        })
      ).json(),
    ).toEqual({});
    expect(events.length).toBe(before);
  });

  test("a result Guardrails could not check is named unchecked to the agent", async () => {
    const unchecked = await report("postToolUse", {
      tool_use_id: "call-7",
      tool_name: "Read",
      tool_input: { path: "notes.md" },
      tool_output: "UNRULED",
    });
    expect(unchecked.statusCode, unchecked.body).toBe(200);
    expect(unchecked.json().additional_context).toMatch(
      /could not check the result of tool call call-7:Read:[0-9a-f]{12}: .*Treat that result as unchecked\./,
    );
  });

  test("the remedy call carries the chat's trajectory to the gateway", async () => {
    const remedy = await report("preToolUse", {
      tool_use_id: "call-4",
      tool_name: "MCP:archestra__execute_remedy_plan",
      tool_input: {
        offer_id: "offer-1",
        trajectory: { v: 1, session_id: "someone-else" },
      },
    });
    const updated = remedy.json().updated_input;
    expect(updated.offer_id).toBe("offer-1");
    expect(updated.trajectory).toMatchObject({
      v: 1,
      session_id: `user:${ctx.user.id}|cursor-chat-1`,
    });
    expect(updated.execution).toEqual({
      v: 1,
      kind: "appa_remedy",
      call_id: expect.stringMatching(
        /^call-4:MCP:archestra__execute_remedy_plan:[0-9a-f]{12}$/,
      ),
      tool_name: "archestra__execute_remedy_plan",
      original_arguments: JSON.stringify({ offer_id: "offer-1" }),
    });
    expect(events.some((event) => event.event === "tool_call")).toBe(false);
  });

  test("a review question carries the chat's trajectory, so the gateway shows this chat's review", async () => {
    const question = {
      question: "Approve?",
      header: "Approval",
      options: [{ label: "Approve" }, { label: "Deny" }],
    };
    const review = await report("preToolUse", {
      tool_use_id: "call-12",
      tool_name: "MCP:archestra__ask_user",
      tool_input: {
        ...question,
        remedy_offer_ids: ["offer-1"],
        trajectory: { v: 1, session_id: "someone-else" },
      },
    });
    expect(review.json().updated_input).toEqual({
      ...question,
      remedy_offer_ids: ["offer-1"],
      trajectory: expect.objectContaining({
        v: 1,
        session_id: `user:${ctx.user.id}|cursor-chat-1`,
      }),
    });

    // An ordinary question names no review, so nothing is added to it.
    const ordinary = await report("preToolUse", {
      tool_use_id: "call-13",
      tool_name: "MCP:archestra__ask_user",
      tool_input: question,
    });
    expect(ordinary.json()).toEqual({});

    // The runtime released no question, so its answer is not reported to it.
    const answered = await report("postToolUse", {
      tool_use_id: "call-12",
      tool_name: "MCP:archestra__ask_user",
      tool_input: { ...question, remedy_offer_ids: ["offer-1"] },
      tool_output: "The user picked: Approve.",
    });
    expect(answered.json()).toEqual({});
    expect(events.some((event) => event.event === "tool_result")).toBe(false);
  });

  test("a chat on a Model Router model is left to the LLM proxy", async () => {
    const proxied = await report("preToolUse", {
      model: "openai:gpt-5.4",
      tool_use_id: "call-5",
      tool_name: "Shell",
      tool_input: { command: "rm -rf /" },
    });
    expect(proxied.json()).toEqual({});
    expect(events).toEqual([]);
  });

  test("with enforcement off, calls run and the runtime rules on nothing", async () => {
    await GuardrailsDeploymentModel.setEnabled(false);
    const unchecked = await report("preToolUse", {
      tool_use_id: "call-6",
      tool_name: "Shell",
      tool_input: { command: "rm -rf /" },
    });
    expect(unchecked.json()).toEqual({});
    expect(events.some((event) => event.event === "tool_call")).toBe(false);
  });

  test("only a live Cursor installation's credential is accepted", async ({
    makeAgent,
  }) => {
    expect((await report("stop", {}, "chk1_not-a-token")).statusCode).toBe(401);
    const instructionsShaped = token.replace(/^chk1_/, "cmi1_");
    expect((await report("stop", {}, instructionsShaped)).statusCode).toBe(401);

    const gateway = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "mcp_gateway",
    });
    const other = await ConnectionSetupModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      clientId: "claude-code",
      platform: "linux",
      baseUrl: "https://example.com/v1",
      mcpGatewayId: gateway.id,
      expiresAt: new Date(Date.now() + 60000),
    });
    await ConnectionSetupModel.claimByToken({ rawToken: other.rawToken });
    const otherToken = issueConnectionHooksToken({
      setupId: other.setup.id,
      secret: config.auth.secret ?? "",
    });
    expect((await report("stop", {}, otherToken)).statusCode).toBe(403);

    expect((await report("stop", {})).statusCode).toBe(200);
    await withDbTransaction((tx) =>
      ConnectedClientModel.revokeForUser({
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        clientId: "cursor",
        revokedByUserId: ctx.user.id,
        tx,
      }),
    );
    expect((await report("stop", {})).statusCode).toBe(403);
  });

  test("a person who left the organization loses the hook", async () => {
    await MemberModel.deleteAllByUserId(ctx.user.id);
    expect((await report("stop", {})).statusCode).toBe(403);
  });
});
