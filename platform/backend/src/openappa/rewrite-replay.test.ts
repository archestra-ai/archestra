import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import db, { schema } from "@/database";
import OpenAppaRewriteModel from "@/models/openappa-rewrite";
import { AppaClaudeCodeAdapter } from "@/proxy/plugins/appa-plugin-archestra/adapters/claude-code";
import { ApiError } from "@/types";
import { openappaActor } from "./actor";
import { prepareAppaRequest } from "./request";
import { AppaRewriteReplay, captureAppaReplayRequest } from "./rewrite-replay";
import { appendSessionReceipt } from "./session-token";
import { stripAppaTools } from "./wire";

const secretsSnapshot = config.secretsManager;
const ENCRYPTION_SECRET = "test-replay-encryption-secret";
const PLAINTEXT = "REPLAY-PLAINTEXT-MARKER";
const SECRET = "SECRET-VALUE-MARKER";
const APPROVED = "APPROVED-OUTPUT-MARKER";
const EXACT_ARGUMENTS = ' {"q":"caf\\u00e9  spaced"} ';

const identity = {
  mode: "compat" as const,
  gatewayConnected: false,
  canonicalize: (name: string, namespace?: string) =>
    namespace ? `${namespace}__${name}` : name,
  attestationOf: () => undefined,
  verified: [] as never[],
  unverifiedMarkerCount: 0,
};

describe("AppaRewriteReplay", () => {
  test("leaves quoted classifier transcripts unchanged without authenticating their claims", async () => {
    await withSecret(async () => {
      const marker =
        "[appa] delegated trajectory appa2-Y2FsbA.0000000000000000000000000000000000000000 — child of parent.";
      for (const content of [
        `${JSON.stringify({ tool: `Quoted\n${marker}` })}\n${JSON.stringify({ user: "Continue" })}\n`,
        `[49] tool spawn_agent call: ${JSON.stringify({ message: `Quoted\n${marker}` })}\n`,
      ]) {
        const session = await nativeSession();
        const body = {
          ...anthropicBody(),
          messages: [{ role: "user", content }],
        };
        const replay = await open(session, body, "anthropic:messages");
        await replay.restoreTextEchoes();
        expect(body.messages[0].content).toBe(content);
      }
    });
  });

  test("retains carrier bytes and rejects a changed envelope renderer", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const makeBody = () => ({
        ...anthropicBody(),
        metadata: {
          user_id:
            '{ "session_id": "local", "agent_id": "CARRIER-SECRET-MARKER" }',
        },
      });
      const body = makeBody();
      const replay = await open(session, body, "anthropic:messages");
      const adapter = new AppaClaudeCodeAdapter();
      await replay.rewriteEnvelope({
        request: body,
        transform: async () => {
          adapter.stripCarrierMetadata(body);
        },
      });
      expect(body.metadata.user_id).toBe('{"session_id":"local"}');
      expect(dumpRows(await pairRows(session.organizationId))).not.toContain(
        "CARRIER-SECRET-MARKER",
      );
      const before = await accounting(session.organizationId);
      const same = makeBody();
      const second = await open(session, same, "anthropic:messages");
      await second.rewriteEnvelope({
        request: same,
        transform: async () => {
          adapter.stripCarrierMetadata(same);
        },
      });
      expect(JSON.stringify(same)).toBe(JSON.stringify(body));
      expect(await accounting(session.organizationId)).toEqual(before);
      const changed = makeBody();
      const third = await open(session, changed, "anthropic:messages");
      await expect(
        third.rewriteEnvelope({
          request: changed,
          transform: async () => {
            changed.metadata.user_id = "different-renderer";
          },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  test("records live policy controls without replacing them with an old choice", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = {
        ...anthropicBody(),
        tool_choice: "auto",
        parallel_tool_calls: true,
      };
      const replay = await open(session, body, "anthropic:messages");
      await replay.rewriteEnvelope({
        request: body,
        transform: async () => {
          body.tool_choice = "required";
          body.parallel_tool_calls = false;
        },
      });
      const next = {
        ...anthropicBody(),
        tool_choice: "auto",
        parallel_tool_calls: true,
      };
      const second = await open(session, next, "anthropic:messages");
      await second.rewriteEnvelope({
        request: next,
        transform: async () => {},
      });
      expect(next.tool_choice).toBe("auto");
      expect(next.parallel_tool_calls).toBe(true);
      await expect(
        second.rewriteEnvelope({
          request: next,
          transform: async () => {
            next.model = "unrecorded-envelope-change";
          },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  test("rejects changed response bytes for the same recorded operation", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = anthropicBody();
      const first = await open(session, body, "anthropic:messages");
      await first.prepareRequest(body);
      const original = {
        id: "response-fixed",
        content: [{ type: "text", text: "original" }],
      };
      await first.recordResponse({
        source: first.captureResponse(original),
        response: original,
        emitted: [],
      });
      const retryBody = anthropicBody();
      const second = await open(session, retryBody, "anthropic:messages");
      await second.prepareRequest(retryBody);
      const changed = {
        ...original,
        content: [{ type: "text", text: "different-renderer" }],
      };
      await expect(
        second.recordResponse({
          source: second.captureResponse(original),
          response: changed,
          emitted: [],
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  test("restores exact chat and responses argument strings after the client echo", async () => {
    await withSecret(async () => {
      await expectRestoredArguments("openai:chatCompletions");
      await expectRestoredArguments("openai:responses");
    });
  });

  test("keeps the first renderer and the appended prefix without storing another copy", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const first = anthropicBody();
      const opened = await open(session, first, "anthropic:messages");
      first.system = "Base\nGUIDANCE-V1";
      first.messages[0].content = `hello [v1] ${PLAINTEXT}`;
      const prepared = await opened.prepareRequest(first);
      const response = {
        id: "resp-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      };
      await opened.recordResponse({
        source: opened.captureResponse(response),
        response,
        emitted: [],
      });
      const stored = await pairRows(session.organizationId);
      expect(stored.length).toBeGreaterThan(0);
      expect(dumpRows(stored)).not.toContain(PLAINTEXT);
      expect(dumpRows(stored)).not.toContain("GUIDANCE-V1");

      const appended = anthropicBody();
      appended.messages.push({ role: "user", content: "tail" });
      const again = await open(session, appended, "anthropic:messages");
      appended.system = "Base\nGUIDANCE-V2";
      appended.messages[0].content = "hello [v2]";
      appended.tools[0].description = "changed-by-upgrade";
      const second = await again.prepareRequest(appended);
      expect(second).toMatchObject({
        system: "Base\nGUIDANCE-V1",
        tools: (prepared as { tools: unknown }).tools,
        messages: [
          ...(prepared as { messages: unknown[] }).messages,
          { role: "user", content: "tail" },
        ],
      });
      expect(JSON.stringify(second)).not.toContain("GUIDANCE-V2");
      expect(JSON.stringify(second)).not.toContain("hello [v2]");
      expect(JSON.stringify(second)).not.toContain("changed-by-upgrade");

      const before = await accounting(session.organizationId);
      const duplicate = anthropicBody();
      duplicate.messages.push({ role: "user", content: "tail" });
      const retried = await open(session, duplicate, "anthropic:messages");
      duplicate.system = "Base\nGUIDANCE-V3";
      const third = await retried.prepareRequest(duplicate);
      expect(third).toEqual(second);
      expect(await accounting(session.organizationId)).toEqual(before);
    });
  });

  test("rejects a wrong encryption key and a tampered head", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = anthropicBody();
      const opened = await open(session, body, "anthropic:messages");
      await opened.prepareRequest(body);
      config.secretsManager = {
        ...secretsSnapshot,
        encryptionSecret: "test-replay-wrong-dek",
      };
      const wrongKey = anthropicBody();
      await expect(
        open(session, wrongKey, "anthropic:messages").then((replay) =>
          replay.prepareRequest(wrongKey),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(JSON.stringify(wrongKey)).not.toContain("GUIDANCE");

      config.secretsManager = {
        ...secretsSnapshot,
        encryptionSecret: ENCRYPTION_SECRET,
      };
      const heads = await db
        .select()
        .from(schema.openappaRewriteHeadsTable)
        .where(
          eq(
            schema.openappaRewriteHeadsTable.organizationId,
            session.organizationId,
          ),
        );
      expect(heads.length).toBeGreaterThan(0);
      const tampered = Buffer.from(heads[0].state);
      tampered[tampered.length - 1] ^= 0xff;
      await db
        .update(schema.openappaRewriteHeadsTable)
        .set({ state: tampered })
        .where(
          eq(
            schema.openappaRewriteHeadsTable.organizationId,
            session.organizationId,
          ),
        );
      const echoed = anthropicBody();
      await expect(
        open(session, echoed, "anthropic:messages").then((replay) =>
          replay.prepareRequest(echoed),
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  test("expiry deletes payload and a warm cache cannot reopen the tombstone", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = anthropicBody();
      const opened = await open(session, body, "anthropic:messages");
      await opened.prepareRequest(body);
      expect(await pairRows(session.organizationId)).not.toEqual([]);
      const [group] = await db
        .select()
        .from(schema.openappaRewriteGroupsTable)
        .where(
          eq(
            schema.openappaRewriteGroupsTable.organizationId,
            session.organizationId,
          ),
        );
      const expiresAt = new Date(group.expiresAt);
      let swept = 0;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        swept += await OpenAppaRewriteModel.expireInactive({
          now: new Date(expiresAt.getTime() + 1_000),
        });
      }
      expect(swept).toBeGreaterThan(0);
      expect(await pairRows(session.organizationId)).toEqual([]);
      const [tombstone] = await db
        .select()
        .from(schema.openappaRewriteGroupsTable)
        .where(
          eq(
            schema.openappaRewriteGroupsTable.organizationId,
            session.organizationId,
          ),
        );
      expect(tombstone.status).toBe("expired");
      const replay = anthropicBody();
      await expect(
        open(session, replay, "anthropic:messages"),
      ).rejects.toMatchObject({
        statusCode: 410,
        message: "Replay retention expired",
      });
    });
  });

  test("an acknowledged policy output does not resurrect the earlier sensitive content", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const first = toolResultBody(SECRET);
      const opened = await open(session, first, "anthropic:messages");
      const admitted = await opened.prepareRequest(first);
      expect(JSON.stringify(admitted)).toContain(SECRET);

      const echo = toolResultBody(SECRET);
      const again = await open(session, echo, "anthropic:messages");
      again.addPolicyOutputs(new Map([["call-1", APPROVED]]));
      const replaced = await again.prepareRequest(echo);
      expect(JSON.stringify(replaced)).toContain(APPROVED);
      expect(JSON.stringify(replaced)).not.toContain(SECRET);
      expect(dumpRows(await pairRows(session.organizationId))).not.toContain(
        SECRET,
      );

      const later = toolResultBody(SECRET);
      const third = await open(session, later, "anthropic:messages");
      const replayed = await third.prepareRequest(later);
      expect(JSON.stringify(replayed)).toContain(APPROVED);
      expect(JSON.stringify(replayed)).not.toContain(SECRET);

      const cancelled = toolResultBody(SECRET);
      const fourth = await open(session, cancelled, "anthropic:messages");
      fourth.addPolicyOutputs(new Map([["call-1", SECRET]]));
      const restored = await fourth.prepareRequest(cancelled);
      expect(JSON.stringify(restored)).toContain(SECRET);
      expect(JSON.stringify(restored)).not.toContain(APPROVED);
      const quiet = toolResultBody(APPROVED);
      const fifth = await open(session, quiet, "anthropic:messages");
      const held = await fifth.prepareRequest(quiet);
      expect(JSON.stringify(held)).toContain(SECRET);
      expect(JSON.stringify(held)).not.toContain(APPROVED);
    });
  });

  test("losing a committed head refuses replay instead of resurrecting a policy replacement", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const first = toolResultBody(SECRET);
      await (await open(session, first, "anthropic:messages")).prepareRequest(
        first,
      );
      const changed = toolResultBody(SECRET);
      const rewrite = await open(session, changed, "anthropic:messages");
      rewrite.addPolicyOutputs(new Map([["call-1", APPROVED]]));
      await rewrite.prepareRequest(changed);
      const before = await accounting(session.organizationId);
      await db
        .delete(schema.openappaRewriteHeadsTable)
        .where(
          eq(
            schema.openappaRewriteHeadsTable.organizationId,
            session.organizationId,
          ),
        );
      const replay = toolResultBody(SECRET);
      await expect(
        (await open(session, replay, "anthropic:messages")).prepareRequest(
          replay,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await accounting(session.organizationId)).toEqual(before);
      expect(await db.select().from(schema.openappaRewriteHeadsTable)).toEqual(
        [],
      );
    });
  });

  test("a receipt wrapper does not invert to a shorter source substring", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = anthropicBody();
      const replay = await open(session, body, "anthropic:messages");
      await replay.prepareRequest(body);
      const client = appendSessionReceipt("not secret", "ABC-DEFG");
      await expect(
        replay.recordResponse({
          source: {
            identity: "src-substring",
            calls: new Map(),
            texts: ["secret"],
          },
          response: {
            id: "msg-substring",
            content: [{ type: "text", text: client }],
          },
          emitted: [],
          approvedText: "secret",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  test("records the full wrapped source text, including newlines", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = anthropicBody();
      const replay = await open(session, body, "anthropic:messages");
      await replay.prepareRequest(body);
      const original = "\nsecret\n";
      const client = appendSessionReceipt(original, "ABC-DEFG");
      await replay.recordResponse({
        source: {
          identity: "src-newlines",
          calls: new Map(),
          texts: [original, "secret"],
        },
        response: {
          id: "msg-newlines",
          content: [
            { type: "text", text: client },
            { type: "text", text: appendSessionReceipt("", "ABC-DEFG") },
          ],
        },
        emitted: [],
      });
      const echo = {
        ...anthropicBody(),
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "text", text: client }] },
        ],
      };
      const second = await open(session, echo, "anthropic:messages");
      await second.restoreTextEchoes();
      const restored = echo.messages[1]?.content;
      if (!Array.isArray(restored)) throw new Error("expected text blocks");
      const block = restored[0];
      if (!block || typeof block === "string" || !("text" in block)) {
        throw new Error("expected text block");
      }
      expect(block.text).toBe(original);
    });
  });

  test("a baked admission survives a resent result that repeats the same policy", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const first = toolResultBody("RAW SECRET");
      const opened = await open(session, first, "anthropic:messages");
      opened.addPolicyOutputs(new Map([["call-1", "APPROVED REPLACEMENT"]]));
      const admitted = await opened.prepareRequest(first);
      expect(JSON.stringify(admitted)).toContain("APPROVED REPLACEMENT");
      expect(JSON.stringify(admitted)).not.toContain("RAW SECRET");

      const altered = toolResultBody("ALTERED RAW SECRET");
      const again = await open(session, altered, "anthropic:messages");
      again.addPolicyOutputs(new Map([["call-1", "APPROVED REPLACEMENT"]]));
      const replayed = await again.prepareRequest(altered);
      expect(JSON.stringify(replayed)).toContain("APPROVED REPLACEMENT");
      expect(JSON.stringify(replayed)).not.toContain("ALTERED RAW SECRET");
      expect(JSON.stringify(replayed)).not.toContain("RAW SECRET");
    });
  });

  test("an unapproved change to a recorded result is rejected", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const first = toolResultBody("RAW SECRET");
      const opened = await open(session, first, "anthropic:messages");
      await opened.prepareRequest(first);
      const altered = toolResultBody("ALTERED RAW SECRET");
      const again = await open(session, altered, "anthropic:messages");
      await expect(again.prepareRequest(altered)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("incompatible"),
      });
    });
  });

  test("pins the tool list after prepareAppaRequest and a notice-tool strip", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = {
        model: "m",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "read",
            description: "stable-schema",
            input_schema: {
              type: "object",
              properties: { cache_control: { type: "string" } },
            },
          },
          {
            name: "get_remedy_plans",
            description: "notice",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      };
      const replay = await open(session, body, "anthropic:messages");
      prepareAppaRequest({
        body,
        interactionType: "anthropic:messages",
        identity,
      });
      stripAppaTools({ body, tools: [{ name: "get_remedy_plans" }] });
      const prepared = await replay.prepareRequest(body);
      const tools = (prepared as { tools: Array<Record<string, unknown>> })
        .tools;
      expect(tools.map((tool) => tool.name)).toEqual(["read"]);
      expect(tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      expect(tools[0].description).toBe("stable-schema");

      const upgrade = {
        model: "m",
        max_tokens: 9,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "read",
            description: "stable-schema",
            input_schema: {
              type: "object",
              properties: { cache_control: { type: "string" } },
            },
          },
          {
            name: "get_remedy_plans",
            description: "notice",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      };
      const second = await open(session, upgrade, "anthropic:messages");
      const replayed = await second.prepareRequest(upgrade);
      expect(
        (replayed as { tools: Array<Record<string, unknown>> }).tools,
      ).toEqual(tools);
      expect(JSON.stringify(replayed)).not.toContain("get_remedy_plans");
    });
  });

  test("a caller history edit starts a new generation and keeps prior pairs", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const first = anthropicBody();
      first.messages.push({ role: "user", content: "tail" });
      const opened = await open(session, first, "anthropic:messages");
      await opened.prepareRequest(first);
      const before = await pairRows(session.organizationId);
      expect(before.length).toBeGreaterThan(0);

      const edited = anthropicBody();
      edited.messages = [{ role: "user", content: "compacted summary" }];
      const replay = await open(session, edited, "anthropic:messages");
      const prepared = await replay.prepareRequest(edited);
      expect(JSON.stringify(prepared)).toContain("compacted summary");
      expect(JSON.stringify(prepared)).not.toContain('"tail"');
      const after = await pairRows(session.organizationId);
      expect(after.length).toBeGreaterThanOrEqual(before.length);

      const againBody = anthropicBody();
      againBody.messages = [{ role: "user", content: "compacted summary" }];
      const again = await open(session, againBody, "anthropic:messages");
      const lost = JSON.parse(JSON.stringify(againBody));
      await expect(again.prepareRequest(lost)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringMatching(/lost-source|unrecorded/),
      });
    });
  });

  test("a hosted denial does not restore the withheld call", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = anthropicBody();
      const replay = await open(session, body, "anthropic:messages");
      await replay.prepareRequest(body);
      const hosted = {
        id: "msg-hosted",
        content: [
          {
            type: "tool_use",
            id: "toolu_hosted",
            name: "web_search",
            input: { query: "UNSAFE-HOSTED-QUERY" },
          },
        ],
      };
      const notice = {
        id: "msg-hosted",
        content: [
          {
            type: "tool_use",
            id: "toolu_hosted",
            name: "get_remedy_plans",
            input: {
              tool: "web_search",
              arguments: { query: "UNSAFE-HOSTED-QUERY" },
              ruling: "blocked",
              notice: { v: 1, call_id: "toolu_hosted" },
            },
          },
        ],
      };
      await replay.recordResponse({
        source: replay.captureResponse(hosted),
        response: notice,
        emitted: [{ id: "toolu_hosted" }],
        policyCallIds: ["toolu_hosted"],
      });
      const echo = {
        ...anthropicBody(),
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: notice.content },
        ],
      };
      const second = await open(session, echo, "anthropic:messages");
      const call = asToolUse(echo.messages[1]?.content);
      call.name = "web_search";
      call.input = { query: "UNSAFE-HOSTED-QUERY" };
      const prepared = (await second.prepareRequest(echo)) as {
        messages: Array<{ content: Array<{ name: string }> }>;
      };
      expect(prepared.messages[1].content[0].name).toBe("get_remedy_plans");
    });
  });

  test("ignores a cache-hint change instead of pinning it", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const cacheControl: { type: string; ttl?: string } = {
        type: "ephemeral",
      };
      const body = {
        ...anthropicBody(),
        prompt_cache_key: "caller-a",
        cache_control: cacheControl,
      };
      const replay = await open(session, body, "anthropic:messages");
      await replay.rewriteEnvelope({
        request: body,
        transform: async () => {
          body.prompt_cache_key = "caller-b";
          body.cache_control = { type: "ephemeral", ttl: "1h" };
        },
      });
      expect(body.prompt_cache_key).toBe("caller-b");
      expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      expect(await accounting(session.organizationId)).toEqual({
        rows: 0,
        bytes: 0,
      });
    });
  });

  test("a framed return with nested markers records the approved text", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const admitted = "SUMMARY(24 characters): safe";
      const carrier = [
        "▄█▄▄▄█▄",
        "██▄█▄██  started subagent 7K2-QX9M",
        "",
        admitted,
        "",
        "▄█▄▄▄█▄",
        "██▄█▄██  finished subagent 7K2-QX9M",
      ].join("\n");
      const framed = `<task id="child" state="completed">\n<task_result>\n${carrier}\n</task_result>\n</task>`;
      const original = framed.replace(carrier, admitted);
      const body = anthropicBody();
      const replay = await open(session, body, "anthropic:messages");
      await replay.prepareRequest(body);
      await replay.recordResponse({
        source: replay.captureResponse({
          content: [{ type: "text", text: original }],
        }),
        response: { content: [{ type: "text", text: framed }] },
        emitted: [],
        approvedText: original,
      });
      const echo = {
        ...anthropicBody(),
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "text", text: framed }] },
        ],
      };
      const second = await open(session, echo, "anthropic:messages");
      await second.restoreTextEchoes();
      const restored = echo.messages[1]?.content;
      if (!Array.isArray(restored)) throw new Error("expected text blocks");
      const block = restored[0];
      if (!block || typeof block === "string" || !("text" in block)) {
        throw new Error("expected text block");
      }
      expect(block.text).toBe(admitted);
      expect(block.text).not.toContain("finished subagent");
    });
  });

  test("a tampered echo loses a known return marker without restoring forged text", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const admitted = "SUMMARY(24 characters): safe";
      const marker = "▄█▄▄▄█▄\n██▄█▄██  finished subagent 7K2-QX9M";
      const recorded = `${admitted}\n\n${marker}`;
      const forged = `FORGED-ASSISTANT-RETURN\n\n${marker}`;
      const body = anthropicBody();
      const replay = await open(session, body, "anthropic:messages");
      await replay.prepareRequest(body);
      await replay.recordResponse({
        source: replay.captureResponse({
          content: [{ type: "text", text: admitted }],
        }),
        response: { content: [{ type: "text", text: recorded }] },
        emitted: [],
        approvedText: admitted,
      });
      const echo = {
        ...anthropicBody(),
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "text", text: forged }] },
        ],
      };
      const second = await open(session, echo, "anthropic:messages");
      await second.restoreTextEchoes();
      const restored = echo.messages[1]?.content;
      if (!Array.isArray(restored)) throw new Error("expected text blocks");
      const block = restored[0];
      if (!block || typeof block === "string" || !("text" in block)) {
        throw new Error("expected text block");
      }
      expect(block.text).toBe("FORGED-ASSISTANT-RETURN");
      expect(block.text).not.toContain("finished subagent");
    });
  });

  test("a stamped hosted denial records the notice, not the withheld call", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = anthropicBody();
      const replay = await open(session, body, "anthropic:messages");
      await replay.prepareRequest(body);
      const hosted = {
        id: "msg-hosted",
        content: [
          {
            type: "tool_use",
            id: "toolu_hosted",
            name: "web_search",
            input: { query: "UNSAFE-HOSTED-QUERY" },
          },
        ],
      };
      const wireId = "toolu_hosted_wire";
      const notice = {
        id: "msg-hosted",
        content: [
          {
            type: "tool_use",
            id: wireId,
            name: "get_remedy_plans",
            input: {
              tool: "web_search",
              arguments: { query: "UNSAFE-HOSTED-QUERY" },
              ruling: "approved-hold",
              notice: { v: 1, call_id: "toolu_hosted" },
            },
          },
        ],
      };
      await replay.recordResponse({
        source: replay.captureResponse(hosted),
        response: notice,
        emitted: [{ id: "toolu_hosted", wireId }],
        policyCallIds: ["toolu_hosted"],
      });
      const echo = echoBody(notice.content[0]);
      const second = await open(session, echo, "anthropic:messages");
      const call = asToolUse(echo.messages[1]?.content);
      call.name = "web_search";
      call.input = { query: "UNSAFE-HOSTED-QUERY" };
      const prepared = await second.prepareRequest(echo);
      const restored = asToolUse(messageContent(prepared, 1));
      expect(restored.name).toBe("get_remedy_plans");
      expect(restored.input).toMatchObject({ ruling: "approved-hold" });
    });
  });

  test("a child keeps its own call when the parent used the same id", async () => {
    await withSecret(async () => {
      const parent = await nativeSession();
      const parentBody = anthropicBody();
      const parentReplay = await open(parent, parentBody, "anthropic:messages");
      await parentReplay.prepareRequest(parentBody);
      const parentOriginal = toolUse("call_shared", { q: "parent" });
      const parentRewritten = toolUse("call_shared", {
        q: "parent",
        marker: "parent-meta",
      });
      await parentReplay.recordResponse({
        source: parentReplay.captureResponse({
          id: "msg-p",
          content: [parentOriginal],
        }),
        response: { id: "msg-p", content: [parentRewritten] },
        emitted: [{ id: "call_shared" }],
      });

      const child = await childSession(parent);
      const parentEcho = echoBody(parentRewritten);
      const childReplay = await open(child, parentEcho, "anthropic:messages");
      const restoredParent = await childReplay.prepareRequest(parentEcho);
      expect(asToolUse(messageContent(restoredParent, 1)).input).toEqual({
        q: "parent",
      });

      const childOriginal = toolUse("call_shared", { q: "child" });
      const childRewritten = toolUse("call_shared", {
        q: "child",
        marker: "child-meta",
      });
      await childReplay.recordResponse({
        source: childReplay.captureResponse({
          id: "msg-c",
          content: [childOriginal],
        }),
        response: { id: "msg-c", content: [childRewritten] },
        emitted: [{ id: "call_shared" }],
      });

      const childEcho = echoBody(childRewritten);
      const reread = await open(child, childEcho, "anthropic:messages");
      const restoredChild = await reread.prepareRequest(childEcho);
      expect(asToolUse(messageContent(restoredChild, 1)).input).toEqual({
        q: "child",
      });
      expect(JSON.stringify(restoredChild)).not.toContain("parent-meta");

      const parentAgain = echoBody(parentRewritten);
      const again = await open(child, parentAgain, "anthropic:messages");
      const stillParent = await again.prepareRequest(parentAgain);
      expect(asToolUse(messageContent(stillParent, 1)).input).toEqual({
        q: "parent",
      });
      expect(JSON.stringify(stillParent)).not.toContain("child-meta");
    });
  });

  test("the same owner cannot reuse a call id with different bytes", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = anthropicBody();
      const replay = await open(session, body, "anthropic:messages");
      await replay.prepareRequest(body);
      const original = toolUse("call_shared", { q: "first" });
      const rewritten = toolUse("call_shared", { q: "first", marker: "a" });
      await replay.recordResponse({
        source: replay.captureResponse({ id: "msg-1", content: [original] }),
        response: { id: "msg-1", content: [rewritten] },
        emitted: [{ id: "call_shared" }],
      });
      await expect(
        replay.recordResponse({
          source: replay.captureResponse({
            id: "msg-2",
            content: [toolUse("call_shared", { q: "second" })],
          }),
          response: {
            id: "msg-2",
            content: [toolUse("call_shared", { q: "second", marker: "b" })],
          },
          emitted: [{ id: "call_shared" }],
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const echo = echoBody(rewritten);
      const reread = await open(session, echo, "anthropic:messages");
      const restored = await reread.prepareRequest(echo);
      expect(asToolUse(messageContent(restored, 1)).input).toEqual({
        q: "first",
      });
    });
  });

  test.each([
    "child",
    "fork",
  ] as const)("restores source-owned echoes through a %s and its nested child", async (kind) => {
    await withSecret(async () => {
      const source = await nativeSession();
      const body = anthropicBody();
      const first = await open(source, body, "anthropic:messages");
      await first.prepareRequest(body);
      const original = toolUse("call_ancestor", { q: "source" });
      const rewritten = toolUse("call_ancestor", {
        q: "source",
        marker: "ancestor-meta",
      });
      await first.recordResponse({
        source: first.captureResponse({
          id: "msg-ancestor",
          content: [original],
        }),
        response: { id: "msg-ancestor", content: [rewritten] },
        emitted: [{ id: "call_ancestor" }],
      });
      const middle = await childSession(source);
      if (kind === "fork") {
        await db
          .update(schema.openappaSessionsTable)
          .set({
            root: `fork-${middle.session.session_id}`,
            parentId: null,
            forkedFrom: source.session.session_id,
          })
          .where(
            eq(
              schema.openappaSessionsTable.sessionId,
              middle.session.session_id,
            ),
          );
      }
      const inherited = echoBody(rewritten);
      await (
        await open(middle, inherited, "anthropic:messages")
      ).prepareRequest(inherited);
      const child = await childSession(middle);
      const echo = echoBody(rewritten);
      const restored = await (
        await open(child, echo, "anthropic:messages")
      ).prepareRequest(echo);
      expect(asToolUse(messageContent(restored, 1))).toEqual(original);
    });
  });

  test("populates the byte-bounded ciphertext cache once per batch", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = anthropicBody();
      const replay = await open(session, body, "anthropic:messages");
      await replay.prepareRequest(body);
      const calls = Array.from({ length: 256 }, (_, index) =>
        toolUse(`call_${index}`, { q: index }),
      );
      const response = { id: "msg-batch", content: calls };
      const set = vi.spyOn(LRUCacheManager.prototype, "set");
      const setMany = vi.spyOn(LRUCacheManager.prototype, "setMany");
      const get = vi.spyOn(LRUCacheManager.prototype, "get");
      const load = vi.spyOn(OpenAppaRewriteModel, "loadBatch");
      try {
        await replay.recordResponse({
          source: replay.captureResponse(response),
          response,
          emitted: calls.map(({ id }) => ({ id })),
        });
        expect(setMany).toHaveBeenCalledTimes(1);
        expect(set).not.toHaveBeenCalled();
        const entries = setMany.mock.calls[0][0];
        expect(entries).toHaveLength(calls.length * 2 + 1);
        const identities = entries.map(([key]) => JSON.parse(key) as unknown[]);
        expect(identities[0]).toEqual([
          session.organizationId,
          expect.any(String),
          1,
          session.session.session_id,
          expect.stringMatching(/^[0-9a-f]{64}$/),
        ]);
        const fragmentKeys = new Set(
          identities.map((identity) => String(identity[4])),
        );
        expect(fragmentKeys.size).toBe(entries.length);
        expect((await pairRows(session.organizationId)).length).toBeGreaterThan(
          calls.length,
        );

        get.mockClear();
        load.mockClear();
        const echo = echoBody(toolUse("call_0", { q: 0 }));
        const warm = await open(session, echo, "anthropic:messages");
        const restored = await warm.prepareRequest(echo);
        expect(asToolUse(messageContent(restored, 1))).toEqual(calls[0]);
        const hits = get.mock.results.flatMap((result) => {
          const value: unknown = result.value;
          if (
            result.type !== "return" ||
            !value ||
            typeof value !== "object" ||
            !("fragmentKey" in value) ||
            typeof value.fragmentKey !== "string" ||
            !fragmentKeys.has(value.fragmentKey)
          )
            return [];
          return [value.fragmentKey];
        });
        expect(new Set(hits).size).toBe(2);
        expect(
          load.mock.calls.filter(([, keys]) =>
            keys.some((key) => fragmentKeys.has(key)),
          ),
        ).toHaveLength(0);
      } finally {
        set.mockRestore();
        setMany.mockRestore();
        get.mockRestore();
        load.mockRestore();
      }
    });
  });

  test("a later fragment does not extend an earlier ciphertext cache TTL", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const body = anthropicBody();
      const replay = await open(session, body, "anthropic:messages");
      await replay.prepareRequest(body);
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const load = vi.spyOn(OpenAppaRewriteModel, "loadBatch");
      try {
        const old = appendSessionReceipt("old", "ABC-DEFG");
        await replay.recordResponse({
          source: replay.captureResponse({
            id: "msg-old",
            content: [{ type: "text", text: "old" }],
          }),
          response: { id: "msg-old", content: [{ type: "text", text: old }] },
          emitted: [],
        });
        now += 30_000;
        const recent = appendSessionReceipt("recent", "ABC-DEFG");
        await replay.recordResponse({
          source: replay.captureResponse({
            id: "msg-recent",
            content: [{ type: "text", text: "recent" }],
          }),
          response: {
            id: "msg-recent",
            content: [{ type: "text", text: recent }],
          },
          emitted: [],
        });
        now += 30_001;
        const makeEcho = (content: string) => ({
          ...anthropicBody(),
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content },
          ],
        });
        load.mockClear();
        const expiredEcho = makeEcho(old);
        await (
          await open(session, expiredEcho, "anthropic:messages")
        ).restoreTextEchoes();
        expect(expiredEcho.messages[1].content).toBe("old");
        expect(load).toHaveBeenCalledTimes(1);

        load.mockClear();
        const warmEcho = makeEcho(recent);
        await (
          await open(session, warmEcho, "anthropic:messages")
        ).restoreTextEchoes();
        expect(warmEcho.messages[1].content).toBe("recent");
        expect(load).not.toHaveBeenCalled();
      } finally {
        load.mockRestore();
        clock.mockRestore();
      }
    });
  });

  test("a missing or corrupt ancestor scope fails closed", async () => {
    await withSecret(async () => {
      const parent = await nativeSession();
      const parentBody = anthropicBody();
      const parentReplay = await open(parent, parentBody, "anthropic:messages");
      await parentReplay.prepareRequest(parentBody);
      await parentReplay.recordResponse({
        source: parentReplay.captureResponse({
          id: "msg-epoch",
          content: [toolUse("call_epoch", { q: "x" })],
        }),
        response: {
          id: "msg-epoch",
          content: [toolUse("call_epoch", { q: "x", marker: "epoch-meta" })],
        },
        emitted: [{ id: "call_epoch" }],
      });
      await db
        .update(schema.openappaRewriteGroupsTable)
        .set({ epoch: 2 })
        .where(
          eq(
            schema.openappaRewriteGroupsTable.organizationId,
            parent.organizationId,
          ),
        );
      const shifted = await childSession(parent);
      const shiftedEcho = echoBody(toolUse("call_epoch", { q: "x" }));
      const shiftedReplay = await open(
        shifted,
        shiftedEcho,
        "anthropic:messages",
      );
      await expect(
        shiftedReplay.prepareRequest(shiftedEcho),
      ).rejects.toMatchObject({ statusCode: 409 });

      const foreign = await childSession(parent, "missing-session");
      const foreignEcho = echoBody(toolUse("call_foreign", { q: "x" }));
      const foreignReplay = await open(
        foreign,
        foreignEcho,
        "anthropic:messages",
      );
      await expect(
        foreignReplay.prepareRequest(foreignEcho),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        foreignReplay.prepareRequest(foreignEcho),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });
});

async function expectRestoredArguments(
  family: "openai:chatCompletions" | "openai:responses",
) {
  const session = await nativeSession();
  const initial =
    family === "openai:chatCompletions"
      ? {
          model: "m",
          messages: [{ role: "user", content: "hi" }],
        }
      : {
          model: "m",
          input: [{ type: "message", role: "user", content: "hi" }],
        };
  const first = await open(session, initial, family);
  await first.prepareRequest(initial);
  const call = providerCall(family);
  const original =
    family === "openai:chatCompletions"
      ? { choices: [{ message: { role: "assistant", tool_calls: [call] } }] }
      : { output: [call] };
  const source = first.captureResponse(original);
  const emitted = structuredClone(original);
  const emittedCall =
    family === "openai:chatCompletions"
      ? (
          emitted as {
            choices: Array<{
              message: { tool_calls: Array<Record<string, unknown>> };
            }>;
          }
        ).choices[0].message.tool_calls[0]
      : (emitted as { output: Array<Record<string, unknown>> }).output[0];
  if (family === "openai:chatCompletions") {
    (emittedCall.function as { arguments: string }).arguments = JSON.stringify({
      q: "café  spaced",
    });
  } else {
    emittedCall.arguments = JSON.stringify({ q: "café  spaced" });
  }
  delete emittedCall.provider_ext;
  await first.recordResponse({
    source,
    response: emitted,
    emitted: [{ id: "call_exact" }],
  });

  const echo = echoedRequest(family);
  const again = await open(session, echo, family);
  if (family === "openai:chatCompletions") {
    const call = echo.messages?.[1].tool_calls?.[0];
    if (!call) throw new Error("Missing chat fixture call");
    call.function.arguments = '{"q":"changed"}';
  } else {
    const call = echo.input?.[1];
    if (!call) throw new Error("Missing Responses fixture call");
    call.arguments = '{"q":"changed"}';
  }
  const prepared: unknown = await again.prepareRequest(echo);
  const restored =
    family === "openai:chatCompletions"
      ? (
          prepared as {
            messages: Array<{
              tool_calls: Array<{
                function: { arguments: string };
                provider_ext: unknown;
              }>;
            }>;
          }
        ).messages[1].tool_calls[0]
      : (
          prepared as {
            input: Array<{ arguments: string; provider_ext: unknown }>;
          }
        ).input[1];
  const args =
    family === "openai:chatCompletions"
      ? (
          restored as {
            function: { arguments: string };
          }
        ).function.arguments
      : (restored as { arguments: string }).arguments;
  expect(args).toBe(EXACT_ARGUMENTS);
  expect((restored as { provider_ext: unknown }).provider_ext).toEqual({
    vendor: "keep",
    note: "  spaced",
  });
  expect(dumpRows(await pairRows(session.organizationId))).not.toContain(
    EXACT_ARGUMENTS,
  );
}

function providerCall(family: "openai:chatCompletions" | "openai:responses") {
  if (family === "openai:chatCompletions") {
    return {
      id: "call_exact",
      type: "function",
      function: { name: "read", arguments: EXACT_ARGUMENTS },
      provider_ext: { vendor: "keep", note: "  spaced" },
    };
  }
  return {
    type: "function_call",
    call_id: "call_exact",
    name: "read",
    arguments: EXACT_ARGUMENTS,
    provider_ext: { vendor: "keep", note: "  spaced" },
  };
}

function echoedRequest(family: "openai:chatCompletions" | "openai:responses") {
  const normalized = JSON.stringify({ q: "café  spaced" });
  if (family === "openai:chatCompletions") {
    return {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_exact",
              type: "function",
              function: { name: "read", arguments: normalized },
            },
          ],
        },
      ],
    };
  }
  return {
    model: "m",
    input: [
      { type: "message", role: "user", content: "hi" },
      {
        type: "function_call",
        call_id: "call_exact",
        name: "read",
        arguments: normalized,
      },
    ],
  };
}

function asToolUse(content: unknown): { name: string; input: unknown } {
  const call = Array.isArray(content) ? content[0] : content;
  if (
    !call ||
    typeof call !== "object" ||
    !("name" in call) ||
    typeof call.name !== "string" ||
    !("input" in call)
  ) {
    throw new Error("expected tool_use");
  }
  return call;
}

function messageContent(body: unknown, index: number): unknown {
  if (!body || typeof body !== "object" || !("messages" in body)) {
    throw new Error("expected messages");
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) throw new Error("expected messages");
  const message = messages[index];
  if (!message || typeof message !== "object" || !("content" in message)) {
    throw new Error("expected message");
  }
  return message.content;
}

function toolUse(id: string, input: Record<string, unknown>) {
  return {
    type: "tool_use" as const,
    id,
    name: "read",
    input,
  };
}

function echoBody(call: {
  type: string;
  id: string;
  name: string;
  input: unknown;
}) {
  return {
    model: "m",
    max_tokens: 8,
    system: "Base",
    tools: anthropicBody().tools,
    messages: [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: [call] },
    ],
  };
}

function anthropicBody() {
  return {
    model: "m",
    max_tokens: 8,
    system: "Base",
    tools: [
      {
        name: "read",
        description: "stable-schema",
        input_schema: { type: "object", properties: {} },
      },
    ],
    messages: [{ role: "user", content: "hello" }],
  };
}

function toolResultBody(content: string) {
  return {
    model: "m",
    max_tokens: 8,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "read",
            input: { path: "a" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content,
            vendor: "keep",
          },
        ],
      },
    ],
  };
}

async function open(
  session: Awaited<ReturnType<typeof nativeSession>>,
  body: unknown,
  family: "anthropic:messages" | "openai:chatCompletions" | "openai:responses",
) {
  return AppaRewriteReplay.open({
    session: session.session,
    capture: captureAppaReplayRequest({ family, body }),
    encryptedChat: { kind: "none" },
  });
}

let sessionCounter = 0;

async function nativeSession() {
  sessionCounter += 1;
  const organizationId = `org-replay-${sessionCounter}`;
  const sessionId = `session-${sessionCounter}`;
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(sessionId),
    root: `root-${sessionCounter}`,
    organizationId,
    callerId: "caller",
    sessionId,
    startDecision: { decision: "ack" },
  });
  return {
    organizationId,
    session: {
      organization_id: organizationId,
      session_id: sessionId,
      caller_id: "caller",
    },
  };
}

async function childSession(
  parent: Awaited<ReturnType<typeof nativeSession>>,
  parentId = parent.session.session_id,
) {
  sessionCounter += 1;
  const sessionId = `session-${sessionCounter}`;
  const [nativeParent] = await db
    .select({ root: schema.openappaSessionsTable.root })
    .from(schema.openappaSessionsTable)
    .where(
      eq(
        schema.openappaSessionsTable.actor,
        openappaActor(parent.session.session_id),
      ),
    );
  if (!nativeParent) throw new Error("Missing native parent fixture");
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(sessionId),
    root: nativeParent.root,
    organizationId: parent.organizationId,
    callerId: "caller",
    sessionId,
    parentId,
    startDecision: { decision: "ack" },
  });
  return {
    organizationId: parent.organizationId,
    session: {
      organization_id: parent.organizationId,
      session_id: sessionId,
      caller_id: "caller",
      parent_id: parentId,
    },
  };
}

async function pairRows(organizationId: string) {
  return db
    .select()
    .from(schema.openappaRewritePairsTable)
    .where(eq(schema.openappaRewritePairsTable.organizationId, organizationId));
}

async function accounting(organizationId: string) {
  const rows = await pairRows(organizationId);
  const [group] = await db
    .select()
    .from(schema.openappaRewriteGroupsTable)
    .where(
      eq(schema.openappaRewriteGroupsTable.organizationId, organizationId),
    );
  return {
    rows: rows.length,
    bytes: group.byteCount,
  };
}

function dumpRows(
  rows: Array<{
    fragmentKey: string;
    original: Buffer | Uint8Array;
    rewritten: Buffer | Uint8Array;
  }>,
) {
  return rows
    .map(
      (row) =>
        `${row.fragmentKey}\n${Buffer.from(row.original).toString("utf8")}\n${Buffer.from(row.rewritten).toString("utf8")}`,
    )
    .join("\n");
}

describe("control outcome receipts", () => {
  const MARKER = "CONTROL-EXACT-BYTES-MARKER";

  test("reserves an encrypted single-use identity before effects and completes exact bytes", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const params = {
        session: session.session,
        toolCallId: "toolu_reserved",
        spenderId: "user:operator",
        requestIdentity: "a".repeat(64),
      };
      const receipt = await AppaRewriteReplay.reserveControlOutcome(params);
      const reserved = await accounting(session.organizationId);
      expect(reserved.rows).toBe(1);
      expect(reserved.bytes).toBeGreaterThan(1024 * 1024);
      expect(
        await AppaRewriteReplay.readControlReceipts({
          session: session.session,
          toolCallIds: [params.toolCallId],
        }),
      ).toEqual(new Map());
      await expect(
        AppaRewriteReplay.reserveControlOutcome({
          ...params,
          requestIdentity: "b".repeat(64),
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const result = { outcome: "applied" as const, bytes: MARKER };
      await receipt.complete(result);
      await receipt.complete(result);
      const retained = await AppaRewriteReplay.readControlReceipts({
        session: session.session,
        toolCallIds: [params.toolCallId],
      });
      expect(retained.get(params.toolCallId)).toEqual(result);
      const completed = await accounting(session.organizationId);
      expect(completed.rows).toBe(1);
      expect(completed.bytes).toBeLessThan(reserved.bytes);
      expect(dumpRows(await pairRows(session.organizationId))).not.toContain(
        MARKER,
      );
      await expect(
        receipt.complete({ ...result, bytes: "changed" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        AppaRewriteReplay.reserveControlOutcome(params),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  test("preflight refuses call identity, foreign owner, encryption and capacity failures", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const params = {
        session: session.session,
        toolCallId: "toolu_preflight",
        spenderId: "user:operator",
        requestIdentity: "a".repeat(64),
      };
      await expect(
        AppaRewriteReplay.reserveControlOutcome({ ...params, toolCallId: "" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        AppaRewriteReplay.reserveControlOutcome({
          ...params,
          encryptedChat: { kind: "redact" },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        AppaRewriteReplay.reserveControlOutcome({
          ...params,
          session: { ...session.session, caller_id: "foreign" },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await pairRows(session.organizationId)).toEqual([]);
      const before = config.openappa.rewrite;
      config.openappa.rewrite = { ...before, maxBytes: 1024 };
      try {
        await expect(
          AppaRewriteReplay.reserveControlOutcome(params),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(await pairRows(session.organizationId)).toEqual([]);
      } finally {
        config.openappa.rewrite = before;
      }
    });
  });

  test("does not expose an oversized or corrupt reserved outcome", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const receipt = await AppaRewriteReplay.reserveControlOutcome({
        session: session.session,
        toolCallId: "toolu_large_reserved",
        spenderId: "user:operator",
        requestIdentity: "a".repeat(64),
      });
      await expect(
        receipt.complete({
          outcome: "applied",
          bytes: "x".repeat(1024 * 1024),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(
        await AppaRewriteReplay.readControlReceipts({
          session: session.session,
          toolCallIds: ["toolu_large_reserved"],
        }),
      ).toEqual(new Map());
      const other = await AppaRewriteReplay.reserveControlOutcome({
        session: session.session,
        toolCallId: "toolu_corrupt_reserved",
        spenderId: "user:operator",
        requestIdentity: "b".repeat(64),
      });
      await db
        .update(schema.openappaRewritePairsTable)
        .set({ originalDigest: "0".repeat(64) });
      await expect(
        other.complete({ outcome: "applied", bytes: MARKER }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        await AppaRewriteReplay.readControlReceipts({
          session: session.session,
          toolCallIds: ["toolu_corrupt_reserved"],
        }),
      ).toEqual(new Map());
    });
  });

  test("stores encrypted exact bytes under the provider call id", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const bytes = `{"ok":false,"outcome":"review_required","marker":"${MARKER}"}`;
      await AppaRewriteReplay.storeControlOutcome({
        session: session.session,
        toolCallId: "toolu_provider_call",
        outcome: "pending",
        bytes,
      });
      expect(dumpRows(await pairRows(session.organizationId))).not.toContain(
        MARKER,
      );
      const read = await AppaRewriteReplay.readControlReceipts({
        session: session.session,
        toolCallIds: ["toolu_provider_call", "offer-not-the-call"],
      });
      expect(read.get("toolu_provider_call")).toEqual({
        outcome: "pending",
        bytes,
      });
      expect(read.has("offer-not-the-call")).toBe(false);
      expect(
        await AppaRewriteReplay.readControlReceipts({
          session: { ...session.session, caller_id: "another-caller" },
          toolCallIds: ["toolu_provider_call"],
        }),
      ).toEqual(new Map());
      const before = await accounting(session.organizationId);
      await AppaRewriteReplay.storeControlOutcome({
        session: session.session,
        toolCallId: "toolu_provider_call",
        outcome: "pending",
        bytes,
      });
      expect(await accounting(session.organizationId)).toEqual(before);
    });
  });

  test("keeps pending, denied, canceled, refused, and applied distinct", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      const classes = [
        "pending",
        "denied",
        "canceled",
        "refused",
        "applied",
      ] as const;
      for (const outcome of classes) {
        await AppaRewriteReplay.storeControlOutcome({
          session: session.session,
          toolCallId: `toolu_${outcome}`,
          outcome,
          bytes: `bytes-${outcome}`,
        });
      }
      const read = await AppaRewriteReplay.readControlReceipts({
        session: session.session,
        toolCallIds: classes.map((outcome) => `toolu_${outcome}`),
      });
      for (const outcome of classes) {
        expect(read.get(`toolu_${outcome}`)).toEqual({
          outcome,
          bytes: `bytes-${outcome}`,
        });
      }
      await expect(
        AppaRewriteReplay.storeControlOutcome({
          session: session.session,
          toolCallId: "toolu_pending",
          outcome: "applied",
          bytes: "bytes-pending",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (
          await AppaRewriteReplay.readControlReceipts({
            session: session.session,
            toolCallIds: ["toolu_pending"],
          })
        ).get("toolu_pending")?.outcome,
      ).toBe("pending");
    });
  });

  test("withholds a foreign session and a claimed parent that native lineage does not name", async () => {
    await withSecret(async () => {
      const parent = await nativeSession();
      const foreignId = `foreign-${parent.organizationId}`;
      await db.insert(schema.openappaSessionsTable).values({
        actor: openappaActor(foreignId),
        root: `root-${foreignId}`,
        organizationId: parent.organizationId,
        callerId: "caller",
        sessionId: foreignId,
        startDecision: { decision: "ack" },
      });
      const foreign = {
        organization_id: parent.organizationId,
        session_id: foreignId,
        caller_id: "caller",
      };
      const child = await childSession(parent);
      await AppaRewriteReplay.storeControlOutcome({
        session: parent.session,
        toolCallId: "toolu_parent_pending",
        outcome: "pending",
        bytes: "parent-pending",
      });
      await AppaRewriteReplay.storeControlOutcome({
        session: foreign,
        toolCallId: "toolu_foreign",
        outcome: "applied",
        bytes: "foreign-applied",
      });
      const inherited = await AppaRewriteReplay.readControlReceipts({
        session: child.session,
        toolCallIds: ["toolu_parent_pending", "toolu_foreign"],
      });
      expect(inherited.get("toolu_parent_pending")?.bytes).toBe(
        "parent-pending",
      );
      expect(inherited.has("toolu_foreign")).toBe(false);
      const claimed = await AppaRewriteReplay.readControlReceipts({
        session: { ...child.session, parent_id: foreign.session_id },
        toolCallIds: ["toolu_foreign", "toolu_parent_pending"],
      });
      expect(claimed.has("toolu_foreign")).toBe(false);
      expect(claimed.get("toolu_parent_pending")?.bytes).toBe("parent-pending");
      const other = await AppaRewriteReplay.readControlReceipts({
        session: foreign,
        toolCallIds: ["toolu_parent_pending"],
      });
      expect(other.has("toolu_parent_pending")).toBe(false);
    });
  });

  test("does not serve an expired receipt from cache or renew the group", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      await AppaRewriteReplay.storeControlOutcome({
        session: session.session,
        toolCallId: "toolu_expiring",
        outcome: "pending",
        bytes: MARKER,
      });
      const live = await AppaRewriteReplay.open({
        session: session.session,
        capture: captureAppaReplayRequest({
          family: "anthropic:messages",
          body: { messages: [] },
        }),
        encryptedChat: { kind: "none" },
      });
      expect(
        (await live.readControlReceipts(["toolu_expiring"])).get(
          "toolu_expiring",
        )?.bytes,
      ).toBe(MARKER);
      await db
        .update(schema.openappaRewriteGroupsTable)
        .set({ status: "expired", expiresAt: new Date(0) })
        .where(
          eq(
            schema.openappaRewriteGroupsTable.organizationId,
            session.organizationId,
          ),
        );
      expect(
        await AppaRewriteReplay.readControlReceipts({
          session: session.session,
          toolCallIds: ["toolu_expiring"],
        }),
      ).toEqual(new Map());
      expect(await live.readControlReceipts(["toolu_expiring"])).toEqual(
        new Map(),
      );
      expect(await live.readControlReceipts(["toolu_expiring"])).toEqual(
        new Map(),
      );
      await expect(
        AppaRewriteReplay.storeControlOutcome({
          session: session.session,
          toolCallId: "toolu_expiring",
          outcome: "pending",
          bytes: MARKER,
        }),
      ).rejects.toMatchObject({ statusCode: 410 });
      const [group] = await db
        .select({ status: schema.openappaRewriteGroupsTable.status })
        .from(schema.openappaRewriteGroupsTable)
        .where(
          eq(
            schema.openappaRewriteGroupsTable.organizationId,
            session.organizationId,
          ),
        );
      expect(group.status).toBe("expired");
    });
  });

  test("stores an encrypted chat under the conversation key and ignores a foreign facade", async () => {
    await withSecret(async () => {
      const owner = await nativeSession();
      const foreign = await nativeSession();
      const dek = Buffer.alloc(32, 9);
      const encryptedChat = {
        kind: "encrypt" as const,
        audit: {
          dek,
          conversationId: "00000000-0000-4000-8000-0000000000aa",
        },
      };
      const bytes = "CHAT-CONTROL-MARKER";
      await AppaRewriteReplay.storeControlOutcome({
        session: owner.session,
        toolCallId: "toolu_chat",
        outcome: "pending",
        bytes,
        encryptedChat,
      });
      expect(dumpRows(await pairRows(owner.organizationId))).not.toContain(
        bytes,
      );
      expect(
        await AppaRewriteReplay.readControlReceipts({
          session: owner.session,
          toolCallIds: ["toolu_chat"],
        }),
      ).toEqual(new Map());
      expect(
        (
          await AppaRewriteReplay.readControlReceipts({
            session: owner.session,
            toolCallIds: ["toolu_chat"],
            encryptedChat,
          })
        ).get("toolu_chat")?.bytes,
      ).toBe(bytes);
      const chatReplay = await AppaRewriteReplay.open({
        session: owner.session,
        capture: captureAppaReplayRequest({
          family: "anthropic:messages",
          body: { messages: [] },
        }),
        encryptedChat,
      });
      expect(
        (
          await AppaRewriteReplay.readControlReceipts({
            session: owner.session,
            toolCallIds: ["toolu_chat"],
            replay: chatReplay,
          })
        ).get("toolu_chat")?.bytes,
      ).toBe(bytes);
      await AppaRewriteReplay.storeControlOutcome({
        session: foreign.session,
        toolCallId: "toolu_foreign_chat",
        outcome: "applied",
        bytes: "FOREIGN-CONTROL",
      });
      const foreignReplay = await AppaRewriteReplay.open({
        session: foreign.session,
        capture: captureAppaReplayRequest({
          family: "anthropic:messages",
          body: { messages: [] },
        }),
        encryptedChat: { kind: "none" },
      });
      expect(
        await AppaRewriteReplay.readControlReceipts({
          session: owner.session,
          toolCallIds: ["toolu_foreign_chat", "toolu_chat"],
          replay: foreignReplay,
        }),
      ).toEqual(new Map());
    });
  });

  test("does not write an encrypted chat that has no conversation key", async () => {
    await withSecret(async () => {
      const session = await nativeSession();
      await expect(
        AppaRewriteReplay.storeControlOutcome({
          session: session.session,
          toolCallId: "toolu_redact",
          outcome: "pending",
          bytes: "UNKEYED-CONTROL",
          encryptedChat: { kind: "redact" },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await pairRows(session.organizationId)).toEqual([]);
    });
  });

  test("rejects a second receipt when the tree budget is exhausted", async () => {
    await withSecret(async () => {
      const previous = config.openappa.rewrite;
      config.openappa.rewrite = { ...previous, maxEntries: 1 };
      try {
        const session = await nativeSession();
        await AppaRewriteReplay.storeControlOutcome({
          session: session.session,
          toolCallId: "toolu_first",
          outcome: "pending",
          bytes: MARKER,
        });
        await expect(
          AppaRewriteReplay.storeControlOutcome({
            session: session.session,
            toolCallId: "toolu_second",
            outcome: "pending",
            bytes: "second-marker",
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(dumpRows(await pairRows(session.organizationId))).not.toContain(
          "second-marker",
        );
        expect(
          (
            await AppaRewriteReplay.readControlReceipts({
              session: session.session,
              toolCallIds: ["toolu_first", "toolu_second"],
            })
          ).get("toolu_first")?.bytes,
        ).toBe(MARKER);
      } finally {
        config.openappa.rewrite = previous;
      }
    });
  });
});

async function withSecret(run: () => Promise<void>) {
  config.secretsManager = {
    ...secretsSnapshot,
    encryptionSecret: ENCRYPTION_SECRET,
  };
  try {
    await run();
  } finally {
    config.secretsManager = secretsSnapshot;
  }
}
