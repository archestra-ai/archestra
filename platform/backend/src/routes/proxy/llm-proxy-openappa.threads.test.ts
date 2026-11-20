import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { ENCRYPTED_CHAT_REDACTED_MARKER } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import {
  guardrailCallHeader,
  internalCallHeader,
} from "@/clients/internal-call";
import config from "@/config";
import { encryptedChatDekFingerprint } from "@/content-encryption/encrypted-chat";
import db, * as database from "@/database";
import { logRingBuffer } from "@/logging/log-ring-buffer";
import { VirtualApiKeyModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaThreadStateModel from "@/models/openappa-thread-state";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import { stageHitlReview } from "@/openappa/hitl-review";
import { buildNoticeArguments } from "@/openappa/notice";
import * as appaService from "@/openappa/service";
import { parseTrajectoryStamp } from "@/openappa/trajectory-stamp";
import { describe, expect, test } from "@/test";
import { native } from "@/test/openappa-native-mock";
import {
  noticeFrom,
  useOpenAppaProxyHarness,
} from "@/test/openappa-proxy-harness";
import { anthropicAdapterFactory } from "./adapters";

vi.mock(
  "@archestra/openappa-rs",
  async () => (await import("@/test/openappa-native-mock")).native,
);
vi.mock("@/cache-manager");

describe("OpenAPPA on the existing LLM proxy", () => {
  const h = useOpenAppaProxyHarness();

  describe("provider-side threads", () => {
    const create = () => ({
      ...h.payload(false),
      thread: { type: "create" },
    });
    const continuation = (previous: string) => ({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      stream: false,
      thread: { type: "continue", previous_message_id: previous },
      messages: [{ role: "user", content: "and now?" }],
    });

    test("rules on a continue with the tools the thread was created with, and sends it without them", async () => {
      h.options = { includeToolUse: false, streamStopReason: "end_turn" };
      const created = await h.post(create());
      expect(created.statusCode, created.body).toBe(200);

      const followed = await h.post(continuation(created.json().id));

      expect(followed.statusCode, followed.body).toBe(200);
      const sent = h.providerRequests.at(-1) as Record<string, unknown>;
      expect(sent.thread).toEqual({
        type: "continue",
        previous_message_id: created.json().id,
      });
      // The thread owns the tools: the ruling borrowed them and sent none.
      expect(sent.tools).toBeUndefined();
      expect(
        (sent.messages as Array<{ role: string }>).map((m) => m.role),
      ).toEqual(["user"]);
    });

    test("a continue that sends changed tools still rules on the results of the call they answer", async () => {
      const created = await h.post(create());
      expect(created.statusCode, created.body).toBe(200);
      const call = (
        created.json().content as Array<{ type: string; id: string }>
      ).find((block) => block.type === "tool_use");
      expect(call).toBeDefined();
      h.options = { includeToolUse: false, streamStopReason: "end_turn" };
      h.events.length = 0;
      const processed = vi.spyOn(appaService, "processProxyResults");

      const followed = await h.post({
        ...h.payload(false, [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call?.id,
                content: "RAW TOOL OUTPUT",
              },
            ],
          },
        ]),
        thread: { type: "continue", previous_message_id: created.json().id },
      });

      expect(followed.statusCode, followed.body).toBe(200);
      // The result was ruled on as the answer to the call the thread holds...
      expect(h.events.map((event) => event.event)).toContain("tool_result");
      expect(
        processed.mock.calls.flatMap(([params]) => params.results),
      ).toEqual([expect.objectContaining({ name: "get_weather" })]);
      // ...which the provider never sees as a message of this request.
      const sent = h.providerRequests.at(-1) as {
        tools?: unknown[];
        messages: Array<{ role: string }>;
      };
      expect(sent.messages.map((message) => message.role)).toEqual(["user"]);
      expect(sent.tools?.length).toBeGreaterThan(0);
      // The consumed response keeps no calls.
      const [row] = await db
        .select()
        .from(database.schema.openappaThreadStatesTable)
        .where(
          eq(
            database.schema.openappaThreadStatesTable.messageId,
            created.json().id,
          ),
        );
      expect(row.calls).toBeNull();
    });

    test("answers a continue it has no state for with the provider's thread_not_found, under its own request id", async () => {
      const response = await h.post(continuation("msg_unknown"));

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        type: "error",
        error: {
          type: "not_found_error",
          details: { error_code: "thread_not_found" },
        },
      });
      expect(response.json().request_id).toMatch(/^req_archestra_/);
      // Nothing reached the provider: the client replays with a create.
      expect(h.providerRequests).toHaveLength(0);
    });

    test("answers a continue from a response the client holds a rewrite of with a replay request", async () => {
      h.options = { includeToolUse: false, streamStopReason: "end_turn" };
      const created = await h.post(create());
      const id = created.json().id as string;
      // The client holds text where the provider holds the model's own output.
      await db
        .update(database.schema.openappaThreadStatesTable)
        .set({ diverged: true })
        .where(eq(database.schema.openappaThreadStatesTable.messageId, id));
      const before = h.providerRequests.length;

      const response = await h.post(continuation(id));

      expect(response.statusCode).toBe(404);
      expect(h.providerRequests).toHaveLength(before);
    });

    test("answers a second continue from the same response with the provider's thread_already_continued", async () => {
      h.options = { includeToolUse: false, streamStopReason: "end_turn" };
      const created = await h.post(create());
      const id = created.json().id as string;
      const first = await h.post(continuation(id));
      expect(first.statusCode, first.body).toBe(200);
      const before = h.providerRequests.length;

      const repeated = await h.post(continuation(id));

      expect(repeated.statusCode).toBe(400);
      expect(repeated.json()).toMatchObject({
        type: "error",
        error: { details: { error_code: "thread_already_continued" } },
      });
      expect(repeated.json().request_id).toMatch(/^req_archestra_/);
      // The provider refuses a repeat as well; the client replays with a create.
      expect(h.providerRequests).toHaveLength(before);
    });

    test("makes the client resend without a thread when the thread store cannot be read", async () => {
      vi.spyOn(OpenAppaThreadStateModel, "find").mockRejectedValue(
        new Error("store unavailable"),
      );

      const response = await h.post(continuation("msg_store_down"));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        type: "error",
        error: { details: { error_code: "thread_unsupported_request" } },
      });
      // Never ruled on blind: nothing reached the provider.
      expect(h.providerRequests).toHaveLength(0);
    });

    test("leaves a thread continue alone while Guardrails enforcement is off", async () => {
      h.options = { includeToolUse: false, streamStopReason: "end_turn" };
      vi.spyOn(GuardrailsDeploymentModel, "get").mockResolvedValue({
        id: "deployment",
        enabled: false,
        unsupportedClientAction: "bypass",
        breakTheGlassEnabled: true,
        humanApprovalMode: "block",
        unapprovableBlockMode: "refuse",
        annotatorModelId: null,
        annotatorLlmApiKeyId: null,
      });

      const response = await h.post(continuation("msg_made_elsewhere"));

      expect(response.statusCode, response.body).toBe(200);
      expect(
        (h.providerRequests.at(-1) as { thread: unknown }).thread,
      ).toMatchObject({ previous_message_id: "msg_made_elsewhere" });
    });
  });

  test("passes a tool-less request without opening a root", async () => {
    const body = h.payload(false);
    // OpenCode's title generation and similar client-side questions declare no
    // tools: they proposed nothing, so there is nothing to govern.
    body.tools = [];
    h.options = { includeToolUse: false, streamStopReason: "end_turn" };

    const response = await h.post(body);

    expect(response.statusCode, response.body).toBe(200);
    expect(h.events).toEqual([]);
    expect(h.providerRequests).toHaveLength(1);
  });

  test("still reports a result carried by a request that declares no tools", async () => {
    // A client that drops its tool list on the continuation must not thereby
    // keep the runtime from seeing the result of a call it released.
    const body = h.payload(false, [
      { role: "user", content: "Check the weather" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_weather",
            name: "get_weather",
            input: { location: "SF" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_weather",
            content: "RAW TOOL OUTPUT",
          },
        ],
      },
    ]);
    body.tools = [];
    h.options = { includeToolUse: false, streamStopReason: "end_turn" };

    const response = await h.post(body);

    expect(response.statusCode, response.body).toBe(200);
    expect(h.events.map((event) => event.event)).toContain("tool_result");
    const sent = h.providerRequests.at(-1) as {
      messages: { role: string; content: Record<string, unknown>[] }[];
    };
    expect(sent.messages[2].content[0].content).toBe("APPROVED REPLACEMENT");
  });

  test("reports one prompt and one turn end for a turn that runs no tool", async () => {
    h.options = { includeToolUse: false, streamStopReason: "end_turn" };

    await h.post(h.payload(false));

    expect(h.events.map((event) => event.event)).toEqual([
      "session_start",
      "prompt",
      "turn_end",
    ]);
  });

  test("keeps the turn open while the client still owes a tool result", async () => {
    await h.post(h.payload(false));

    expect(h.events.map((event) => event.event)).toEqual([
      "session_start",
      "prompt",
      "tool_call",
    ]);
  });

  test("a client disconnect mid-stream causes no write-after-end and the turn still cleans up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* gatedStream() {
      yield {
        type: "message_start",
        message: {
          id: "msg-disconnect",
          type: "message",
          container: null,
          role: "assistant",
          content: [],
          model: "claude-3-5-sonnet-20241022",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      };
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: [] },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "before disconnect" },
      };
      await gate;
      // The client is gone: every frame from here reaches writeToClient with
      // reply.raw already destroyed.
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " after disconnect" },
      };
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      };
      yield { type: "message_stop" };
    }
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          messages: { create: async () => gatedStream() },
        }) as never,
    );
    const startedAt = Date.now();
    let serverRaw: ServerResponse | undefined;
    const writesAfterDestroy: string[] = [];
    h.app.addHook("preHandler", async (_request, reply) => {
      serverRaw = reply.raw;
      // Observe the socket boundary the destroyed guard is meant to close:
      // without it, writeToClient keeps pushing frames into the dead socket.
      const original = reply.raw.write.bind(reply.raw);
      reply.raw.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (reply.raw.destroyed) writesAfterDestroy.push(String(chunk));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof reply.raw.write;
    });

    // A real socket: app.inject buffers the body and cannot disconnect.
    const baseUrl = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(
      `${baseUrl}/v1/anthropic/${h.agent.id}/v1/messages`,
      {
        method: "POST",
        headers: {
          ...internalCallHeader(),
          ...h.headers(),
          "content-type": "application/json",
        },
        body: JSON.stringify(h.payload(true)),
      },
    );
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("Expected a streaming body");
    const reader = response.body.getReader();
    await reader.read();
    // The client hangs up; the server socket is destroyed.
    await reader.cancel();
    await vi.waitFor(() => expect(serverRaw?.destroyed).toBe(true), {
      timeout: 5000,
    });

    // The upstream turn keeps streaming into the dead socket.
    release();
    await vi.waitFor(
      async () => {
        const rows = await db
          .select()
          .from(database.schema.interactionsTable)
          .where(eq(database.schema.interactionsTable.profileId, h.agent.id));
        expect(rows).toHaveLength(1);
      },
      { timeout: 5000 },
    );

    // The cleanup path ran the completed turn to the end: usage was recorded.
    const [row] = await db
      .select()
      .from(database.schema.interactionsTable)
      .where(eq(database.schema.interactionsTable.profileId, h.agent.id));
    expect(row.outputTokens).toBeGreaterThan(0);

    // The guard's contract: not one byte is written after the disconnect, so
    // no write-after-end can escape.
    expect(writesAfterDestroy).toEqual([]);

    // Without the destroyed guard the first post-disconnect frame throws
    // write-after-destroy out of writeToClient and handleError logs it.
    const errors = logRingBuffer
      .getRecent({ limit: 250 })
      .filter((record) => record.time >= startedAt && record.level >= 50)
      .map((record) => record.msg)
      .join("\n");
    expect(errors).not.toMatch(
      /write after end|write after a stream was destroyed|ERR_STREAM_DESTROYED/i,
    );
  });

  test("native failures release no tool call and leak no diagnostics", async () => {
    h.fail = true;

    const response = await h.post(h.payload(false));

    expect(response.statusCode).toBe(500);
    expect(response.headers["x-should-retry"]).toBe("false");
    expect(response.body).not.toContain("private native database error");
    expect(response.body).toContain("Guardrails failed unexpectedly");
  });

  test("a refused policy names what to fix and is not a retryable outage", async () => {
    h.fail = true;
    h.failure = Object.assign(
      new Error(
        'unsupported policy: tool "grain__*" has an invalid qualified identity',
      ),
      { code: "policy_refused" },
    );

    const response = await h.post(h.payload(false));

    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).toContain(
      'Guardrails refused the organization\'s policy (unsupported policy: tool "grain__*" has an invalid qualified identity)',
    );
  });

  test("a conversation whose content the policy runtime cannot store fails once, with what to do", async () => {
    h.fail = true;
    h.failure = Object.assign(
      new Error(
        "OpenAPPA processing interrupted: storage failure: receipt storage failed: PostgreSQL ERROR (SQLSTATE 22P05)",
      ),
      { code: "storage" },
    );

    const response = await h.post(h.payload(false));

    expect(response.statusCode).toBe(400);
    expect(response.headers["x-should-retry"]).toBe("false");
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(response.json().error.message).toMatch(
      /^Guardrails cannot store this conversation because it contains a NUL character \(U\+0000\), usually from a tool that printed binary data\. Every retry sends the same conversation and fails the same way\. Rewind the conversation to before that tool output, or start a new conversation\./,
    );
  });

  test("does not trust a remote caller's delegation chain", async () => {
    await h.allowUnauthenticatedCallers();
    const response = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "203.0.113.20",
      headers: {
        ...h.unauthenticatedHeaders(),
        "x-archestra-source": "a2a",
        "x-archestra-agent-id": `a637fb55-989b-4f01-a251-e7e277c65f05:${h.agent.id}`,
      },
      payload: h.payload(false),
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(h.providerRequests).toHaveLength(0);
  });

  test.for([
    { command: "yell", stream: false },
    { command: "yell", stream: true },
    { command: "yell", stream: false, malformed: true },
    { command: "yell", stream: true, malformed: true },
  ])("recovers $command from blocked Claude history without releasing the child result (stream=$stream, malformed=$malformed)", async ({
    command,
    stream,
    malformed,
  }, { seedAndAssignArchestraTools }) => {
    await seedAndAssignArchestraTools(h.agent.id);
    const unverified = "UNVERIFIED CHILD OUTPUT";
    const history = [
      { role: "user", content: "Earlier task content" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "unrecorded-spawn",
            name: "Agent",
            input: { prompt: "Earlier delegated task" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "unrecorded-spawn",
            content: malformed
              ? `<task-notification><status>completed</status><result>${unverified}`
              : unverified,
          },
        ],
      },
    ];
    const reportArgs = {
      message:
        "OpenAPPA blocked the conversation because a child result was not recorded",
      with_trajectory: true,
    };
    h.options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: { name: `archestra__${command}`, input: reportArgs },
      streamingToolUse: { name: `archestra__${command}`, input: reportArgs },
    };
    const requestText =
      "Please send a bug report about the confusing guardrails failure";
    const send = (messages: unknown[], reportingAvailable = true) => {
      const body = h.payload(stream, messages);
      body.tools.push({
        name: "Bash",
        description: "Run a local command",
        input_schema: { type: "object", properties: {} },
      });
      if (reportingAvailable)
        body.tools.push({
          name: `archestra__${command}`,
          description: "Report OpenAPPA feedback",
          input_schema: { type: "object", properties: {} },
        });
      return h.app.inject({
        method: "POST",
        url: h.url(),
        remoteAddress: "127.0.0.1",
        headers: {
          ...internalCallHeader(),
          ...h.externalClientHeaders(),
          "user-agent": "claude-cli/2.1.0 (external, cli)",
          "x-claude-code-session-id": "blocked-reporting",
        },
        payload: body,
      });
    };
    const blocked = await send(
      [...history, { role: "user", content: "Continue" }],
      false,
    );
    expect(blocked.statusCode, blocked.body).toBe(malformed ? 400 : 409);
    expect(h.providerRequests).toHaveLength(0);
    const recovered = await send([
      ...history,
      { role: "user", content: requestText },
    ]);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(JSON.stringify(h.providerRequests)).not.toContain(unverified);
    expect(JSON.stringify(h.providerRequests)).not.toContain(
      "Earlier task content",
    );
    expect(JSON.stringify(h.providerRequests)).toContain(
      "Only reporting tools",
    );
    expect(noticeFrom(recovered.body, stream).name).toBe(
      `archestra__${command}`,
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        event: "tool_call",
        tool: "yell",
        session_id: `user:${h.userId}|blocked-reporting`,
      }),
    );

    const released = noticeFrom(recovered.body, stream);
    const continued = await send([
      ...history,
      { role: "user", content: requestText },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: released.id,
            name: released.name,
            input: released.input,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: released.id,
            content: "Reporting tool finished",
          },
        ],
      },
    ]);
    expect(continued.statusCode, continued.body).toBe(200);
    expect(JSON.stringify(h.providerRequests.at(-1))).toContain(
      "APPROVED REPLACEMENT",
    );
    expect(JSON.stringify(h.providerRequests.at(-1))).not.toContain(unverified);

    h.options.nonStreamingToolUse = {
      id: "toolu_ordinary_recovery",
      name: "Bash",
      input: { command: "unsafe task operation" },
    };
    h.options.streamingToolUse = {
      id: "toolu_ordinary_recovery",
      name: "Bash",
      input: { command: "unsafe task operation" },
    };
    const ordinary = await send([
      ...history,
      { role: "user", content: "Continue the original task" },
    ]);
    expect(ordinary.statusCode, ordinary.body).toBe(200);
    expect(noticeFrom(ordinary.body, stream).name).toBeUndefined();
    expect(ordinary.body).toContain("Do not retry ordinary tools");
    expect(
      h.events.filter(
        (event) => event.event === "tool_call" && event.tool === "Bash",
      ),
    ).toEqual([]);
    expect(
      JSON.stringify((h.providerRequests.at(-1) as { tools: unknown[] }).tools),
    ).not.toContain("Bash");
    const recoveryReview = vi.spyOn(appaService, "loadOfferReview");
    for (const reviewedTool of [
      "other__write",
      "archestra__yell",
      "unavailable",
    ]) {
      if (reviewedTool === "unavailable")
        recoveryReview.mockRejectedValue(
          new Error("Test review lookup unavailable"),
        );
      else
        recoveryReview.mockResolvedValue({
          offer_id: "recovery-review-offer",
          session_id: `user:${h.userId}|blocked-reporting`,
          text: "Review this operation",
          tool: reviewedTool,
          arguments: JSON.stringify(reportArgs),
        });
      const use = {
        id:
          reviewedTool === "archestra__yell"
            ? "toolu_reporting_remedy"
            : `toolu_ordinary_remedy_${reviewedTool}`,
        name: "archestra__execute_remedy_plan",
        input: { offer_id: "recovery-review-offer" },
      };
      h.options.nonStreamingToolUse = use;
      h.options.streamingToolUse = use;
      const reviewed = await send([
        ...history,
        { role: "user", content: requestText },
      ]);
      expect(reviewed.statusCode, reviewed.body).toBe(200);
      expect(noticeFrom(reviewed.body, stream).name).toBe(
        reviewedTool === "archestra__yell"
          ? "archestra__execute_remedy_plan"
          : undefined,
      );
    }
    recoveryReview.mockRestore();
    h.options.nonStreamingToolUse = {
      name: `archestra__${command}`,
      input: reportArgs,
    };
    h.options.streamingToolUse = {
      name: `archestra__${command}`,
      input: reportArgs,
    };

    // Reporting recovery does not disable policy checks.
    h.block = true;
    const denied = await send([
      ...history,
      { role: "user", content: requestText },
    ]);
    expect(denied.statusCode, denied.body).toBe(200);
    expect(noticeFrom(denied.body, stream).name).toBe(
      "archestra__get_remedy_plans",
    );
    expect(
      await OpenAppaUnenforcedModel.findSessions({
        organizationId: h.agent.organizationId,
        sessionIds: [`user:${h.userId}|blocked-reporting`],
      }),
    ).toEqual([]);
    const newBlockedResult = await send([
      ...history,
      { role: "user", content: requestText },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "new-unrecorded-spawn",
            name: "Agent",
            input: { prompt: "New task" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "new-unrecorded-spawn",
            content: "NEW UNVERIFIED CHILD RESULT",
          },
        ],
      },
    ]);
    expect(newBlockedResult.statusCode, newBlockedResult.body).toBe(200);
    expect(JSON.stringify(h.providerRequests.at(-1))).not.toContain(
      "NEW UNVERIFIED CHILD RESULT",
    );

    // Execute the released call through the real gateway handler, then replay
    // its result in the very history that previously blocked every request.
    const previousReporting = config.openappa.yellEnabled;
    const previousAnalytics = config.analytics.enabled;
    config.openappa.yellEnabled = true;
    config.analytics.enabled = false;
    await GuardrailsDeploymentModel.set({ breakTheGlassEnabled: true });
    const originalDispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      if (JSON.parse(raw).event === "yell")
        return JSON.stringify({
          decision: "mcp_result",
          result: { content: [{ type: "text", text: "Report delivered" }] },
        });
      if (!originalDispatch) throw new Error("Missing native mock");
      return originalDispatch(raw);
    });
    h.block = false;
    try {
      const execution = await executeArchestraTool(
        released.name,
        released.input,
        {
          agent: { id: h.agent.id, name: h.agent.name },
          organizationId: h.agent.organizationId,
          userId: h.userId,
        },
      );
      expect(execution.isError).not.toBe(true);
      const actualResult = execution.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      const returned = await send([
        ...history,
        { role: "user", content: requestText },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: released.id,
              name: released.name,
              input: released.input,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: released.id,
              content: actualResult,
            },
          ],
        },
      ]);
      expect(returned.statusCode, returned.body).toBe(200);
      expect(JSON.stringify(h.providerRequests.at(-1))).toContain(
        JSON.stringify(actualResult).slice(1, -1),
      );
    } finally {
      config.openappa.yellEnabled = previousReporting;
      config.analytics.enabled = previousAnalytics;
    }
  });

  test("blocks an unsupported client before the provider when configured", async () => {
    await GuardrailsDeploymentModel.set({ unsupportedClientAction: "block" });
    const response = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: { ...h.externalClientHeaders() },
      payload: {
        ...(h.payload(false) as Record<string, unknown>),
        metadata: { user_id: "generic-session" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "Add an X-Appa-Session-ID header to each request",
    );
    expect(response.json().error.message).toContain(
      "ask an administrator to allow unrecognized clients",
    );
    expect(h.providerRequests).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  const guardrailCall = (
    source: string,
    proof: Record<string, string> = guardrailCallHeader(),
  ) =>
    h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...internalCallHeader(),
        "x-api-key": "test-key",
        "x-archestra-virtual-key": h.platformKey,
        "anthropic-version": "2023-06-01",
        "x-archestra-source": source,
        ...proof,
      },
      payload: h.payload(false) as Record<string, unknown>,
    });

  test("block mode lets the platform's own guardrail models through ungoverned", async () => {
    await GuardrailsDeploymentModel.set({ unsupportedClientAction: "block" });
    const response = await guardrailCall("guardrail:annotator");
    expect(response.statusCode, response.body).toBe(200);
    expect(h.providerRequests).toHaveLength(1);
    expect(h.events).toHaveLength(0);
    const [proofHeader] = Object.keys(guardrailCallHeader());
    for (const [, options] of vi.mocked(anthropicAdapterFactory.createClient)
      .mock.calls) {
      expect(options.defaultHeaders ?? {}).not.toHaveProperty(proofHeader);
    }
  });

  test("block mode blocks a loopback guardrail source without the guardrail proof", async () => {
    await GuardrailsDeploymentModel.set({ unsupportedClientAction: "block" });
    const [proofHeader] = Object.keys(guardrailCallHeader());
    const [inProcessValue] = Object.values(internalCallHeader());
    for (const proof of [
      {},
      { [proofHeader]: "forged" },
      // The in-process proof authenticates the call but grants no bypass,
      // under its own header or replayed under the guardrail one.
      internalCallHeader(),
      { [proofHeader]: inProcessValue },
    ]) {
      const response = await guardrailCall("guardrail:annotator", proof);
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(h.providerRequests).toHaveLength(0);
  });

  test("block mode still blocks a credentialed client naming a guardrail source", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await GuardrailsDeploymentModel.set({ unsupportedClientAction: "block" });
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const providerKey = await makeLlmProviderApiKey(
      h.agent.organizationId,
      secret.id,
      { provider: "anthropic" },
    );
    const { value: virtualKey } = await VirtualApiKeyModel.create({
      name: "guardrail-virtual-key",
      providerApiKeys: [
        { provider: providerKey.provider, providerApiKeyId: providerKey.id },
      ],
    });
    for (const remoteAddress of ["127.0.0.1", "203.0.113.20"]) {
      const response = await h.app.inject({
        method: "POST",
        url: h.url(),
        remoteAddress,
        headers: {
          ...internalCallHeader(),
          authorization: `Bearer ${virtualKey}`,
          "anthropic-version": "2023-06-01",
          "x-archestra-source": "guardrail:annotator",
        },
        payload: h.payload(false) as Record<string, unknown>,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(h.providerRequests).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test("keeps a guardrail call on a virtual key out of the session it names", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await GuardrailsDeploymentModel.set({ unsupportedClientAction: "block" });
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const providerKey = await makeLlmProviderApiKey(
      h.agent.organizationId,
      secret.id,
      { provider: "anthropic" },
    );
    const { value: virtualKey } = await VirtualApiKeyModel.create({
      name: "guardrail-virtual-key",
      providerApiKeys: [
        { provider: providerKey.provider, providerApiKeyId: providerKey.id },
      ],
    });
    const response = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...internalCallHeader(),
        authorization: `Bearer ${virtualKey}`,
        "anthropic-version": "2023-06-01",
        "x-archestra-source": "guardrail:annotator",
        "x-appa-session-id": "chat-session",
        ...guardrailCallHeader(),
      },
      payload: h.payload(false) as Record<string, unknown>,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(h.providerRequests).toHaveLength(1);
    expect(h.events).toHaveLength(0);
  });

  test("blocks a credentialed remote client with no adapter or APPA headers", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await GuardrailsDeploymentModel.set({ unsupportedClientAction: "block" });
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const providerKey = await makeLlmProviderApiKey(
      h.agent.organizationId,
      secret.id,
      { provider: "anthropic" },
    );
    const { value: virtualKey } = await VirtualApiKeyModel.create({
      name: "unsupported-client",
      providerApiKeys: [
        { provider: providerKey.provider, providerApiKeyId: providerKey.id },
      ],
    });
    const response = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "203.0.113.20",
      headers: {
        authorization: `Bearer ${virtualKey}`,
        "anthropic-version": "2023-06-01",
      },
      payload: h.payload(false) as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "OpenAPPA does not recognize this client",
    );
    expect(h.providerRequests).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test("block mode still governs a known client and an explicit APPA session", async () => {
    await GuardrailsDeploymentModel.set({ unsupportedClientAction: "block" });
    for (const extraHeaders of [
      { "x-claude-code-session-id": "known-session" },
      { "x-appa-session-id": "explicit-session" },
    ]) {
      const response = await h.app.inject({
        method: "POST",
        url: h.url(),
        remoteAddress: "127.0.0.1",
        headers: { ...h.externalClientHeaders(), ...extraHeaders },
        payload: h.payload(false) as Record<string, unknown>,
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(h.providerRequests).toHaveLength(2);
    // Two roots, each ruled once. Both native ids are scoped to the caller's
    // user, since the external client authenticates with its own credential.
    const callerId = `user:${h.userId}`;
    const knownRoot = `${callerId}|known-session`;
    const explicitRoot = `${callerId}|explicit-session`;
    const starts = h.events.filter((event) => event.event === "session_start");
    const toolCalls = h.events.filter((event) => event.event === "tool_call");
    expect(starts).toEqual([
      expect.objectContaining({
        organization_id: h.agent.organizationId,
        caller_id: callerId,
        session_id: knownRoot,
      }),
      expect.objectContaining({
        organization_id: h.agent.organizationId,
        caller_id: callerId,
        session_id: explicitRoot,
      }),
    ]);
    expect(starts.map((event) => event.parent_id)).toEqual([
      undefined,
      undefined,
    ]);
    expect(starts.map((event) => event.fork_of)).toEqual([
      undefined,
      undefined,
    ]);
    expect(toolCalls).toEqual([
      expect.objectContaining({
        organization_id: h.agent.organizationId,
        caller_id: callerId,
        session_id: knownRoot,
        tool: "get_weather",
        operation_id: "call:toolu_test_weather",
      }),
      expect.objectContaining({
        organization_id: h.agent.organizationId,
        caller_id: callerId,
        session_id: explicitRoot,
        tool: "get_weather",
        operation_id: "call:toolu_test_weather",
      }),
    ]);
    expect(toolCalls.map((event) => event.namespace)).toEqual([
      undefined,
      undefined,
    ]);
    expect(toolCalls.map((event) => event.parent_id)).toEqual([
      undefined,
      undefined,
    ]);
  });

  test.each([
    { count: 2, multiple: false, stream: false, direct: false, skip: false },
    { count: 4, multiple: false, stream: false, direct: false, skip: false },
    { count: 5, multiple: false, stream: false, direct: false, skip: false },
    { count: 5, multiple: false, stream: true, direct: false, skip: false },
    { count: 12, multiple: false, stream: false, direct: false, skip: false },
    { count: 12, multiple: true, stream: false, direct: false, skip: false },
    { count: 5, multiple: false, stream: false, direct: true, skip: false },
    { count: 5, multiple: false, stream: true, direct: true, skip: false },
    { count: 5, multiple: false, stream: false, direct: false, skip: true },
  ])("Claude Desktop returns all-choice native answers to the provider (choices=$count, multiple=$multiple, stream=$stream, direct=$direct, skip=$skip)", async ({
    count,
    multiple,
    stream,
    direct,
    skip,
  }) => {
    h.block = false;
    const name = "mcp__archestra__archestra__ask_user";
    const labels = Array.from(
      { length: count },
      (_, index) => `Color ${index + 1}`,
    );
    const question = {
      question: "Which color do you prefer?",
      options: labels.map((label) => ({ label })),
      allowMultiple: multiple,
    };
    const tool = direct
      ? {
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: question.question,
                header: "Color",
                options: question.options,
                multiSelect: multiple,
              },
            ],
          },
        }
      : { name, input: question };
    h.options = stream
      ? {
          includeToolUse: true,
          streamingToolUse: tool,
          streamStopReason: "tool_use",
        }
      : { nonStreamingToolUse: tool };
    const body = h.payload(false);
    const tools = [
      ...body.tools.map((definition) => ({
        ...definition,
        description: definition.name.startsWith("archestra__")
          ? attestToolDescription({
              organizationId: h.agent.organizationId,
              gatewayId: h.agent.id,
              advertisedName: definition.name,
              kind: "b",
              description: definition.description,
            })
          : definition.description,
      })),
      {
        name,
        description: attestToolDescription({
          organizationId: h.agent.organizationId,
          gatewayId: h.agent.id,
          advertisedName: "archestra__ask_user",
          kind: "b",
          description: "Ask the user to choose.",
        }),
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "AskUserQuestion",
        description: "Ask a native question.",
        input_schema: { type: "object", properties: {} },
      },
    ];
    const clientHeaders = {
      ...internalCallHeader(),
      ...h.externalClientHeaders(),
      "x-archestra-agent-id": "anthropic_claude_desktop",
      "x-claude-code-session-id": "desktop-native-choice-session",
    };
    const messages = [
      {
        role: "user",
        content: "Use only Archestra's ask_user tool. Keep every color.",
      },
    ];
    const asked = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: clientHeaders,
      payload: { ...body, tools, stream, messages },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const released = noticeFrom(asked.body, stream);
    const initialGuidance = JSON.stringify(h.providerRequests.at(-1));
    expect(released.name).toBe("AskUserQuestion");
    const groups = released.input.questions as Array<{
      question: string;
      options: { label: string }[];
    }>;
    expect(groups.length).toBeLessThanOrEqual(4);
    for (const group of groups)
      expect(group.options.length).toBeLessThanOrEqual(4);
    expect(
      groups.flatMap((group) =>
        group.options
          .map((option) => option.label)
          .filter((label) => labels.includes(label)),
      ),
    ).toEqual(labels);
    const selected = skip
      ? []
      : multiple
        ? [labels[0], labels.at(-1)]
        : [labels.at(-1)];
    const answers = Object.fromEntries(
      groups.map((group) => {
        const picked = group.options
          .map((option) => option.label)
          .filter((label) => selected.includes(label));
        return [
          group.question,
          picked.length > 0 ? picked : [group.options.at(-1)?.label],
        ];
      }),
    );
    h.options = {};
    const history = [
      ...messages,
      {
        role: "assistant",
        content: [{ type: "tool_use", ...released }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: released.id,
            content: JSON.stringify({ answers }),
          },
        ],
      },
    ];
    // A replica may read the same answer again on a retry or resumed history.
    for (let replay = 0; replay < 2; replay++) {
      h.providerRequests.length = 0;
      const answered = await h.app.inject({
        method: "POST",
        url: h.url(),
        remoteAddress: "127.0.0.1",
        headers: clientHeaders,
        payload: { ...body, tools, messages: history },
      });
      expect(answered.statusCode, answered.body).toBe(200);
      const sent = h.providerRequests.at(-1) as {
        messages: { content: unknown }[];
      };
      const forwarded = sent.messages
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .find(
          (part) =>
            part.type === "tool_result" && part.tool_use_id === released.id,
        );
      const result = JSON.parse(forwarded.content);
      expect(result).toMatchObject({
        ...(skip ? { error: "unconfirmed_answer" } : { action: "accept" }),
        selected,
        archestra_presentation: {
          requested_tool: { name: direct ? "AskUserQuestion" : name },
          rendered_with: "AskUserQuestion",
          translation: direct
            ? "native_question_grouping"
            : "gateway_question_to_native_form",
        },
      });
      if (skip) expect(result).not.toHaveProperty("action", "accept");
    }
    expect(initialGuidance).toContain(
      "Honor the user's explicit choice of question tool.",
    );
  });

  test("block mode governs Claude Desktop sessions, isolates headerless Chat conversations, and rejects headerless requests without a conversation identity", async () => {
    await GuardrailsDeploymentModel.set({ unsupportedClientAction: "block" });
    h.options = { includeToolUse: false, streamStopReason: "end_turn" };
    const probe = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...h.externalClientHeaders(),
        "user-agent": "ClaudeDesktop/1.0.0",
      },
      payload: {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        metadata: {
          user_id:
            "user_0123456789abcdef_account__session_11111111-2222-3333-4444-555555555555",
        },
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(probe.statusCode, probe.body).toBe(200);
    expect(h.events).toEqual([]);

    h.options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: { name: "get_weather", input: { location: "SF" } },
    };
    const governed = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...h.externalClientHeaders(),
        "x-archestra-agent-id": "anthropic_claude_desktop",
        "x-claude-code-session-id": "desktop-session",
      },
      payload: h.payload(false) as Record<string, unknown>,
    });
    expect(governed.statusCode, governed.body).toBe(200);
    const callerId = `user:${h.userId}`;
    expect(h.events.filter((event) => event.event === "session_start")).toEqual(
      [
        expect.objectContaining({
          organization_id: h.agent.organizationId,
          caller_id: callerId,
          session_id: `${callerId}|desktop-session`,
        }),
      ],
    );

    // Two headerless Desktop Chat conversations with the exact same system prompt
    // and opening user message bind isolated client-supplied conversation roots,
    // never merging on prompt content.
    h.block = true;
    const sharedOpeningMessages = [
      { role: "user", content: "Check the weather in SF" },
    ];
    const chatOneDenied = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...h.externalClientHeaders(),
        "user-agent": "ClaudeDesktop/1.0.0",
      },
      payload: {
        ...(h.payload(false, sharedOpeningMessages) as Record<string, unknown>),
        system: "You are Claude.",
        metadata: { conversation_id: "desktop-chat-1" },
      },
    });
    expect(chatOneDenied.statusCode, chatOneDenied.body).toBe(200);
    expect(
      (
        chatOneDenied.json().content as Array<{ type: string; name?: string }>
      ).some(
        (block) => block.type === "tool_use" && block.name === "get_weather",
      ),
    ).toBe(false);

    const startsAfterChatOne = h.events.filter(
      (event) => event.event === "session_start",
    );
    expect(startsAfterChatOne).toHaveLength(2);
    const chatOneSessionId = String(startsAfterChatOne[1]?.session_id);
    expect(chatOneSessionId).toBe(`user:${h.userId}|desktop-chat-1`);

    // Superyelling the first Chat conversation exempts its own follow-up turn
    // without disabling enforcement for a second headerless Chat conversation
    // that shares the exact same system prompt and opening message.
    await OpenAppaUnenforcedModel.recordSession({
      organizationId: h.agent.organizationId,
      sessionId: chatOneSessionId,
      parentId: undefined,
      reason: "superyell",
    });

    const chatOneFollowUp = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...h.externalClientHeaders(),
        "user-agent": "ClaudeDesktop/1.0.0",
      },
      payload: {
        ...(h.payload(false, [
          ...sharedOpeningMessages,
          { role: "assistant", content: "I could not run that tool." },
          { role: "user", content: "Try again after disabling guardrails" },
        ]) as Record<string, unknown>),
        system: "You are Claude.",
        metadata: { conversation_id: "desktop-chat-1" },
      },
    });
    expect(chatOneFollowUp.statusCode, chatOneFollowUp.body).toBe(200);
    expect(
      (
        chatOneFollowUp.json().content as Array<{ type: string; name?: string }>
      ).some(
        (block) => block.type === "tool_use" && block.name === "get_weather",
      ),
    ).toBe(true);

    const chatTwoDenied = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...h.externalClientHeaders(),
        "x-archestra-agent-id": "anthropic_claude_desktop",
      },
      payload: {
        ...(h.payload(false, sharedOpeningMessages) as Record<string, unknown>),
        system: "You are Claude.",
        metadata: { conversation_id: "desktop-chat-2" },
      },
    });
    expect(chatTwoDenied.statusCode, chatTwoDenied.body).toBe(200);
    expect(
      (
        chatTwoDenied.json().content as Array<{ type: string; name?: string }>
      ).some(
        (block) => block.type === "tool_use" && block.name === "get_weather",
      ),
    ).toBe(false);

    const startsAfterChatTwo = h.events.filter(
      (event) => event.event === "session_start",
    );
    expect(startsAfterChatTwo).toHaveLength(3);
    const chatTwoSessionId = String(startsAfterChatTwo[2]?.session_id);
    expect(chatTwoSessionId).toBe(`user:${h.userId}|desktop-chat-2`);
    expect(chatTwoSessionId).not.toBe(chatOneSessionId);

    // A headerless Desktop request without a client-supplied conversation identifier
    // is rejected as unsupported in block mode even when prompt content is present.
    const unidentifiable = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...h.externalClientHeaders(),
        "x-archestra-agent-id": "anthropic_claude_desktop",
      },
      payload: {
        ...(h.payload(false, sharedOpeningMessages) as Record<string, unknown>),
        system: "You are Claude.",
      },
    });
    expect(unidentifiable.statusCode).toBe(400);
    expect(unidentifiable.json().error.message).toContain(
      "OpenAPPA does not recognize this client",
    );
  });

  test("an encrypted chat that started while the switch was off stays unenforced; a new one requires a key and escrow", async ({
    makeConversation,
  }) => {
    const encrypt = (id: string) =>
      db
        .update(database.schema.conversationsTable)
        .set({ encryptedChat: true })
        .where(eq(database.schema.conversationsTable.id, id));
    // The chat names its conversation as the session of every request.
    const postChat = () =>
      h.post(h.payload(false), { "x-archestra-session-id": h.sessionId });
    await encrypt(h.sessionId);
    await GuardrailsDeploymentModel.setEnabled(false);
    const off = await postChat();
    expect(off.statusCode, off.body).toBe(200);

    await GuardrailsDeploymentModel.setEnabled(true);
    const same = await postChat();
    expect(same.statusCode, same.body).toBe(200);
    expect(h.events).toEqual([]);

    h.sessionId = (
      await makeConversation(h.agent.id, {
        userId: h.userId,
        organizationId: h.agent.organizationId,
      })
    ).id;
    await encrypt(h.sessionId);
    const fresh = await postChat();
    expect(fresh.statusCode, fresh.body).toBe(409);
  });

  test.each([
    false,
    true,
  ])("records an encrypted chat refused for want of a key and escrow as a redacted failed interaction (stream=%s)", async (stream) => {
    await db
      .update(database.schema.conversationsTable)
      .set({ encryptedChat: true })
      .where(eq(database.schema.conversationsTable.id, h.sessionId));
    const response = await h.post(h.payload(stream), {
      "x-archestra-session-id": h.sessionId,
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toEqual({
      error: {
        message:
          "Encrypted chat key and escrow are required for policy storage",
        type: "api_conflict_error",
      },
    });
    expect(response.headers["x-should-retry"]).toBeUndefined();
    expect(h.providerRequests).toEqual([]);
    const rows = await db
      .select()
      .from(database.schema.interactionsTable)
      .where(eq(database.schema.interactionsTable.profileId, h.agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: h.sessionId,
      request: ENCRYPTED_CHAT_REDACTED_MARKER,
      response: ENCRYPTED_CHAT_REDACTED_MARKER,
      processedRequest: null,
    });
  });

  const unenforcedRecords = async () => [
    ...(await db
      .select()
      .from(database.schema.openappaUnenforcedSessionsTable)
      .where(
        eq(
          database.schema.openappaUnenforcedSessionsTable.organizationId,
          h.agent.organizationId,
        ),
      )),
    ...(await db
      .select()
      .from(database.schema.openappaUnenforcedCallsTable)
      .where(
        eq(
          database.schema.openappaUnenforcedCallsTable.organizationId,
          h.agent.organizationId,
        ),
      )),
  ];

  // A delegated child presents the parent's session; only a valid binding
  // names its own trajectory.
  const invalidSubagentBinding = { "x-archestra-appa-subagent": "expired" };

  test("serves a child with an invalid subagent binding while OpenAPPA is off", async () => {
    config.openappa.enabled = false;
    const response = await h.post(h.payload(false), invalidSubagentBinding);

    expect(response.statusCode, response.body).toBe(200);
    expect(h.providerRequests).toHaveLength(1);
    expect(h.events).toEqual([]);
    expect(await unenforcedRecords()).toEqual([]);
  });

  test("serves a child with an invalid subagent binding while only observing, without observing it under its parent", async () => {
    await GuardrailsDeploymentModel.setEnabled(false);
    const child = await h.post(h.payload(false), invalidSubagentBinding);

    expect(child.statusCode, child.body).toBe(200);
    expect(h.providerRequests).toHaveLength(1);
    expect(h.events).toEqual([]);
    expect(await unenforcedRecords()).toEqual([]);

    // The parent's own request is observed.
    const parent = await h.post(h.payload(false));
    expect(parent.statusCode, parent.body).toBe(200);
    expect(await unenforcedRecords()).not.toEqual([]);
  });

  test("refuses a child with an invalid subagent binding while enforcing", async () => {
    const response = await h.post(h.payload(false), invalidSubagentBinding);

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.message).toBe(
      "OpenAPPA subagent binding is invalid or expired",
    );
    expect(h.providerRequests).toEqual([]);
  });

  test.each([
    false,
    true,
  ])("encrypted Chat stays governed and sends its key only outside the native hook JSON (deny=%s)", async (deny) => {
    const dek = randomBytes(32);
    await db
      .update(database.schema.conversationsTable)
      .set({
        encryptedChat: true,
        encryptedChatDekFingerprint: encryptedChatDekFingerprint(
          h.sessionId,
          dek,
        ),
        encryptedChatEscrow: {
          v: 1,
          alg: "RSA-OAEP-256",
          escrowKeyFingerprint: "test",
          wrappedDek: "test",
        },
      })
      .where(eq(database.schema.conversationsTable.id, h.sessionId));
    h.block = deny;
    const response = await h.post(h.payload(false), {
      "x-archestra-session-id": h.sessionId,
      "x-archestra-encrypted-chat-key": dek.toString("base64url"),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(noticeFrom(response.body, false).name).toBe(
      deny ? "archestra__get_remedy_plans" : "get_weather",
    );
    expect(h.events.some((e) => e.event === "tool_call")).toBe(true);
    for (const [input, , encryption] of native.dispatchHook.mock.calls) {
      expect(input).not.toContain(dek.toString("base64url"));
      expect(encryption).toMatchObject({
        key: dek,
        scope: JSON.stringify([h.agent.organizationId, h.sessionId]),
      });
    }
    expect(await GuardrailsDeploymentModel.isEnabled()).toBe(true);
  });

  test("does not issue a remedy notice while the deployment switch is off, then does for a session that starts after it is turned on", async ({
    makeConversation,
  }) => {
    h.block = true;
    await GuardrailsDeploymentModel.setEnabled(false);
    const off = await h.post(h.payload(false));
    expect(off.statusCode, off.body).toBe(200);
    expect(off.body).not.toContain("get_remedy_plans");
    expect(noticeFrom(off.body, false).name).toBe("get_weather");
    expect(h.events.filter((event) => event.event === "tool_call")).toEqual([]);

    await GuardrailsDeploymentModel.setEnabled(true);
    // The session started while enforcement was off, so it stays out of
    // OpenAPPA: its call is released as the model made it.
    const same = await h.post(h.payload(false));
    expect(same.statusCode, same.body).toBe(200);
    expect(noticeFrom(same.body, false).name).toBe("get_weather");
    expect(h.events).toEqual([]);

    h.sessionId = (
      await makeConversation(h.agent.id, {
        userId: h.userId,
        organizationId: h.agent.organizationId,
      })
    ).id;
    const on = await h.post(h.payload(false));
    expect(on.statusCode, on.body).toBe(200);
    expect(noticeFrom(on.body, false).name).toBe("archestra__get_remedy_plans");
  });

  test("keeps the captured switch through tool results and reads it again on the next request", async () => {
    const realGet = GuardrailsDeploymentModel.get.bind(
      GuardrailsDeploymentModel,
    );
    let gets = 0;
    const getSpy = vi
      .spyOn(GuardrailsDeploymentModel, "get")
      .mockImplementation(async () => {
        gets += 1;
        if (gets > 1) {
          return {
            id: "global",
            enabled: false,
            unsupportedClientAction: "bypass",
            breakTheGlassEnabled: true,
            humanApprovalMode: "block",
            unapprovableBlockMode: "refuse",
            annotatorModelId: null,
            annotatorLlmApiKeyId: null,
          };
        }
        return realGet();
      });
    const enabledSpy = vi
      .spyOn(GuardrailsDeploymentModel, "isEnabled")
      .mockImplementation(async () => {
        throw new Error("activation re-read inside a captured request");
      });
    try {
      const response = await h.post(
        h.payload(false, [
          { role: "user", content: "Check the weather" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_weather",
                name: "get_weather",
                input: { location: "San Francisco" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_weather",
                content: "Sunny",
              },
            ],
          },
        ]),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(h.events.map((event) => event.event)).toContain("tool_result");
      expect(gets).toBe(1);
      expect(enabledSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
      enabledSpy.mockRestore();
    }

    await GuardrailsDeploymentModel.setEnabled(false);
    h.block = true;
    h.events.length = 0;
    const next = await h.post(h.payload(false));
    expect(next.statusCode, next.body).toBe(200);
    expect(next.body).not.toContain("get_remedy_plans");
    expect(noticeFrom(next.body, false).name).toBe("get_weather");
  });

  test("binds a headerless Claude Code request to its own session", async () => {
    const claudeSession = "74582997-cc91-4cd5-baee-676e581ca028";
    await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...internalCallHeader(),
        ...h.externalClientHeaders(),
        "x-claude-code-session-id": claudeSession,
      },
      payload: h.payload(false) as Record<string, unknown>,
    });

    // Scoped to the credential: the id is one another member of the
    // organization could learn and repeat, so the bare value binds nobody.
    expect(h.events).toContainEqual(
      expect.objectContaining({
        session_id: `user:${h.userId}|${claudeSession}`,
      }),
    );
  });

  test.each([
    true,
    false,
  ])("Claude Code presents ask_user as AskUserQuestion with the staged HITL review (stream=%s)", async (stream) => {
    config.openappa = { ...config.openappa, offerSigningSecret: "" };
    const claudeSession = "a3f81c2e-4b17-4d9a-9c08-7e2f1b6a4d90";
    const runtimeSession = `user:${h.userId}|${claudeSession}`;
    const offerId = "offer-hitl";
    const modelCopy = "Model-authored copy must not appear.";
    const questionText = 'Approve this call?\nmcp/example/write {"value":1}';
    await stageHitlReview({
      session: {
        organization_id: h.agent.organizationId,
        caller_id: `user:${h.userId}`,
        session_id: runtimeSession,
      },
      review: {
        offerId,
        text:
          "\u2584\u2588\u2584\u2584\u2584\u2588\u2584  \u2580\u2580\u2588  Approve this call?\n" +
          '\u2588\u2588\u2584\u2588\u2584\u2588\u2588   \u2584   mcp/example/write {"value":1}',
      },
    });
    const noticeId = "toolu_denied_weather";
    const noticeInput = {
      ...buildNoticeArguments({
        id: noticeId,
        tool: "get_weather",
        arguments: { location: "SF" },
        result: "[appa] Blocked",
      }),
      offers: [
        {
          protected: "eyJhbGciOiJIUzI1NiJ9",
          payload: JSON.stringify({ session_id: "parent-offer-session" }),
          signature: "ignored-parent-offer",
        },
      ],
    };
    const askUser = {
      name: "archestra__ask_user",
      input: {
        question: modelCopy,
        header: "Wrong",
        options: [{ label: "Yes" }, { label: "No" }],
        remedy_offer_ids: [offerId],
      },
    };
    h.options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: askUser,
      streamingToolUse: askUser,
    };
    const body = h.payload(stream, [
      { role: "user", content: "Check the weather" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: noticeId,
            name: "archestra__get_remedy_plans",
            input: noticeInput,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: noticeId,
            content: "rendered for the user",
          },
        ],
      },
    ]);
    body.tools.push(
      {
        name: "archestra__ask_user",
        description: "Ask the user",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "AskUserQuestion",
        description: "Ask the user a question",
        input_schema: { type: "object", properties: {} },
      },
    );

    const response = await h.app.inject({
      method: "POST",
      url: h.url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...internalCallHeader(),
        ...h.externalClientHeaders(),
        "user-agent": "claude-code/2.1.258",
        "x-claude-code-session-id": claudeSession,
      },
      payload: body as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    const question = noticeFrom(response.body, stream);
    // Claude Code runs its own question tool, not the gateway ask_user.
    expect(question.name).toBe("AskUserQuestion");
    const issuedId = parseTrajectoryStamp(question.id)?.callId ?? question.id;
    expect(issuedId).toMatch(/^toolu_aq2_[A-Za-z0-9_-]+$/);
    expect(issuedId).not.toContain("_aq1_");
    expect(question.input).toEqual({
      questions: [
        {
          question: questionText,
          header: "Tool call",
          options: [
            { label: "Inspect", description: "Show the full review in chat." },
            { label: "Allow", description: "This exact call." },
            { label: "Deny", description: "Keep it blocked." },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(JSON.stringify(question.input)).not.toContain(modelCopy);
  });
});
