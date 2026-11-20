import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rmdir, stat } from "node:fs/promises";
import { createServer, request as requestHttp } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import "../src/server/composition.ts";
import { CacheKey, cacheManager } from "../src/cache-manager.ts";
import config from "../src/config.ts";
import db, { initializeDatabase, schema, withDbTransaction } from "../src/database/index.ts";
import { createFastifyInstance } from "../src/fastify-instance.ts";
import { AgentModel, InteractionModel, LlmProviderApiKeyModel, ModelModel, ModelPoolModel, VirtualApiKeyModel } from "../src/models/index.ts";
import InteractionBillingModel from "../src/models/interaction-billing.ts";
import GuardrailsDeploymentModel from "../src/models/guardrails-deployment.ts";
import LlmThroughputModel from "../src/models/llm-throughput.ts";
import CacheEntryModel from "../src/models/cache-entry.ts";
import { mintDelegationMarker } from "../src/openappa/delegation.ts";
import { signRuntimeToolProof } from "../src/openappa/runtime-tool-claims.ts";
import { openappaActor, scopedSessionId } from "../src/openappa/actor.ts";
import { stripSessionReceipts } from "../src/openappa/session-token.ts";
import ResourcePermissionPolicyModel from "../src/models/resource-permission-policy.ts";
import healthRoutes from "../src/routes/health.ts";
import modelRouterProxyRoutes from "../src/routes/proxy/routes/model-router.ts";
import openaiProxyRoutes from "../src/routes/proxy/routes/openai.ts";
import { secretManager } from "../src/secrets-manager/index.ts";
import { makePassthroughCredential } from "../src/test/llm-proxy-credentials.ts";
import { callRustApi } from "../src/utils/rust-api.ts";
import { drainBackgroundWork } from "../src/utils/background-work.ts";
import { registerLlmProxyPlugin } from "../src/proxy/plugins/registry.ts";

test("Rust upstream transport preserves OpenAI events, cancellation, and single-write accounting", { timeout: 200_000 }, async () => {
  assert.equal(new URL(config.database.url).pathname, "/archestra_riir_test");
  await initializeDatabase();
  const scratch = await mkdtemp("/tmp/riir-openai-");
  const socket = join(scratch, "api.sock");
  const frames = {
    model: "riir-openai-fixture",
    created: 1,
    object: "chat.completion.chunk",
    id: "chatcmpl-riir",
  };
  const firstToolDelta = {
    index: 0, id: "call_fixture", type: "function",
    function: { name: "lookup_note", arguments: '{"note":' },
  };
  const providerFailure = { message: "Fixture provider refusal", type: "server_error" };
  let scenario;
  const upstream = createServer(async (request, response) => {
    const current = scenario;
    response.once("close", () => current.closed.resolve());
    let body = "";
    for await (const chunk of request) body += chunk;
    current.requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      encoding: request.headers["accept-encoding"],
      body: JSON.parse(body),
    });
    current.received.resolve();
    if (current.mode === "headers") return;
    if (current.mode === "pool-cutoff") {
      if (request.headers.authorization === "Bearer fixture-timeout") {
        response.once("close", () => current.cutoffClosed.resolve());
        return;
      }
      await Promise.race([current.releaseFallback.promise, current.closed.promise]);
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ ...frames, choices: [{
        index: 0, delta: { role: "assistant", content: "Fallback answer" }, finish_reason: "stop",
      }] })}\n\ndata: ${JSON.stringify({ ...frames, choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (current.mode === "http-error") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: providerFailure }));
      return;
    }
    if (current.mode === "relay-error") {
      response.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (current.mode === "empty") {
      response.end("data: [DONE]\n\n");
      return;
    }
    if (current.mode === "first-event-error") {
      response.end(`data: ${JSON.stringify({ error: providerFailure })}\n\n`);
      return;
    }
    const chunk = JSON.stringify({
      ...frames,
      choices: [{ index: 0, delta: {
        role: "assistant", content: "Héllo", tool_calls: [firstToolDelta],
      }, finish_reason: null }],
    });
    if (current.mode === "complete") {
      response.write(`data: ${JSON.stringify({
        ...frames, choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      })}\n\n`);
    }
    response.write(": comment\r\n\r\nda");
    const bytes = Buffer.from(`ta: ${chunk}\r\n\r\n`);
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    response.write(bytes.subarray(0, split));
    response.write(bytes.subarray(split));
    if (current.mode !== "complete") return;
    await Promise.race([current.release.promise, current.closed.promise]);
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify({
      ...frames,
      choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, function: { arguments: '"café"}' } }],
      }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      ...frames,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      ...frames, choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const nativeDatabase = new URL(config.database.url);
  nativeDatabase.searchParams.set("application_name", "riir-native-openai");
  const child = spawn("../archestra-rs/target/debug/archestra-api", [socket], {
    env: {
      ...process.env,
      ARCHESTRA_DATABASE_URL: nativeDatabase.href,
      ARCHESTRA_LLM_PROXY_RUST_OPENAI_STREAM_ENABLED: "true",
      ARCHESTRA_OPENAI_BASE_URL: upstreamUrl,
    },
    stdio: "inherit",
  });
  const childExit = once(child, "exit");
  const app = createFastifyInstance();
  let policyRelay;
  let heldReply;
  const terminalPath = "/internal/v1/openai/terminal-sse";
  const policyPath = "/internal/v1/openai/policy-sse";
  const receiptPath = "/internal/v1/openai/receipt-prefix-sse";
  const replacementText = "Approved café summary.\nSecond line.";
  const proofTime = Math.floor(Date.now() / 1000);
  const unregisterFinalizer = registerLlmProxyPlugin({
    id: "riir-finalizer",
    finalizesToolCalls: true,
    async onPrepareToolCalls() {
      scenario.policyOrder.push("prepare");
    },
    async onToolCalls({ toolCalls, organizationId }) {
      scenario.policyOrder.push("finalize");
      scenario.policyCalls.push(toolCalls.map(({ id, name, arguments: args }) => ({
        id, name, args: typeof args === "string" ? JSON.parse(args) : args,
      })));
      switch (scenario.policy) {
        case "deny":
          return {
            decision: "refuse",
            refusal: {
              refusalMessage: "Private policy detail",
              contentMessage: "The note lookup was declined.",
              reason: "fixture rule",
              blockedToolName: "lookup_note",
              toolInput: { note: "café" },
              allToolCallNames: ["lookup_note"],
            },
          };
        case "rewrite":
          return {
            decision: "allow",
            rewritten: toolCalls.map(({ id, name }) => ({ id, name })),
            toolCalls: toolCalls.map((call) => ({
              ...call,
              wireId: "call_approved",
              arguments: { note: "public excerpt" },
            })),
          };
        case "proof":
        case "invalid-proof-mutation":
        case "invalid-proof": {
          const session = { organization_id: organizationId, session_id: "fixture-session" };
          const action = "lookup_note";
          const runtimeProofs = toolCalls.map(({ id, name }) => ({
            id, name, session, action, spawn: false, wrapped: false,
          }));
          return {
            decision: "allow",
            runtimeProofs,
            toolCalls: toolCalls.map((call) => {
              const args = JSON.parse(call.arguments);
              const proof = signRuntimeToolProof({
                session, action, arguments: args, toolCallId: call.id, spawn: false,
                now: proofTime, secret: config.openappa.offerSigningSecret,
              });
              assert.ok(proof);
              return { ...call, arguments: {
                ...args,
                ...(scenario.policy === "invalid-proof-mutation" ? { note: "unapproved mutation" } : {}),
                runtime_proof: scenario.policy === "invalid-proof" ? `${proof}a` : proof,
              } };
            }),
          };
        }
        case "marker":
        case "invalid-marker-mutation":
        case "invalid-marker": {
          const [call] = toolCalls;
          const args = JSON.parse(call.arguments);
          const delegationBinding = { spawnerNativeId: "fixture-spawner", callerId: "fixture-caller" };
          const marker = mintDelegationMarker({
            organizationId, ...delegationBinding, parentId: "fixture-parent",
            prompt: args.note, spawnCallId: call.id, runtimeSessionId: "fixture-runtime",
          });
          assert.ok(marker);
          const appended = `\n\n${scenario.policy === "invalid-marker" ? marker.replace("fixture-parent", "wrong-parent") : marker}`;
          scenario.markerSuffix = appended;
          return {
            decision: "allow",
            annotated: [{ id: call.id, name: call.name, field: "note", appended, delegationBinding }],
            toolCalls: [{ ...call, arguments: {
              ...args, note: args.note + appended,
              ...(scenario.policy === "invalid-marker-mutation" ? { extra: "not approved" } : {}),
            } }],
          };
        }
        default:
          return { decision: "allow", toolCalls };
      }
    },
  });
  // Register the rewriter after the finalizer. The policy phase order, not
  // registration order, must still put rewriting first.
  const unregisterRewriter = registerLlmProxyPlugin({
    id: "riir-rewriter",
    buffersModelResponse: () => scenario?.policy === "replace",
    async onBufferedModelResponse({ responseText }) {
      assert.equal(responseText, "Héllo");
      return { decision: "replace", responseText: replacementText };
    },
    async onToolCalls({ toolCalls }) {
      scenario.policyOrder.push("rewrite");
      return { decision: "allow", toolCalls };
    },
  });
  try {
    cacheManager.start();
    await cacheManager.set(`${CacheKey.McpGatewayRateLimit}-riir-openai`, true);
    // Capture the database connection for each write, not just its final state.
    await db.execute(sql`
      CREATE TABLE riir_settlement_writes (interaction_id uuid, relation text, writer text, operation text);
      CREATE FUNCTION riir_capture_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO riir_settlement_writes
        VALUES (
          COALESCE(to_jsonb(NEW)->>'interaction_id', to_jsonb(NEW)->>'id')::uuid,
          TG_TABLE_NAME, current_setting('application_name'), TG_OP
        );
        RETURN NEW;
      END $$;
      CREATE TRIGGER riir_interaction_writer AFTER INSERT ON interactions
        FOR EACH ROW EXECUTE FUNCTION riir_capture_settlement();
      CREATE TRIGGER riir_failover_writer AFTER UPDATE OF attempt_outcome ON interactions
        FOR EACH ROW EXECUTE FUNCTION riir_capture_settlement();
      CREATE TRIGGER riir_session_link_writer AFTER UPDATE OF session_id ON interactions
        FOR EACH ROW EXECUTE FUNCTION riir_capture_settlement();
      CREATE TRIGGER riir_receipt_writer AFTER INSERT ON interaction_billing
        FOR EACH ROW EXECUTE FUNCTION riir_capture_settlement();
      CREATE TABLE riir_agent_use_writes (agent_id uuid, writer text);
      CREATE FUNCTION riir_capture_agent_use() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO riir_agent_use_writes VALUES (NEW.id, current_setting('application_name'));
        RETURN NEW;
      END $$;
      CREATE TRIGGER riir_agent_use_writer AFTER UPDATE OF last_used_at ON agents
        FOR EACH ROW EXECUTE FUNCTION riir_capture_agent_use();
      CREATE TABLE riir_legacy_usage_writes (limit_id uuid, model text, writer text);
      CREATE FUNCTION riir_capture_legacy_usage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO riir_legacy_usage_writes VALUES (NEW.limit_id, NEW.model, current_setting('application_name'));
        RETURN NEW;
      END $$;
      CREATE TRIGGER riir_legacy_usage_writer AFTER INSERT OR UPDATE ON limit_model_usage
        FOR EACH ROW EXECUTE FUNCTION riir_capture_legacy_usage();
      CREATE TABLE riir_minute_writes (cache_key text, writer text);
      CREATE FUNCTION riir_capture_minute() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO riir_minute_writes VALUES (NEW.key, current_setting('application_name'));
        RETURN NEW;
      END $$;
      CREATE TRIGGER riir_minute_writer AFTER UPDATE ON keyv_cache
        FOR EACH ROW WHEN (
          NEW.key LIKE 'keyv:llm-throughput-counter-%'
          AND (NEW.value::jsonb #>> '{value,count}')::numeric > 0
        ) EXECUTE FUNCTION riir_capture_minute();
      CREATE TRIGGER riir_refund_writer AFTER UPDATE ON keyv_cache
        FOR EACH ROW WHEN (
          NEW.key LIKE 'keyv:llm-throughput-counter-%'
          AND (NEW.value::jsonb #>> '{value,count}')::numeric <
              (OLD.value::jsonb #>> '{value,count}')::numeric
        ) EXECUTE FUNCTION riir_capture_minute();
      CREATE TABLE riir_admissions (receipt jsonb, writer text);
      CREATE FUNCTION riir_capture_admission() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO riir_admissions VALUES (NEW.value::jsonb->'value', current_setting('application_name'));
        RETURN NEW;
      END $$;
      CREATE TRIGGER riir_admission_writer AFTER INSERT ON keyv_cache
        FOR EACH ROW WHEN (
          NEW.key LIKE 'keyv:llm-throughput-receipt-actual-v1-%' AND NEW.key NOT LIKE '%:spend'
        ) EXECUTE FUNCTION riir_capture_admission();
    `);
    for (let retries = 0; retries < 40 && !(await stat(socket).catch(() => null)); retries++) {
      assert.equal(child.exitCode, null);
      await delay(50);
    }
    assert.ok((await stat(socket)).isSocket());
    const policySocket = join(scratch, "policy.sock");
    policyRelay = createServer((request, response) => {
      const hold = request.url === heldReply?.path ? heldReply : undefined;
      if (request.url === terminalPath) scenario.terminalRequests++;
      if (request.url === receiptPath) scenario.receiptRequests++;
      if (request.url === policyPath) {
        scenario.policyRequests++;
        if (scenario.rejectPolicySse) {
          request.resume();
          response.writeHead(503).end();
          return;
        }
      }
      const forwarded = requestHttp({
        socketPath: socket, path: request.url, method: request.method, headers: request.headers,
      }, (upstream) => {
        if (hold) {
          upstream.resume();
          upstream.once("end", () => hold.received.resolve());
          return;
        }
        response.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(response);
      });
      response.once("close", () => {
        forwarded.destroy();
        hold?.closed.resolve();
      });
      forwarded.on("error", () => response.destroy());
      request.pipe(forwarded);
    });
    policyRelay.listen(policySocket);
    await once(policyRelay, "listening");
    config.llm.openai.baseUrl = upstreamUrl;
    config.database.rustAuditLogSocket = socket;
    const org = randomUUID();
    const user = randomUUID();
    await db.insert(schema.organizationsTable).values({ id: org, name: org, slug: org, createdAt: new Date() });
    await db.insert(schema.usersTable).values({ id: user, email: `${user}@example.invalid`, name: "Fixture user" });
    await db.insert(schema.membersTable).values({ id: randomUUID(), organizationId: org, userId: user, role: "admin", createdAt: new Date() });
    const model = await ModelModel.create({
      externalId: `openai/${frames.model}`,
      provider: "openai",
      modelId: frames.model,
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "2",
    });
    await withDbTransaction((tx) =>
      ResourcePermissionPolicyModel.createInitial({
        tx,
        organizationId: org,
        resource: "llmModel",
        scope: model.id,
        authorId: user,
        publishToOrganization: true,
      }),
    );
    const token = await makePassthroughCredential({ organizationId: org, ownerId: user });
    app.addHook("onRoute", (route) => {
      if (route.method !== "POST" || !route.url.endsWith("/:agentId/chat/completions")) return;
      const handler = route.handler;
      route.handler = async function (request, reply) {
        const current = scenario;
        if (current.clientClosed)
          reply.raw.once("close", current.clientClosed.resolve);
        try {
          return await handler.call(this, request, reply);
        } finally {
          current.handled.resolve();
        }
      };
    });
    await app.register(openaiProxyRoutes);
    config.llmProxy.modelPoolsEnabled = true;
    await app.register(modelRouterProxyRoutes);
    await app.register(healthRoutes);
    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    assert.equal((await app.inject({ url: "/ready" })).statusCode, 200);
    config.database.rustAuditLogSocket = join(scratch, "unavailable.sock");
    assert.equal((await app.inject({ url: "/ready" })).statusCode, 503);
    config.database.rustAuditLogSocket = socket;
    const spendCounter = (id) => `keyv:llm-throughput-counter-${id}`;
    const tokenCounter = (id) => `keyv:llm-throughput-counter-actual-tokens-v1-${id}`;
    const readCounter = async (key) => {
      const [entry] = await CacheEntryModel.getMany([key]);
      return JSON.parse(entry.value).value.count;
    };
    const readSpend = (id) => readCounter(spendCounter(id));
    const admissionsFor = async (id) => (await db.execute(sql`
      SELECT receipt, writer FROM riir_admissions
      WHERE receipt->'limits' @> ${JSON.stringify([{ id }])}::jsonb
    `)).rows;
    const refundUnsent = (reservation) => callRustApi({
      socketPath: socket, path: "/internal/v1/interactions/refund-unsent",
      json: JSON.stringify({ receiptId: reservation.id, limitIds: reservation.limits.map(({ id }) => id) }),
    });
    const assertCancellationRefund = async (request, rule, native) => {
      scenario = { mode: "headers", requests: [], handled: Promise.withResolvers(),
        clientClosed: Promise.withResolvers(), received: Promise.withResolvers(), closed: Promise.withResolvers() };
      const controller = new AbortController();
      await withDbTransaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cache-entry:llm-throughput:${rule.id}`}, 0))`);
        const response = request(AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]));
        response.catch(() => {});
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          const { rows: [row] } = await tx.execute(sql`SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
              AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
          ) AS blocked`);
          blocked = row.blocked;
          if (!blocked) await delay(30);
        }
        controller.abort();
        await assert.rejects(response, { name: "AbortError" });
        assert.ok(blocked, "Proxy did not reach quota admission");
        await Promise.race([scenario.clientClosed.promise, delay(2_000).then(() => assert.fail("Downstream socket did not close"))]);
      });
      await Promise.race([scenario.handled.promise, delay(5_000).then(() => assert.fail("Proxy did not finish quota refund"))]);
      assert.deepEqual(scenario.requests, []);
      assert.equal(await readSpend(rule.id), 0);
      const { rows } = await db.execute(sql`SELECT writer FROM riir_minute_writes WHERE cache_key = ${spendCounter(rule.id)}`);
      assert.deepEqual(rows.map(({ writer }) => writer === "riir-native-openai"), [native]);
      assert.deepEqual((await admissionsFor(rule.id)).map(({ writer }) => writer === "riir-native-openai"), [native]);
    };

    for (const native of [false, true]) {
      config.llmProxy.rustOpenAiStreamEnabled = native;
      const agent = await AgentModel.create({
        name: `Unsent cancellation ${native}`, organizationId: org, agentType: "agent",
      }, user, { publishToOrganization: true, skipCreationDefaultTools: true });
      const [rule] = await db.insert(schema.limitsTable).values({
        entityType: "agent", entityId: agent.id, limitType: "requests", limitValue: 1, cleanupInterval: "1h",
      }).returning();
      const request = (signal) => fetch(`${baseUrl}/v1/openai/${agent.id}/chat/completions`, {
        method: "POST", headers: { authorization: "Bearer synthetic-key", "x-archestra-virtual-key": token, "content-type": "application/json" },
        body: JSON.stringify({ model: frames.model, stream: true, messages: [{ role: "user", content: "Do not send." }] }),
        signal,
      });
      await assertCancellationRefund(request, rule, native);

      const scope = { entities: [{ entityType: "agent", entityId: agent.id }], model: frames.model };
      const concurrent = await Promise.all([
        LlmThroughputModel.admit(scope, native),
        LlmThroughputModel.admit(scope, false),
        LlmThroughputModel.admit(scope, native),
      ]);
      assert.equal(concurrent.filter(({ reservation }) => reservation).length, 1);
      assert.deepEqual(concurrent.filter(({ denied }) => denied).map(({ denied }) => denied.limitType),
        ["requests", "requests"]);
      const denied = await request(AbortSignal.timeout(8_000));
      assert.equal(denied.status, 429, await denied.text());
      assert.ok(Number(denied.headers.get("retry-after")) > 0);
      assert.deepEqual(scenario.requests, []);
      assert.equal(await readSpend(rule.id), 1);
      assert.equal((await admissionsFor(rule.id)).length, 2);
    }

    const refundEntity = { entityType: "agent", entityId: randomUUID() };
    const [refundRule, moneyRule] = await db.insert(schema.limitsTable).values([
      { ...refundEntity, limitType: "requests", limitValue: 100, cleanupInterval: "1h" },
      { ...refundEntity, limitType: "token_cost", limitValue: 100, cleanupInterval: "minute" },
    ]).returning();
    const admitRefund = () => LlmThroughputModel.admit({ entities: [refundEntity], model: frames.model });
    const { reservation: unsent } = await admitRefund();
    assert.ok((await admitRefund()).reservation); // A separate request must keep its allowance.
    await Promise.all([refundUnsent(unsent), refundUnsent(unsent)]);
    assert.equal(await readSpend(refundRule.id), 1);
    const receiptKey = `keyv:llm-throughput-receipt-actual-v1-${unsent.id}`;
    assert.deepEqual(await CacheEntryModel.getMany([receiptKey, `${receiptKey}:spend`]), []);
    assert.equal(await readSpend(moneyRule.id), 0);

    const assertTokens = async ({ id }, expected, native) => {
      assert.equal(await readCounter(tokenCounter(id)), expected);
      const { rows } = await db.execute(sql`
        SELECT writer FROM riir_minute_writes WHERE cache_key = ${tokenCounter(id)}
      `);
      assert.deepEqual(rows.map(({ writer }) => writer === "riir-native-openai"), expected > 0 ? [native] : []);
    };
    const settleMinute = (reservation, billingMode, spend) => callRustApi({
      socketPath: socket, path: "/internal/v1/interactions/settle-minute-spend",
      json: JSON.stringify({
        receiptId: reservation.id, limitIds: reservation.limits.map(({ id }) => id), spend, billingMode,
      }),
    });
    for (const [billingMode, cancelled] of [
      ["metered", false], ["subscription", false], ["metered", true],
    ]) {
      const counts = [];
      for (const native of [false, true]) {
        const entity = { entityType: "agent", entityId: randomUUID() };
        const [rule] = await db.insert(schema.limitsTable).values({
          ...entity, limitType: "token_cost", limitValue: 100, cleanupInterval: "minute",
        }).returning();
        const { reservation } = await LlmThroughputModel.admit({
          entities: [entity], model: frames.model, subscription: billingMode === "subscription",
        });
        assert.ok(reservation);
        if (cancelled) {
          await LlmThroughputModel.reconcile({ reservation, tokens: 0, cancelBeforeSend: true });
        }
        const finish = (mode, spend) => native
          ? settleMinute(reservation, mode, spend)
          : LlmThroughputModel.reconcile({ reservation, tokens: 0, billingMode: mode, spend });
        await Promise.all([finish(billingMode, 2.75), finish(billingMode, 2.75)]);
        // A subscription receipt must be consumed, not left chargeable.
        await finish("metered", 99);
        counts.push(await readSpend(rule.id));
      }
      const expected = !cancelled && billingMode === "metered" ? 2.75 : 0;
      assert.deepEqual(counts, [expected, expected], `${billingMode}, cancelled=${cancelled}`);
    }

    async function run(native, mode, policy = "allow", { cancelAt, nativeEnabled = native, includeUsage = true, rejectPolicySse = false } = {}) {
      config.llmProxy.rustOpenAiStreamEnabled = nativeEnabled;
      heldReply = cancelAt ? {
        received: Promise.withResolvers(), closed: Promise.withResolvers(),
        path: cancelAt === "terminal" ? terminalPath : cancelAt === "policy" ? policyPath : policy === "marker"
          ? "/internal/v1/openai/delegation-attachment" : "/internal/v1/openai/runtime-proof-attachment",
      } : undefined;
      config.database.rustAuditLogSocket = native ? policySocket : socket;
      const agent = await AgentModel.create({
        name: `Stream fixture ${native} ${mode}`,
        organizationId: org,
        agentType: "agent",
        teams: [], labels: [], knowledgeBaseIds: [], connectorIds: [],
      }, user, { publishToOrganization: true, skipCreationDefaultTools: true });
      const usageState = () => db.select({
        lastUsedAt: schema.agentsTable.lastUsedAt,
        updatedAt: schema.agentsTable.updatedAt,
      }).from(schema.agentsTable).where(eq(schema.agentsTable.id, agent.id));
      const [beforeUse] = await usageState();
      const [limit] = await db.insert(schema.limitsTable).values({
        entityType: "agent", entityId: agent.id, limitType: "token_cost", limitValue: 100,
      }).returning();
      const [minuteLimit] = await db.insert(schema.limitsTable).values({
        entityType: "agent", entityId: agent.id, limitType: "token_cost", limitValue: 100,
        cleanupInterval: "minute",
      }).returning();
      const [tokenLimit] = await db.insert(schema.limitsTable).values({
        entityType: "agent", entityId: agent.id, limitType: "tokens", limitValue: 100, cleanupInterval: "1h",
      }).returning();
      const openingPrompt = "Fixture message";
      const sessionId = mode === "complete" && policy === "allow" ? randomUUID() : undefined;
      const titleRows = sessionId ? await db.insert(schema.interactionsTable).values(
        [openingPrompt, "An unrelated prompt"].map((description) => ({
          profileId: agent.id, userId: user, sessionId: randomUUID(), sessionSource: "claude_metadata",
          type: "anthropic:messages", model: frames.model,
          request: { messages: [{ role: "user",
            content: `You are coming up with a succinct title.\n<description>${description}</description>`,
          }] },
          response: { content: [{ type: "text", text: "<title>Fixture title</title>" }] },
        }))).returning() : [];
      scenario = {
        requests: [],
        terminalRequests: 0,
        policyRequests: 0,
        rejectPolicySse,
        closed: Promise.withResolvers(),
        received: Promise.withResolvers(),
        handled: Promise.withResolvers(),
        release: Promise.withResolvers(),
        mode,
        policy,
        policyCalls: [],
        policyOrder: [],
      };
      const controller = new AbortController();
      const pending = fetch(`${baseUrl}/v1/openai/${agent.id}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-key",
          "x-archestra-virtual-key": token,
          "content-type": "application/json",
          ...(sessionId && { "x-claude-code-session-id": sessionId }),
        },
        body: JSON.stringify({
          model: frames.model,
          stream: true,
          stream_options: { include_usage: includeUsage },
          messages: [{ role: "user", content: openingPrompt }],
          tools: [{ type: "function", function: {
            name: "lookup_note", parameters: { type: "object" },
          } }],
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
      });
      const failed = ["http-error", "first-event-error", "relay-error"].includes(mode);
      let events, failure;
      if (mode === "headers") {
        await Promise.race([scenario.received.promise, pending.then(() => assert.fail("unexpected headers"))]);
        controller.abort();
        await assert.rejects(pending, { name: "AbortError" });
      } else if (failed) {
        const response = await pending;
        if (mode === "first-event-error" && response.ok) {
          const data = (await response.text()).split(/\r?\n/)
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)));
          assert.equal(data.length, 1);
          assert.ok(data[0].error);
          failure = { status: response.status, body: data };
        } else {
          assert.equal(response.status, { "http-error": 503, "first-event-error": 500, "relay-error": 502 }[mode]);
          const body = await response.json();
          assert.ok(body.error);
          failure = { status: response.status, body };
        }
      } else if (policy === "replace") {
        await scenario.received.promise;
        scenario.release.resolve();
        const response = await pending;
        assert.equal(response.status, 200);
        const data = (await response.text()).split("\n").filter((line) => line.startsWith("data: "));
        assert.equal(data.pop(), "data: [DONE]");
        events = data.map((line) => {
          const { created, ...event } = JSON.parse(line.slice(6));
          assert.ok(Number.isInteger(created));
          return event;
        });
        assert.equal(events.length, 3);
        assert.deepEqual(events[0].choices, [{
          index: 0, delta: { role: "assistant", content: replacementText }, finish_reason: null,
        }]);
        assert.deepEqual(events[1].choices, [{ index: 0, delta: {}, finish_reason: "stop" }]);
      } else if (mode === "empty") {
        const response = await pending;
        assert.equal(response.status, 200);
        const data = (await response.text()).split(/\r?\n/).filter((line) => line.startsWith("data: "));
        assert.equal(data.length, 2);
        assert.equal(data[1], "data: [DONE]");
        const { created, ...finish } = JSON.parse(data[0].slice(6));
        assert.ok(Number.isInteger(created));
        assert.deepEqual(finish, { id: "", object: frames.object, model: "",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        events = [finish, "[DONE]"];
      } else {
        const response = await pending;
        assert.equal(response.status, 200, response.ok ? undefined : await response.text());
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let partial = "";
        while (!partial.includes("\n\n")) {
          const { value, done } = await reader.read();
          assert.equal(done, false);
          partial += decoder.decode(value, { stream: true });
        }
        const first = JSON.parse(partial.split("\n\n")[0].slice(6));
        assert.equal(first.choices[0].delta.content, "Héllo");
        assert.equal(first.choices[0].delta.tool_calls, undefined);
        if (cancelAt) {
          scenario.release.resolve();
          await Promise.race([heldReply.received.promise, delay(3_000).then(() => assert.fail(`native ${cancelAt} did not respond`))]);
          controller.abort();
          await assert.rejects(reader.read(), { name: "AbortError" });
          await Promise.race([heldReply.closed.promise, delay(3_000).then(() => assert.fail(`native ${cancelAt} was not cancelled`))]);
        } else if (mode === "complete") {
          scenario.release.resolve();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            partial += decoder.decode(value, { stream: true });
          }
          events = (partial + decoder.decode())
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data: "))
            .map((line) => (line === "data: [DONE]" ? "[DONE]" : JSON.parse(line.slice(6))));
          assert.ok(events.some((event) => event.choices?.[0]?.delta?.content === "Héllo"));
          const withheld = rejectPolicySse || policy.startsWith("invalid-");
          if (!withheld) {
            assert.equal(events.at(-1), "[DONE]");
            const finish = events.at(includeUsage ? -3 : -2);
            const usage = events.at(-2);
            assert.deepEqual(finish.choices, [{ index: 0, delta: {}, finish_reason: policy === "deny" ? "stop" : "tool_calls" }]);
            assert.deepEqual(usage.usage, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
            if (includeUsage) {
              assert.equal(finish.usage, undefined);
              assert.deepEqual(usage.choices, []);
              assert.equal(usage.created, finish.created);
            }
          }
          const released = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
          if (withheld) {
            assert.deepEqual(released, []);
            assert.ok(events.some((event) => event.error));
            assert.ok(!events.includes("[DONE]"));
          } else if (policy === "deny") {
            assert.deepEqual(released, []);
            assert.equal(events[1]?.choices?.[0]?.delta?.content, "\n\nThe note lookup was declined.");
           } else {
             assert.equal(released.length, ["rewrite", "proof", "marker"].includes(policy) ? 1 : 2);
             if (policy === "allow") assert.deepEqual(released, [
               firstToolDelta,
               { index: 0, function: { arguments: '"café"}' } },
             ]);
            assert.equal(released[0]?.id, policy === "rewrite" ? "call_approved" : "call_fixture");
            assert.equal(released[0]?.function.name, "lookup_note");
            const { runtime_proof, ...args } = JSON.parse(released.map((item) => item.function.arguments).join(""));
            assert.equal(typeof runtime_proof, policy === "proof" ? "string" : "undefined");
            assert.deepEqual(args, { note: policy === "rewrite" ? "public excerpt" : `café${policy === "marker" ? scenario.markerSuffix : ""}` });
            if (policy === "marker") released[0].function.arguments = JSON.stringify({ note: "café" });
          }
          // Generated chunks use wall-clock time, unlike the fixed upstream fixture.
          assert.equal(events[0].created, frames.created);
          events = events.map((event, index) => {
            if (index === 0 || event === "[DONE]") return event;
            if (event.error) return { error: true };
            const { created, ...generated } = event;
            assert.ok(Number.isInteger(created));
            return generated;
          });
        } else {
          controller.abort();
          await assert.rejects(reader.read(), { name: "AbortError" });
        }
      }
      await Promise.race([scenario.closed.promise, delay(2_000).then(() => assert.fail("upstream socket did not close"))]);
      await Promise.race([scenario.handled.promise, delay(5_000).then(() => assert.fail("proxy handler did not finish"))]);
      assert.equal(scenario.requests.length, 1);
      assert.equal(scenario.policyRequests,
        native && mode === "complete" && !policy.startsWith("invalid-") &&
        policy !== "allow" && cancelAt !== "attachment" ? 1 : 0);
      assert.equal(scenario.terminalRequests,
        native && !rejectPolicySse && (mode === "empty" || (mode === "complete" &&
        !policy.startsWith("invalid-") && cancelAt !== "attachment" && cancelAt !== "policy")) ? 1 : 0);
      const [sent] = scenario.requests;
      assert.equal(sent.path, "/v1/chat/completions");
      assert.equal(sent.authorization, "Bearer synthetic-key");
      assert.equal(sent.body.stream_options.include_usage, true);
      if (native) assert.equal(sent.encoding, "identity", "request did not go through Rust");
      assert.deepEqual(scenario.policyCalls, mode === "complete"
        ? [[{ id: "call_fixture", name: "lookup_note", args: { note: "café" } }]]
        : []);
      assert.deepEqual(scenario.policyOrder, mode === "complete" ? ["rewrite", "prepare", "finalize"] : []);
      const rows = await db.select({
        id: schema.interactionsTable.id,
        createdAt: schema.interactionsTable.createdAt,
        model: schema.interactionsTable.model,
        sessionId: schema.interactionsTable.sessionId,
        sessionSource: schema.interactionsTable.sessionSource,
        inputTokens: schema.interactionsTable.inputTokens,
        outputTokens: schema.interactionsTable.outputTokens,
        cost: schema.interactionsTable.cost,
        response: schema.interactionsTable.response,
      }).from(schema.interactionsTable).where(eq(schema.interactionsTable.profileId, agent.id));
      const fixtureIds = new Set(titleRows.map(({ id }) => id));
      const mainRows = rows.filter(({ id }) => !fixtureIds.has(id));
      assert.equal(mainRows.length, 1, `interaction count for ${native ? "Rust" : "TS"} ${mode}`);
      const [{ id, model, inputTokens, outputTokens, cost, response, sessionSource }] = mainRows;
      const usageWriters = async () => (await db.execute(sql`
        SELECT writer FROM riir_agent_use_writes WHERE agent_id = ${agent.id}
      `)).rows.map(({ writer }) => writer === "riir-native-openai");
      await drainBackgroundWork();
      const expectedUse = [{ ...beforeUse, lastUsedAt: mainRows[0].createdAt }];
      assert.deepEqual(await usageState(), expectedUse);
      assert.deepEqual(await usageWriters(), [native]);
      assert.equal(model, frames.model);
      assert.deepEqual([inputTokens, outputTokens], mode === "complete" ? [12, 4] : [null, null]);
      if (mode === "headers" || failed) {
        assert.equal(cost, null);
        assert.ok(response?.error);
      }
      const receipts = await InteractionBillingModel.findMany([id]);
      assert.equal(receipts.length, mode === "complete" ? 1 : 0);
      if (sessionId) {
        assert.deepEqual([mainRows[0].sessionId, sessionSource], [sessionId, "claude_code_header"]);
        const [title, unrelated] = titleRows;
        const linked = rows.find(({ id }) => id === title.id);
        const untouched = rows.find(({ id }) => id === unrelated.id);
        assert.deepEqual([linked.sessionId, linked.sessionSource], [sessionId, sessionSource]);
        assert.deepEqual([untouched.sessionId, untouched.sessionSource], [unrelated.sessionId, unrelated.sessionSource]);
        const heads = schema.interactionSessionHeadsTable;
        const head = (key) => db.select({ id: heads.lastInteractionId }).from(heads).where(eq(heads.sessionKey, key));
        assert.deepEqual(await head(title.sessionId), []);
        assert.deepEqual(await head(sessionId), [{ id }]);
        assert.deepEqual(await head(unrelated.sessionId), [{ id: unrelated.id }]);
        if (native) {
          await callRustApi({
            socketPath: socket, path: "/internal/v1/interactions/link-session-titles",
            json: JSON.stringify({ mainInteractionId: id, titles: [{ id: title.id, sessionId: title.sessionId }] }),
          });
        }
        const { rows: updates } = await db.execute(sql`
          SELECT writer FROM riir_settlement_writes WHERE interaction_id = ${title.id} AND operation = 'UPDATE'
        `);
        assert.deepEqual(updates.map(({ writer }) => writer === "riir-native-openai"), [native]);
        assert.deepEqual(await InteractionBillingModel.findMany([title.id, unrelated.id]), []);
      }
      const { rows: writes } = await db.execute(sql`
        SELECT relation, writer FROM riir_settlement_writes WHERE interaction_id = ${id}
        ORDER BY relation
      `);
      assert.deepEqual(writes.map(({ relation }) => relation),
        mode === "complete" ? ["interaction_billing", "interactions"] : ["interactions"]);
      for (const { writer } of writes) {
        assert.equal(writer === "riir-native-openai", native);
      }
      const limitTotals = () => db.select({
        model: schema.limitBillingUsageTable.model,
        input: schema.limitBillingUsageTable.coveredTokensIn,
        output: schema.limitBillingUsageTable.coveredTokensOut,
        cost: schema.limitBillingUsageTable.cost,
      }).from(schema.limitBillingUsageTable).where(eq(schema.limitBillingUsageTable.limitId, limit.id));
      const totals = await limitTotals();
      assert.equal(await readSpend(minuteLimit.id), mode === "complete" ? 0.00002 : 0);
      await assertTokens(tokenLimit, mode === "complete" ? 16 : 0, native);
      assert.deepEqual((await admissionsFor(tokenLimit.id)).map(({ writer }) => writer === "riir-native-openai"), [native]);
      const { rows: minuteWrites } = await db.execute(sql`
        SELECT writer FROM riir_minute_writes WHERE cache_key = ${spendCounter(minuteLimit.id)}
      `);
      assert.deepEqual(minuteWrites.map(({ writer }) => writer === "riir-native-openai"),
        mode === "complete" ? [native] : []);
      assert.deepEqual(totals, mode === "complete"
        ? [{ model: frames.model, input: 12, output: 4, cost: "0.0000200000" }]
        : []);
      const calls = response?.choices?.[0]?.message?.tool_calls ?? [];
      assert.equal(calls.length, mode === "complete" && !["deny", "replace"].includes(policy) &&
        cancelAt !== "policy" && !rejectPolicySse ? 1 : 0);
      if (cancelAt === "policy" || rejectPolicySse) assert.ok(response.error);
      if (policy === "replace") assert.equal(response.choices[0].message.content, replacementText);
      if (calls.length) {
        const { runtime_proof: _proof, ...args } = JSON.parse(calls[0].function.arguments);
        assert.deepEqual(args, { note: policy === "rewrite" ? "public excerpt" : `café${policy === "marker" && cancelAt !== "attachment" ? scenario.markerSuffix : ""}` });
        if (policy === "marker") calls[0].function.arguments = JSON.stringify({ note: "café" });
      }
      if (native && mode === "complete" && policy === "allow") {
        const { createdAt: _createdAt, ...receipt } = receipts[0];
        const settle = (row, receipt) => callRustApi({
          socketPath: socket, path: "/internal/v1/interactions/settle",
          json: JSON.stringify({ row, receipt }),
        });
        const replays = await Promise.all([settle({ id }, receipt), settle({ id }, receipt)]);
        assert.ok(replays.every((replay) => replay.status === "written" && replay.id === id));
        await Promise.all([mainRows[0].createdAt, new Date(mainRows[0].createdAt.getTime() - 1_000)].map((usedAt) =>
          callRustApi({ socketPath: socket, path: "/internal/v1/interactions/stamp-agent-use",
            json: JSON.stringify({ agentId: agent.id, usedAt }),
          })));
        assert.deepEqual(await usageState(), expectedUse);
        assert.deepEqual(await usageWriters(), [true]);
        await assert.rejects(settle({ id }, { ...receipt, fingerprint: "different" }), /HTTP 409/);
        assert.deepEqual(await limitTotals(), totals);
        assert.equal((await InteractionBillingModel.findMany([id])).length, 1);

        // Fail at the final budget update, after both INSERTs have executed.
        const rejectedId = randomUUID();
        await db.execute(sql`ALTER TABLE limit_billing_usage ADD CONSTRAINT riir_reject_double_cost
          CHECK (cost < 0.0000400000) NOT VALID`);
        try {
          await assert.rejects(settle({
            id: rejectedId, profile_id: agent.id, user_id: user,
            request: "{}", response: "{}", type: "openai:chatCompletions",
          }, { ...receipt, interactionId: rejectedId }), /HTTP 500/);
          assert.equal((await InteractionBillingModel.findMany([rejectedId])).length, 0);
          const { rows: rolledBack } = await db.execute(sql`
            SELECT interaction_id FROM riir_settlement_writes WHERE interaction_id = ${rejectedId}`);
          assert.deepEqual(rolledBack, []);
          assert.deepEqual(await limitTotals(), totals);
        } finally {
          await db.execute(sql`ALTER TABLE limit_billing_usage DROP CONSTRAINT riir_reject_double_cost`);
        }
      }
      return { events, failure, inputTokens, outputTokens, calls, usage: receipts[0]?.usage,
        loggedFailure: mode === "headers" || failed ? response : undefined };
    }
    for (const mode of ["complete", "empty", "stream", "headers", "http-error", "first-event-error"]) {
      const legacy = await run(false, mode);
      const rust = await run(true, mode);
      assert.deepEqual(rust, legacy);
    }
    for (const policy of ["rewrite", "deny", "replace", "proof", "invalid-proof", "invalid-proof-mutation", "marker", "invalid-marker", "invalid-marker-mutation"]) {
      const legacy = await run(false, "complete", policy);
      const rust = await run(true, "complete", policy);
      assert.deepEqual(rust, legacy);
    }
    const inlineUsage = { includeUsage: false };
    assert.deepEqual(await run(true, "complete", "rewrite", inlineUsage),
      await run(false, "complete", "rewrite", inlineUsage));
    await run(true, "complete", "proof", { cancelAt: "attachment" });
    await run(true, "complete", "marker", { cancelAt: "attachment" });
    await run(true, "complete", "rewrite", { cancelAt: "terminal" });
    await run(true, "complete", "rewrite", { cancelAt: "policy" });
    await run(true, "complete", "rewrite", { rejectPolicySse: true });
    await run(true, "relay-error");
    // A TLS customization leaves the transport in Node even when Rust is enabled.
    const previousCa = process.env.NODE_EXTRA_CA_CERTS;
    process.env.NODE_EXTRA_CA_CERTS = join(scratch, "custom-ca.pem");
    try {
      await run(false, "headers", "allow", { nativeEnabled: true });
      const legacy = await run(false, "http-error");
      assert.deepEqual(await run(false, "http-error", "allow", { nativeEnabled: true }), legacy);
    } finally {
      if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = previousCa;
    }

    async function runReceipt(native, cancel = false) {
      config.llmProxy.rustOpenAiStreamEnabled = native;
      config.database.rustAuditLogSocket = native ? policySocket : socket;
      heldReply = native && cancel ? {
        path: receiptPath, received: Promise.withResolvers(), closed: Promise.withResolvers(),
      } : undefined;
      const agent = await AgentModel.create({
        name: `Receipt fixture ${native} ${cancel}`, organizationId: org, agentType: "agent",
      }, user, { publishToOrganization: true, skipCreationDefaultTools: true });
      const session = `ses_${randomUUID().replaceAll("-", "")}`;
      const sessionTable = schema.openappaSessionsTable;
      const callerId = `user:${user}`;
      const sessionId = scopedSessionId(callerId, session);
      const actor = openappaActor(sessionId);
      await db.insert(sessionTable).values({
        actor, root: actor, organizationId: org, callerId, sessionId, startDecision: { decision: "ack" },
      });
      scenario = {
        mode: "complete", policy: "allow", requests: [], policyCalls: [], policyOrder: [],
        receiptRequests: 0, terminalRequests: 0, policyRequests: 0,
        received: Promise.withResolvers(), closed: Promise.withResolvers(),
        handled: Promise.withResolvers(), release: Promise.withResolvers(),
      };
      const controller = new AbortController();
      const pending = fetch(`${baseUrl}/v1/openai/${agent.id}/chat/completions`, {
        method: "POST", headers: {
          authorization: "Bearer synthetic-key", "x-archestra-virtual-key": token,
          "content-type": "application/json", "user-agent": "opencode/1.18.29", "x-session-id": session,
        }, body: JSON.stringify({
          model: frames.model, stream: true, messages: [{ role: "user", content: "Read the note." }],
          tools: [{ type: "function", function: { name: "lookup_note", parameters: { type: "object" } } }],
        }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
      });
      let events, code;
      if (native && cancel) {
        await Promise.race([heldReply.received.promise, pending.then(() => assert.fail("receipt was not held"))]);
        controller.abort();
        await assert.rejects(pending, { name: "AbortError" });
        await heldReply.closed.promise;
      } else {
        const response = await pending;
        assert.equal(response.status, 200, response.ok ? undefined : await response.text());
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let body = "";
        while (body.split("\n\n").length < 3) {
          const { value, done } = await reader.read();
          assert.equal(done, false);
          body += decoder.decode(value, { stream: true });
        }
        if (cancel) {
          controller.abort();
          await assert.rejects(reader.read(), { name: "AbortError" });
        } else {
          scenario.release.resolve();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            body += decoder.decode(value, { stream: true });
          }
        }
        const data = body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
        if (!cancel) assert.equal(data.pop(), "[DONE]");
        events = data.map(JSON.parse);
        const first = events[0].choices[0];
        const receipt = stripSessionReceipts(first.delta.content);
        assert.equal(receipt.codes.length, 1);
        assert.equal(receipt.text, "");
        [code] = receipt.codes;
        first.delta.content = "receipt";
        assert.deepEqual(events[1].choices[0], {
          index: 0, delta: { role: "assistant", content: "\n\nHéllo" }, finish_reason: null,
        });
        events = events.map(({ created: _created, ...event }) => event);
      }
      await Promise.all([scenario.closed.promise, scenario.handled.promise]);
      await drainBackgroundWork();
      assert.equal(scenario.requests.length, 1);
      assert.equal(scenario.receiptRequests, native ? 1 : 0);
      const [stored] = await db.select().from(sessionTable)
        .where(eq(sessionTable.sessionId, sessionId));
      assert.ok(stored.receiptToken);
      assert.equal(!!stored.receiptIssuedAt, !(native && cancel));
      if (code) assert.equal(code, stored.receiptToken);
      const rows = await db.select().from(schema.interactionsTable).where(eq(schema.interactionsTable.profileId, agent.id));
      assert.equal(rows.length, 1);
      const [{ id, inputTokens, outputTokens, cost }] = rows;
      const receipts = await InteractionBillingModel.findMany([id]);
      assert.equal(receipts.length, 1);
      assert.deepEqual([inputTokens, outputTokens], cancel ? [1, 0] : [12, 4]);
      return { events: cancel ? undefined : events, inputTokens, outputTokens, cost, usage: receipts[0].usage };
    }

    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
    try {
      assert.deepEqual(await runReceipt(true), await runReceipt(false));
      assert.deepEqual(await runReceipt(true, true), await runReceipt(false, true));
    } finally {
      await GuardrailsDeploymentModel.setEnabled(false);
      config.openappa.enabled = false;
      config.database.rustAuditLogSocket = socket;
    }
    const cutoffModel = "riir-openai-cutoff";
    await ModelModel.create({
      externalId: `openai/${cutoffModel}`, provider: "openai", modelId: cutoffModel,
      inputModalities: ["text"], outputModalities: ["text"],
      customPricePerMillionInput: "1", customPricePerMillionOutput: "2",
    });
    const createPoolKey = async (apiKey, provider) => {
      const secret = await secretManager().createSecret({ apiKey }, apiKey);
      return LlmProviderApiKeyModel.create({
        organizationId: org, createdBy: user, name: apiKey, provider, baseUrl: upstreamUrl,
        secretId: secret.id, scope: "org",
      }, { publishToOrganization: true, apiKeyValue: apiKey });
    };
    const firstKey = await createPoolKey("fixture-timeout", "openai");
    const nativeFallback = await createPoolKey("fixture-fallback", "openai");
    const mixedFallback = await createPoolKey("fixture-fallback-mixed", "groq");
    await ModelModel.create({
      externalId: `groq/${frames.model}`, provider: "groq", modelId: frames.model,
      inputModalities: ["text"], outputModalities: ["text"],
      customPricePerMillionInput: "1", customPricePerMillionOutput: "2",
    });
    const poolResults = [];
    for (const [native, fallback] of [[false, nativeFallback], [true, nativeFallback], [true, mixedFallback]]) {
      config.llmProxy.rustOpenAiStreamEnabled = native;
      const nativePool = native && fallback.provider === "openai";
      const keys = [firstKey, fallback];
      const pool = await ModelPoolModel.create({ organizationId: org, input: {
        name: `riir-cutoff-pool-${native}-${fallback.provider}`, streamTimeoutSeconds: 1, retrySettings: { numRetries: 0 },
        members: keys.map(({ id }, i) => ({
          providerApiKeyId: id, modelId: [cutoffModel, frames.model][i], priority: i + 1, weight: 1, enabled: true,
        })),
      } });
      const credential = await VirtualApiKeyModel.create({
        organizationId: org, name: pool.name, authorId: user, publishToOrganization: true,
        providerApiKeys: [{ provider: "openai", providerApiKeyId: keys[0].id }],
      });
      await ModelPoolModel.setPoolsForVirtualApiKey({
        organizationId: org, virtualApiKeyId: credential.virtualKey.id, poolIds: [pool.id],
      });
      const agent = await AgentModel.create({
        name: pool.name, organizationId: org, agentType: "agent",
      }, user, { publishToOrganization: true, skipCreationDefaultTools: true });
      const rules = await db.insert(schema.limitsTable).values([cutoffModel, frames.model].map((model) => ({
        entityType: "agent", entityId: agent.id, limitType: "token_cost", limitValue: 100, cleanupInterval: "minute", model: [model],
      }))).returning();
      const [tokenLimit, requestLimit] = await db.insert(schema.limitsTable).values([
        { entityType: "agent", entityId: agent.id, limitType: "tokens_per_minute", limitValue: 100, cleanupInterval: "minute" },
        { entityType: "agent", entityId: agent.id, limitType: "requests", limitValue: 1, cleanupInterval: "1h" },
      ]).returning();
      const [legacyLimit, unmatchedLimit] = await db.insert(schema.limitsTable).values(
        [[cutoffModel], []].map((model) => ({
          entityType: "agent", entityId: agent.id, limitType: "token_cost", limitValue: 100,
          cleanupInterval: "1h", model,
        })),
      ).returning();
      const request = (signal) => fetch(`${baseUrl}/v1/model-router/${agent.id}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${credential.value}`, "content-type": "application/json" },
        body: JSON.stringify({ model: pool.name, stream: true, messages: [{ role: "user", content: "Count this prompt once." }] }),
        signal,
      });
      await assertCancellationRefund(request, requestLimit, nativePool);
      const [cancelled] = await admissionsFor(requestLimit.id);
      assert.deepEqual(await CacheEntryModel.getMany([`keyv:llm-throughput-receipt-actual-v1-${cancelled.receipt.id}`]), []);

      scenario = { mode: "pool-cutoff", requests: [], received: Promise.withResolvers(),
        closed: Promise.withResolvers(), cutoffClosed: Promise.withResolvers(), handled: Promise.withResolvers(),
        releaseFallback: Promise.withResolvers() };
      const calls = [request(AbortSignal.timeout(10_000)), request(AbortSignal.timeout(10_000))];
      const firstReply = await Promise.race(calls);
      assert.equal(firstReply.status, 429, await firstReply.text());
      scenario.releaseFallback.resolve();
      const [reply] = (await Promise.all(calls)).filter(({ status }) => status !== 429);
      const body = await reply.text();
      assert.equal(reply.status, 200, body);
      assert.equal(reply.headers.get("x-archestra-attempts"), "2");
      assert.equal(reply.headers.get("x-archestra-provider-key"), keys[1].id);
      await scenario.handled.promise;
      await Promise.race([scenario.cutoffClosed.promise, delay(2_000).then(() => assert.fail("timed-out upstream was not closed"))]);
      assert.deepEqual(scenario.requests.map(({ authorization, body }) => [authorization, body.model]),
        [["Bearer fixture-timeout", cutoffModel], [`Bearer ${fallback.name}`, frames.model]]);
      assert.deepEqual(scenario.requests.map(({ encoding }) => encoding === "identity"), [native, nativePool]);
      const poolRows = () => db.select().from(schema.interactionsTable).where(and(
        eq(schema.interactionsTable.profileId, agent.id), eq(schema.interactionsTable.modelPoolId, pool.id),
      ))
        .orderBy(schema.interactionsTable.attempt);
      const rows = await poolRows();
      assert.equal(rows.length, 2);
      const [cutoff, answer] = rows;
      assert.deepEqual([cutoff.attemptOutcome, cutoff.inputTokensEstimated, cutoff.outputTokens, cutoff.providerApiKeyId],
        ["failed_over", true, 0, keys[0].id]);
      assert.deepEqual([answer.attemptOutcome, answer.inputTokens, answer.outputTokens, answer.providerApiKeyId],
        ["answered", 12, 4, keys[1].id]);
      assert.ok(cutoff.inputTokens > 0);
      assert.equal(Number(cutoff.cost), cutoff.inputTokens / 1_000_000);
      await drainBackgroundWork();
      const legacyUsage = () => db.select({
        input: schema.limitModelUsageTable.currentUsageTokensIn,
        output: schema.limitModelUsageTable.currentUsageTokensOut,
      }).from(schema.limitModelUsageTable).where(and(
        eq(schema.limitModelUsageTable.limitId, legacyLimit.id),
        eq(schema.limitModelUsageTable.model, cutoffModel),
      ));
      const expectedLegacyUsage = [{ input: cutoff.inputTokens, output: 0 }];
      assert.deepEqual(await legacyUsage(), expectedLegacyUsage);
      if (native) {
        const markFailedOver = (interactionId) => callRustApi({
          socketPath: socket, path: "/internal/v1/interactions/mark-pool-attempt-failed-over",
          json: JSON.stringify({ interactionId }),
        });
        await markFailedOver(cutoff.id);
        await markFailedOver(answer.id);
        // The unreceipted append can return an existing row on replay. It must
        // not schedule the legacy counter again.
        await Promise.all(Array.from({ length: 2 }, () => InteractionModel.record({
          id: cutoff.id, profileId: cutoff.profileId, userId: cutoff.userId,
          type: cutoff.type, model: cutoff.model, billingMode: cutoff.billingMode,
          request: { messages: [] }, response: { error: "cutoff" },
          inputTokens: cutoff.inputTokens, outputTokens: cutoff.outputTokens, inputTokensEstimated: true,
        }, null, { nativeOpenAiSettlement: true })));
        await drainBackgroundWork();
        assert.deepEqual(await poolRows(), rows);
        assert.deepEqual(await legacyUsage(), expectedLegacyUsage);
      }
      const { rows: legacyWrites } = await db.execute(sql`
        SELECT limit_id, writer FROM riir_legacy_usage_writes
        WHERE model = ${cutoffModel} AND limit_id IN (${legacyLimit.id}, ${unmatchedLimit.id})
      `);
      assert.deepEqual(legacyWrites.map(({ limit_id, writer }) => [limit_id, writer === "riir-native-openai"]),
        [[legacyLimit.id, native]]);
      assert.deepEqual(await db.select().from(schema.limitBillingUsageTable)
        .where(eq(schema.limitBillingUsageTable.limitId, legacyLimit.id)), []);
      assert.deepEqual(await Promise.all(rules.map(({ id }) => readSpend(id))), [Number(cutoff.cost), Number(answer.cost)]);
      assert.equal(await readSpend(requestLimit.id), 1);
      await assertTokens(tokenLimit, 16, nativePool);
      assert.deepEqual((await admissionsFor(tokenLimit.id)).map(({ writer }) => writer === "riir-native-openai"),
        [nativePool, nativePool]);
      for (const [i, rule] of rules.entries())
        assert.deepEqual((await admissionsFor(rule.id)).map(({ writer }) => writer === "riir-native-openai"),
          [i === 0 ? native : nativePool]);
      assert.deepEqual(await InteractionBillingModel.findMany([cutoff.id]), []);
      const { rows: interactionWrites } = await db.execute(sql`
        SELECT relation, operation, writer FROM riir_settlement_writes
        WHERE interaction_id = ${cutoff.id} ORDER BY operation
      `);
      assert.deepEqual(interactionWrites.map(({ relation, operation, writer }) =>
        [relation, operation, writer === "riir-native-openai"]),
        [["interactions", "INSERT", native], ["interactions", "UPDATE", native]]);
      const { rows: cutoffCharges } = await db.execute(sql`
        SELECT writer FROM riir_minute_writes WHERE cache_key = ${spendCounter(rules[0].id)}
      `);
      assert.deepEqual(cutoffCharges.map(({ writer }) => writer === "riir-native-openai"), [native]);
      poolResults.push([cutoff.inputTokens, cutoff.cost, cutoff.baselineCost, answer.cost]);
    }
    assert.deepEqual(poolResults[0], poolResults[1]);

    const entity = { entityType: "agent", entityId: randomUUID() };
    const [tokenRule] = await db.insert(schema.limitsTable).values({
      ...entity, limitType: "tokens", limitValue: 100, cleanupInterval: "calendar_day",
    }).returning();
    const { reservation } = await LlmThroughputModel.admit({ entities: [entity], model: frames.model });
    assert.ok(reservation);
    const settleTokens = (limitIds) => callRustApi({
      socketPath: socket, path: "/internal/v1/interactions/reconcile-tokens",
      json: JSON.stringify({ receiptId: reservation.id, limitIds, tokens: 17 }),
    });
    await assert.rejects(settleTokens([]), /HTTP 500/);
    await assertTokens(tokenRule, 0, true);
    await settleTokens([tokenRule.id]);
    await Promise.all([
      settleTokens([tokenRule.id]),
      LlmThroughputModel.reconcile({ reservation, tokens: 17 }),
    ]);
    await assertTokens(tokenRule, 17, true);
  } finally {
    cacheManager.shutdown();
    unregisterRewriter();
    unregisterFinalizer();
    upstream.closeAllConnections();
    upstream.close();
    await app.close();
    if (policyRelay) {
      policyRelay.closeAllConnections();
      await new Promise((done) => policyRelay.close(done));
    }
    child.kill("SIGTERM");
    assert.deepEqual(await childExit, [0, null]);
    await assert.rejects(stat(socket), { code: "ENOENT" });
    await rmdir(scratch);
  }
});
