import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import db, { schema } from "@/database";
import {
  AppaApprovalModel,
  ModelModel,
  UserTokenModel,
  VirtualApiKeyModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM } from "@/types/appa-proxy-wire";
import mcpGatewayRoutes from "../mcp-gateway";
import openAiProxyRoutes from "./routes/openai";

const codexBinary = process.env.APPA_NATIVE_CODEX_BINARY;
const runtimeBinary = process.env.APPA_NATIVE_RUNTIME_BINARY;
const runStockClient =
  process.env.APPA_NATIVE_CODEX_STOCK_E2E === "1" &&
  Boolean(codexBinary && runtimeBinary);

const model = "gpt-5.6-sol";
const realProvider = process.env.APPA_NATIVE_REAL_PROVIDER === "1";
const providerCallId = "call_provider_exec_command_153";
const providerItemId = "fc_provider_exec_command_153";
const providerReasoningItemId = "rs_provider_opaque_153";
const providerReasoningCiphertext = "synthetic-provider-opaque-reasoning-153";
const localExecutionMarker = "APPA_NATIVE_LOCAL_EXEC_MARKER_153";
const providerFinalText = "APPA_NATIVE_PROVIDER_FINAL_153";
const nativeFixtureCatalogName = "native_fixture";
const nativeFixtureToolName = `${nativeFixtureCatalogName}__create_job`;
const nativeFixtureMcpNamespace = "mcp__appa_gateway";
const nativeFixturePolicyToolName = `${nativeFixtureMcpNamespace}__${nativeFixtureToolName}`;
const stockRegistry = [
  "apply_patch",
  "exec_command",
  "view_image",
  "write_stdin",
];

describe.skipIf(!runStockClient)(
  "OpenAPPA native Codex stock-client boundary",
  () => {
    test("boots over SSE, projects direct tools, executes locally, and restores provider IDs", async ({
      makeAgent,
    }) => {
      const root = await mkdtemp(path.join(tmpdir(), "appa-native-codex-"));
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      const policyPath = path.join(root, "appa.toml");
      const runtimeDb = path.join(root, "runtime.sqlite");
      const originalHook = config.llmProxy.appaHook;
      const originalOpenAiBaseUrl = config.llm.openai.baseUrl;
      let proxy: FastifyInstance | undefined;
      let upstream: FastifyInstance | undefined;
      let runtime: ReturnType<typeof spawn> | undefined;
      let runtimeStderr = "";

      try {
        await Promise.all([
          mkdir(home, { recursive: true }),
          mkdir(workspace, { recursive: true }),
          writeFile(policyPath, runtimePolicy(), "utf8"),
        ]);
        const runtimePort = await reserveLoopbackPort();
        const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
        runtime = spawn(
          requiredEnv(runtimeBinary, "APPA_NATIVE_RUNTIME_BINARY"),
          [
            "runtime",
            "--adapter",
            "kagent",
            "--config",
            policyPath,
            "--db",
            runtimeDb,
            "--listen",
            `127.0.0.1:${runtimePort}`,
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              PATH: process.env.PATH,
              HOME: home,
              TMPDIR: root,
              APPA_PROXY_TOKEN: "synthetic-native-runtime-token-0123456789",
              APPA_PROXY_APPROVAL_SECRET:
                "synthetic-native-approval-key-0123456789abcdef",
            },
          },
        );
        runtime.stderr?.on("data", (chunk: Buffer) => {
          runtimeStderr += chunk.toString("utf8");
        });
        await waitForRuntime(runtimeUrl, runtime, () => runtimeStderr);

        const upstreamRequests: Array<Record<string, unknown>> = [];
        upstream = Fastify();
        upstream.post("/responses", async (request, reply) => {
          upstreamRequests.push(
            structuredClone(request.body) as Record<string, unknown>,
          );
          if (realProvider) {
            const base = originalOpenAiBaseUrl || "https://api.openai.com/v1";
            const response = await fetch(
              `${base.replace(/\/$/, "")}/responses`,
              {
                method: "POST",
                headers: {
                  authorization: request.headers.authorization || "",
                  "content-type": "application/json",
                },
                body: JSON.stringify(request.body),
                signal: AbortSignal.timeout(120_000),
              },
            );
            reply
              .code(response.status)
              .type(response.headers.get("content-type") || "application/json");
            if (!response.body) return reply.send();
            return reply.send(Readable.fromWeb(response.body as never));
          }
          reply.type("text/event-stream");
          if (upstreamRequests.length === 1) {
            return responseSse([
              responseCreated("resp-provider-exec"),
              {
                type: "response.output_item.done",
                item: {
                  id: providerReasoningItemId,
                  type: "reasoning",
                  summary: [],
                  encrypted_content: providerReasoningCiphertext,
                },
              },
              {
                type: "response.output_item.done",
                item: {
                  id: providerItemId,
                  type: "function_call",
                  namespace: "functions",
                  name: "exec_command",
                  call_id: providerCallId,
                  arguments: JSON.stringify({
                    cmd: `printf '${localExecutionMarker}\\n'`,
                    yield_time_ms: 1000,
                    max_output_tokens: 32,
                    login: false,
                  }),
                },
              },
              responseCompleted("resp-provider-exec"),
            ]);
          }
          if (upstreamRequests.length === 2) {
            return responseSse([
              responseCreated("resp-provider-final"),
              {
                type: "response.output_item.done",
                item: {
                  id: "msg-provider-final",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: providerFinalText }],
                },
              },
              responseCompleted("resp-provider-final"),
            ]);
          }
          return reply.code(429).send({ error: "unexpected provider request" });
        });
        const upstreamUrl = await upstream.listen({
          port: 0,
          host: "127.0.0.1",
        });

        config.llm.openai.baseUrl = upstreamUrl;
        config.llmProxy.appaHook = {
          url: runtimeUrl,
          timeoutMs: 10_000,
          sessionHmacSecret:
            "appa-native-stock-session-hmac-secret-0123456789abcdef",
          nativeCodexEnabled: true,
          runtimeToken: "synthetic-native-runtime-token-0123456789",
          approvalSigningSecret:
            "synthetic-native-approval-key-0123456789abcdef",
          autoAcceptRestrictions: true,
        };
        await ModelModel.upsert({
          externalId: `openai/${model}`,
          provider: "openai",
          modelId: model,
          inputModalities: null,
          outputModalities: null,
          customPricePerMillionInput: "2.50",
          customPricePerMillionOutput: "10.00",
          lastSyncedAt: new Date(),
        });

        const agent = await makeAgent({ name: "APPA native stock Codex" });
        const proxyRequests: Array<Record<string, unknown>> = [];
        const upstreamCountsAtBootstrap: number[] = [];
        proxy = createProxyApp();
        proxy.addHook("preHandler", async (request) => {
          if (
            request.method === "POST" &&
            request.url === `/v1/openai/${agent.id}/responses`
          ) {
            proxyRequests.push(
              structuredClone(request.body) as Record<string, unknown>,
            );
          }
        });
        proxy.addHook("onSend", async (request, _reply, payload) => {
          if (
            request.method === "POST" &&
            request.url === `/v1/openai/${agent.id}/responses` &&
            payloadToText(payload).includes(
              APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM,
            )
          ) {
            upstreamCountsAtBootstrap.push(upstreamRequests.length);
          }
        });
        await proxy.register(openAiProxyRoutes);
        const proxyUrl = await proxy.listen({ port: 0, host: "127.0.0.1" });
        await writeFile(
          path.join(home, "config.toml"),
          codexConfig({ proxyUrl, agentId: agent.id, workspace }),
          "utf8",
        );

        const codex = await runCodex({
          binary: requiredEnv(codexBinary, "APPA_NATIVE_CODEX_BINARY"),
          home,
          workspace,
        });
        expect(
          codex.exitCode,
          realProvider
            ? "Real-model stock Codex run failed"
            : `${codex.stderr}\nstdout:\n${codex.stdout}`,
        ).toBe(0);
        expect(
          codex.stdout,
          JSON.stringify({
            requests: proxyRequests.map((value) => ({
              stream: value.stream,
              inputTypes: inputItems(value).map((item) => item.type),
            })),
            upstreamRequests: upstreamRequests.length,
            upstreamCountsAtBootstrap,
            stderr: realProvider ? undefined : codex.stderr,
          }),
        ).toContain(providerFinalText);

        // The real first client request was answered locally before it could
        // reach the upstream model server.
        expect(upstreamCountsAtBootstrap).toEqual([0]);
        expect(JSON.stringify(proxyRequests[0])).toContain(
          '"additional_tools"',
        );
        expect(upstreamRequests).toHaveLength(2);

        const discovery = proxyRequests
          .flatMap(inputItems)
          .find((item) => item.type === "custom_tool_call_output");
        expect(discovery).toBeDefined();
        expect(discoveryOutputText(discovery)).toContain(
          JSON.stringify(stockRegistry),
        );

        const projectedFunctions = namespaceFunctions(upstreamRequests[0]);
        expect(projectedFunctions).toContain("exec_command");
        expect(projectedFunctions).not.toContain("exec");
        expect(projectedFunctions).not.toContain("wait");

        const clientResult = proxyRequests
          .flatMap(inputItems)
          .find((item) => item.type === "function_call_output");
        expect(clientResult?.call_id).toMatch(/^call_appa_[0-9a-f]{32}$/);
        expect(clientResult?.call_id).not.toBe(providerCallId);

        const providerResult = inputItems(upstreamRequests[1]).find(
          (item) => item.type === "function_call_output",
        );
        expect(
          inputItems(upstreamRequests[1]).filter(
            (item) => item.id === providerReasoningItemId,
          ),
        ).toEqual([
          {
            type: "reasoning",
            id: providerReasoningItemId,
            summary: [],
            encrypted_content: providerReasoningCiphertext,
          },
        ]);
        if (realProvider)
          expect(providerResult?.call_id).not.toMatch(/^call_appa_/);
        else expect(providerResult).toMatchObject({ call_id: providerCallId });
        expect(JSON.stringify(providerResult?.output)).toContain(
          localExecutionMarker,
        );
      } finally {
        config.llmProxy.appaHook = originalHook;
        config.llm.openai.baseUrl = originalOpenAiBaseUrl;
        await Promise.all([proxy?.close(), upstream?.close()]);
        await stopProcess(runtime);
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      }
    }, 90_000);

    test("uses the authenticated gateway to approve one held local execution and resumes it once", async ({
      makeAdmin,
      makeAgent,
      makeMember,
      makeOrganization,
    }) => {
      const root = await mkdtemp(path.join(tmpdir(), "appa-native-gateway-"));
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      const policyPath = path.join(root, "appa.toml");
      const runtimeDb = path.join(root, "runtime.sqlite");
      const originalHook = config.llmProxy.appaHook;
      const originalOpenAiBaseUrl = config.llm.openai.baseUrl;
      let proxy: FastifyInstance | undefined;
      let upstream: FastifyInstance | undefined;
      let runtime: ReturnType<typeof spawn> | undefined;
      let runtimeStderr = "";

      try {
        await Promise.all([
          mkdir(home, { recursive: true }),
          mkdir(workspace, { recursive: true }),
          writeFile(policyPath, runtimeApprovalPolicy(), "utf8"),
        ]);
        const runtimePort = await reserveLoopbackPort();
        const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
        runtime = spawn(
          requiredEnv(runtimeBinary, "APPA_NATIVE_RUNTIME_BINARY"),
          [
            "runtime",
            "--adapter",
            "kagent",
            "--config",
            policyPath,
            "--db",
            runtimeDb,
            "--listen",
            `127.0.0.1:${runtimePort}`,
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              PATH: process.env.PATH,
              HOME: home,
              TMPDIR: root,
              APPA_PROXY_TOKEN: "synthetic-native-runtime-token-0123456789",
              APPA_PROXY_APPROVAL_SECRET:
                "synthetic-native-approval-key-0123456789abcdef",
            },
          },
        );
        runtime.stderr?.on("data", (chunk: Buffer) => {
          runtimeStderr += chunk.toString("utf8");
        });
        await waitForRuntime(runtimeUrl, runtime, () => runtimeStderr);

        const upstreamRequests: Array<Record<string, unknown>> = [];
        upstream = Fastify();
        upstream.post("/responses", async (request, reply) => {
          upstreamRequests.push(
            structuredClone(request.body) as Record<string, unknown>,
          );
          if (upstreamRequests.length === 1) {
            reply.type("text/event-stream");
            return responseSse([
              responseCreated("resp-held-local-execution"),
              {
                type: "response.output_item.done",
                item: {
                  id: providerReasoningItemId,
                  type: "reasoning",
                  summary: [],
                  encrypted_content: providerReasoningCiphertext,
                },
              },
              {
                type: "response.output_item.done",
                item: {
                  id: providerItemId,
                  type: "function_call",
                  namespace: "functions",
                  name: "exec_command",
                  call_id: providerCallId,
                  arguments: JSON.stringify({
                    cmd: `printf '${localExecutionMarker}\\n'`,
                    yield_time_ms: 1000,
                    max_output_tokens: 32,
                    login: false,
                  }),
                },
              },
              responseCompleted("resp-held-local-execution"),
            ]);
          }
          if (upstreamRequests.length === 2) {
            reply.type("text/event-stream");
            return responseSse([
              responseCreated("resp-held-final"),
              {
                type: "response.output_item.done",
                item: {
                  id: "msg-held-final",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: providerFinalText }],
                },
              },
              responseCompleted("resp-held-final"),
            ]);
          }
          return reply.code(429).send({ error: "unexpected provider request" });
        });
        const upstreamUrl = await upstream.listen({
          port: 0,
          host: "127.0.0.1",
        });

        config.llm.openai.baseUrl = upstreamUrl;
        config.llmProxy.appaHook = {
          url: runtimeUrl,
          timeoutMs: 10_000,
          sessionHmacSecret:
            "appa-native-stock-session-hmac-secret-0123456789abcdef",
          nativeCodexEnabled: true,
          runtimeToken: "synthetic-native-runtime-token-0123456789",
          approvalSigningSecret:
            "synthetic-native-approval-key-0123456789abcdef",
          autoAcceptRestrictions: true,
        };
        await ModelModel.upsert({
          externalId: `openai/${model}`,
          provider: "openai",
          modelId: model,
          inputModalities: null,
          outputModalities: null,
          customPricePerMillionInput: "2.50",
          customPricePerMillionOutput: "10.00",
          lastSyncedAt: new Date(),
        });

        const organization = await makeOrganization();
        const reviewer = await makeAdmin();
        await makeMember(reviewer.id, organization.id, { role: "admin" });
        const llmAgent = await makeAgent({
          name: "APPA native held local execution proxy",
          organizationId: organization.id,
          agentType: "llm_proxy",
        });
        const gatewayAgent = await makeAgent({
          name: "APPA native held local execution gateway",
          organizationId: organization.id,
          agentType: "mcp_gateway",
        });
        const { value: gatewayToken } = await UserTokenModel.create(
          reviewer.id,
          organization.id,
          "APPA native gateway token",
        );
        const { value: passthroughToken } = await VirtualApiKeyModel.create({
          organizationId: organization.id,
          name: "APPA native Codex identity",
          keyType: "passthrough",
          scope: "personal",
          authorId: reviewer.id,
        });

        const proxyRequests: Array<Record<string, unknown>> = [];
        const proxyPassthroughHeaders: boolean[] = [];
        const gatewayRequests: Array<Record<string, unknown>> = [];
        proxy = createProxyApp();
        proxy.addHook("preHandler", async (request) => {
          if (
            request.method === "POST" &&
            request.url === `/v1/openai/${llmAgent.id}/responses`
          ) {
            proxyRequests.push(
              structuredClone(request.body) as Record<string, unknown>,
            );
            proxyPassthroughHeaders.push(
              typeof request.headers["x-archestra-virtual-key"] === "string",
            );
          }
          if (
            request.method === "POST" &&
            request.url === `/v1/mcp/${gatewayAgent.id}`
          ) {
            gatewayRequests.push(
              structuredClone(request.body) as Record<string, unknown>,
            );
          }
        });
        await proxy.register(openAiProxyRoutes);
        await proxy.register(mcpGatewayRoutes);
        const proxyUrl = await proxy.listen({ port: 0, host: "127.0.0.1" });
        await writeFile(
          path.join(home, "config.toml"),
          codexConfig({
            proxyUrl,
            agentId: llmAgent.id,
            workspace,
            passthroughToken,
            gateway: {
              agentId: gatewayAgent.id,
              tokenEnv: "APPA_NATIVE_GATEWAY_TOKEN",
            },
          }),
          "utf8",
        );
        const codexPromise = runCodex({
          binary: requiredEnv(codexBinary, "APPA_NATIVE_CODEX_BINARY"),
          home,
          workspace,
          gatewayToken,
        });
        try {
          await expect
            .poll(async () => {
              const [pending] = await db
                .select()
                .from(schema.appaProxyApprovalsTable)
                .where(
                  eq(
                    schema.appaProxyApprovalsTable.organizationId,
                    organization.id,
                  ),
                )
                .limit(1);
              return pending;
            })
            .toBeDefined();
        } catch (error) {
          const codex = await codexPromise;
          throw new Error(
            `Native control approval was not created: ${error instanceof Error ? error.message : String(error)}\n${codex.stderr}\nstdout:\n${codex.stdout}`,
          );
        }
        const [approval] = await db
          .select()
          .from(schema.appaProxyApprovalsTable)
          .where(
            eq(schema.appaProxyApprovalsTable.organizationId, organization.id),
          )
          .limit(1);
        if (!approval)
          throw new Error("native Codex run did not create approval");
        await AppaApprovalModel.decide({
          organizationId: organization.id,
          id: approval.id,
          userId: reviewer.id,
          isAgentAdmin: true,
          approverId: reviewer.id,
          decision: "approve",
          audit: {
            actorName: reviewer.name,
            actorEmail: reviewer.email,
            actorType: "user",
            impersonatedBy: null,
            requestId: crypto.randomUUID(),
            httpPath: "/test/appa-native-codex-stock",
          },
        });
        const codex = await codexPromise;
        expect(
          codex.exitCode,
          `${codex.stderr}\nstdout:\n${codex.stdout}\ngateway requests:\n${JSON.stringify(gatewayRequests)}\nproxy passthrough headers:\n${JSON.stringify(proxyPassthroughHeaders)}\nproxy input identities:\n${JSON.stringify(proxyRequests.flatMap(inputItems).map((item) => ({ type: item.type, id: item.id, call_id: item.call_id, name: item.name, output: item.output })))}`,
        ).toBe(0);
        expect(codex.stdout).toContain(providerFinalText);
        expect(upstreamRequests).toHaveLength(2);

        expect(
          inputItems(upstreamRequests[1]).filter(
            (item) => item.id === providerReasoningItemId,
          ),
        ).toEqual([
          {
            type: "reasoning",
            id: providerReasoningItemId,
            summary: [],
            encrypted_content: providerReasoningCiphertext,
          },
        ]);
        const restoredBusinessResult = inputItems(upstreamRequests[1]).find(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === providerCallId,
        );
        expect(JSON.stringify(restoredBusinessResult?.output)).toContain(
          localExecutionMarker,
        );

        const gatewayControlCall = gatewayRequests.find(
          (body) =>
            body.method === "tools/call" &&
            isObject(body.params) &&
            body.params.name === "archestra__appa_execute_remedy",
        );
        expect(gatewayControlCall).toMatchObject({
          params: {
            arguments: {
              wire_context: {
                call_id: expect.stringMatching(/^call_appa_control_/),
                thread_id: expect.any(String),
              },
            },
          },
        });

        const controlResult = proxyRequests
          .flatMap(inputItems)
          .find(
            (item) =>
              item.type === "function_call_output" &&
              typeof item.call_id === "string" &&
              item.call_id.startsWith("call_appa_control_"),
          );
        expect(controlResult).toBeDefined();
        const mutationResults = proxyRequests
          .flatMap(inputItems)
          .filter(
            (item) =>
              item.type === "function_call_output" &&
              JSON.stringify(item.output).includes(localExecutionMarker),
          );
        expect(mutationResults).toHaveLength(1);

        const controlFrames = await db
          .select({
            state: schema.appaProxyWireFramesTable.state,
            receipt: schema.appaProxyWireFramesTable.receiptCiphertext,
          })
          .from(schema.appaProxyWireFramesTable)
          .where(
            eq(
              schema.appaProxyWireFramesTable.controlCallId,
              controlResult?.call_id as string,
            ),
          );
        expect(controlFrames).toEqual([
          expect.objectContaining({
            state: "completed",
            receipt: expect.any(String),
          }),
        ]);
        const resolutions = await db
          .select({ event: schema.appaProxyEventsTable.event })
          .from(schema.appaProxyEventsTable)
          .where(eq(schema.appaProxyEventsTable.event, "resolve_batch_offer"));
        expect(resolutions).toHaveLength(1);
      } finally {
        config.llmProxy.appaHook = originalHook;
        config.llm.openai.baseUrl = originalOpenAiBaseUrl;
        await Promise.all([proxy?.close(), upstream?.close()]);
        await stopProcess(runtime);
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      }
    }, 120_000);

    for (const dropAfterCommit of [false, true]) {
      test(dropAfterCommit
        ? "quarantines a gateway mutation whose reply was dropped after commit without retry"
        : "approves one gateway-routed synthetic MCP mutation and persists its SQLite attempt", async ({
        makeAdmin,
        makeAgent,
        makeAgentTool,
        makeInternalMcpCatalog,
        makeMcpServer,
        makeMember,
        makeOrganization,
        makeTool,
      }) => {
        const root = await mkdtemp(
          path.join(tmpdir(), "appa-native-mcp-mutation-"),
        );
        const home = path.join(root, "home");
        const workspace = path.join(root, "workspace");
        const policyPath = path.join(root, "appa.toml");
        const runtimeDb = path.join(root, "runtime.sqlite");
        const fixtureDb = path.join(root, "fixture.sqlite");
        const fixtureToken = "synthetic-native-fixture-token-0123456789";
        const fixtureAdminToken =
          "synthetic-native-fixture-admin-token-0123456789";
        const requestKey = `synthetic-codex-${crypto.randomUUID().replaceAll("-", "")}`;
        const value = "SYNTHETIC_CODEX_GATEWAY_APPROVED";
        const originalHook = config.llmProxy.appaHook;
        const originalOpenAiBaseUrl = config.llm.openai.baseUrl;
        let proxy: FastifyInstance | undefined;
        let upstream: FastifyInstance | undefined;
        let runtime: ReturnType<typeof spawn> | undefined;
        let fixture: ReturnType<typeof spawn> | undefined;
        let runtimeStderr = "";
        let fixtureStderr = "";

        try {
          await Promise.all([
            mkdir(home, { recursive: true }),
            mkdir(workspace, { recursive: true }),
            writeFile(policyPath, runtimeMcpApprovalPolicy(), "utf8"),
          ]);
          const runtimePort = await reserveLoopbackPort();
          const fixturePort = await reserveLoopbackPort();
          const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
          const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
          fixture = spawn(
            process.execPath,
            [
              path.resolve(
                import.meta.dirname,
                "../../../../experiments/appa-proxy/native-mcp-fixture.mjs",
              ),
            ],
            {
              stdio: ["ignore", "pipe", "pipe"],
              env: {
                PATH: process.env.PATH,
                HOME: home,
                TMPDIR: root,
                APPA_FIXTURE_DB: fixtureDb,
                APPA_FIXTURE_HOST: "127.0.0.1",
                APPA_FIXTURE_PORT: String(fixturePort),
                APPA_FIXTURE_TOKEN: fixtureToken,
                APPA_FIXTURE_ADMIN_TOKEN: fixtureAdminToken,
              },
            },
          );
          fixture.stdout?.resume();
          fixture.stderr?.on("data", (chunk: Buffer) => {
            fixtureStderr += chunk.toString("utf8");
          });
          await waitForFixture(fixtureUrl, fixture, () => fixtureStderr);
          if (dropAfterCommit) {
            const configured = await fetch(`${fixtureUrl}/admin/fault`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${fixtureAdminToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                request_key: requestKey,
                mode: "drop_after_commit",
              }),
            });
            expect(configured.status).toBe(200);
          }

          runtime = spawn(
            requiredEnv(runtimeBinary, "APPA_NATIVE_RUNTIME_BINARY"),
            [
              "runtime",
              "--adapter",
              "kagent",
              "--config",
              policyPath,
              "--db",
              runtimeDb,
              "--listen",
              `127.0.0.1:${runtimePort}`,
            ],
            {
              stdio: ["ignore", "pipe", "pipe"],
              env: {
                PATH: process.env.PATH,
                HOME: home,
                TMPDIR: root,
                APPA_PROXY_TOKEN: "synthetic-native-runtime-token-0123456789",
                APPA_PROXY_APPROVAL_SECRET:
                  "synthetic-native-approval-key-0123456789abcdef",
              },
            },
          );
          runtime.stderr?.on("data", (chunk: Buffer) => {
            runtimeStderr += chunk.toString("utf8");
          });
          await waitForRuntime(runtimeUrl, runtime, () => runtimeStderr);

          const upstreamRequests: Array<Record<string, unknown>> = [];
          upstream = Fastify();
          upstream.post("/responses", async (request, reply) => {
            upstreamRequests.push(
              structuredClone(request.body) as Record<string, unknown>,
            );
            reply.type("text/event-stream");
            if (upstreamRequests.length === 1) {
              return responseSse([
                responseCreated("resp-mcp-held"),
                {
                  type: "response.output_item.done",
                  item: {
                    id: providerReasoningItemId,
                    type: "reasoning",
                    summary: [],
                    encrypted_content: providerReasoningCiphertext,
                  },
                },
                {
                  type: "response.output_item.done",
                  item: {
                    id: providerItemId,
                    type: "function_call",
                    namespace: nativeFixtureMcpNamespace,
                    name: nativeFixtureToolName,
                    call_id: providerCallId,
                    arguments: JSON.stringify({
                      request_key: requestKey,
                      value,
                    }),
                  },
                },
                responseCompleted("resp-mcp-held"),
              ]);
            }
            if (upstreamRequests.length === 2) {
              return responseSse([
                responseCreated("resp-mcp-final"),
                {
                  type: "response.output_item.done",
                  item: {
                    id: "msg-mcp-final",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: providerFinalText }],
                  },
                },
                responseCompleted("resp-mcp-final"),
              ]);
            }
            return reply
              .code(429)
              .send({ error: "unexpected provider request" });
          });
          const upstreamUrl = await upstream.listen({
            port: 0,
            host: "127.0.0.1",
          });

          config.llm.openai.baseUrl = upstreamUrl;
          config.llmProxy.appaHook = {
            url: runtimeUrl,
            timeoutMs: 10_000,
            sessionHmacSecret:
              "appa-native-stock-session-hmac-secret-0123456789abcdef",
            nativeCodexEnabled: true,
            runtimeToken: "synthetic-native-runtime-token-0123456789",
            approvalSigningSecret:
              "synthetic-native-approval-key-0123456789abcdef",
            autoAcceptRestrictions: true,
          };
          await ModelModel.upsert({
            externalId: `openai/${model}`,
            provider: "openai",
            modelId: model,
            inputModalities: null,
            outputModalities: null,
            customPricePerMillionInput: "2.50",
            customPricePerMillionOutput: "10.00",
            lastSyncedAt: new Date(),
          });

          const organization = await makeOrganization();
          const reviewer = await makeAdmin();
          await makeMember(reviewer.id, organization.id, { role: "admin" });
          const llmAgent = await makeAgent({
            name: "APPA native MCP mutation proxy",
            organizationId: organization.id,
            agentType: "llm_proxy",
          });
          const gatewayAgent = await makeAgent({
            name: "APPA native MCP mutation gateway",
            organizationId: organization.id,
            agentType: "mcp_gateway",
          });
          const catalog = await makeInternalMcpCatalog({
            organizationId: organization.id,
            name: nativeFixtureCatalogName,
            serverType: "remote",
            serverUrl: `${fixtureUrl}/mcp`,
            scope: "org",
            userConfig: {
              api_token: {
                type: "string",
                title: "Fixture token",
                description: "Synthetic fixture bearer token",
                required: true,
                sensitive: true,
                headerName: "Authorization",
                valuePrefix: "Bearer ",
              },
            },
          });
          const tool = await makeTool({
            catalogId: catalog.id,
            name: nativeFixtureToolName,
            description: "Create a durable synthetic job.",
          });
          const credential = await secretManager().createSecret(
            { api_token: fixtureToken },
            "native-fixture-gateway-credential",
          );
          const remoteMcpServer = await makeMcpServer({
            catalogId: catalog.id,
            serverType: "remote",
            scope: "org",
            secretId: credential.id,
          });
          await makeAgentTool(gatewayAgent.id, tool.id, {
            mcpServerId: remoteMcpServer.id,
            credentialResolutionMode: "static",
          });
          const { value: gatewayToken } = await UserTokenModel.create(
            reviewer.id,
            organization.id,
            "APPA native mutation gateway token",
          );
          const { value: passthroughToken } = await VirtualApiKeyModel.create({
            organizationId: organization.id,
            name: "APPA native mutation Codex identity",
            keyType: "passthrough",
            scope: "personal",
            authorId: reviewer.id,
          });

          const gatewayRequests: Array<Record<string, unknown>> = [];
          proxy = createProxyApp();
          proxy.addHook("preHandler", async (request) => {
            if (
              request.method === "POST" &&
              request.url === `/v1/mcp/${gatewayAgent.id}`
            ) {
              gatewayRequests.push(
                structuredClone(request.body) as Record<string, unknown>,
              );
            }
          });
          await proxy.register(openAiProxyRoutes);
          await proxy.register(mcpGatewayRoutes);
          const proxyUrl = await proxy.listen({ port: 0, host: "127.0.0.1" });
          await writeFile(
            path.join(home, "config.toml"),
            codexConfig({
              proxyUrl,
              agentId: llmAgent.id,
              workspace,
              passthroughToken,
              gateway: {
                agentId: gatewayAgent.id,
                tokenEnv: "APPA_NATIVE_GATEWAY_TOKEN",
              },
            }),
            "utf8",
          );

          const codexPromise = runCodex({
            binary: requiredEnv(codexBinary, "APPA_NATIVE_CODEX_BINARY"),
            home,
            workspace,
            gatewayToken,
            prompt: `Use only ${nativeFixtureToolName} through the configured Archestra MCP gateway. Create the synthetic job with request_key ${requestKey} and value ${value}. Then answer exactly ${providerFinalText}.`,
          });
          const approval = await waitForApproval({
            organizationId: organization.id,
            tool: nativeFixturePolicyToolName,
            codexPromise,
          });
          await AppaApprovalModel.decide({
            organizationId: organization.id,
            id: approval.id,
            userId: reviewer.id,
            isAgentAdmin: true,
            approverId: reviewer.id,
            decision: "approve",
            audit: {
              actorName: reviewer.name,
              actorEmail: reviewer.email,
              actorType: "user",
              impersonatedBy: null,
              requestId: crypto.randomUUID(),
              httpPath: "/test/appa-native-codex-mcp-mutation",
            },
          });
          const codex = await codexPromise;
          const fixtureState = await readFixtureState({
            fixtureUrl,
            adminToken: fixtureAdminToken,
            requestKey,
          });
          expect(fixtureState.jobs, `${codex.stderr}\n${codex.stdout}`).toEqual(
            [expect.objectContaining({ request_key: requestKey, value })],
          );
          expect(fixtureState.invocations).toEqual([
            expect.objectContaining({
              tool: "create_job",
              outcome: dropAfterCommit
                ? "committed_reply_dropped"
                : "completed",
            }),
          ]);
          if (dropAfterCommit) {
            expect(codex.exitCode, `${codex.stderr}\n${codex.stdout}`).toBe(1);
            expect(upstreamRequests).toHaveLength(2);
            expect(codex.stdout).not.toContain(providerFinalText);
            const [session] = await db
              .select()
              .from(schema.appaProxySessionsTable)
              .where(eq(schema.appaProxySessionsTable.id, approval.sessionId));
            expect(session?.state).toBe("quarantined");
            return;
          }
          expect(
            codex.exitCode,
            `${codex.stderr}\nstdout:\n${codex.stdout}`,
          ).toBe(0);
          expect(codex.stdout).toContain(providerFinalText);
          expect(upstreamRequests).toHaveLength(3);
          // Stock Codex returns the namespace-wrapper search result before the
          // next provider call. The real proxy must claim its sealed receipt,
          // bind the decorated run_tool name, then admit the gateway execution.
          expect(inputItems(upstreamRequests[1])).toContainEqual(
            expect.objectContaining({
              type: "tool_search_output",
              execution: "client",
              status: "completed",
              tools: [
                expect.objectContaining({
                  name: nativeFixtureMcpNamespace,
                  tools: expect.arrayContaining([
                    expect.objectContaining({
                      type: "function",
                      name: "archestra__run_tool",
                    }),
                  ]),
                }),
              ],
            }),
          );
          expect(
            inputItems(upstreamRequests[2]).filter(
              (item) => item.id === providerReasoningItemId,
            ),
          ).toEqual([
            {
              type: "reasoning",
              id: providerReasoningItemId,
              summary: [],
              encrypted_content: providerReasoningCiphertext,
            },
          ]);
          const providerResult = inputItems(upstreamRequests[2]).find(
            (item) =>
              item.type === "function_call_output" &&
              item.call_id === providerCallId,
          );
          expect(JSON.stringify(providerResult?.output)).toContain(requestKey);
          expect(JSON.stringify(providerResult?.output)).toContain(value);

          const gatewayCall = gatewayRequests.find(
            (body) =>
              body.method === "tools/call" &&
              isObject(body.params) &&
              body.params.name === "archestra__run_tool",
          );
          expect(gatewayCall).toMatchObject({
            params: {
              arguments: {
                tool_name: nativeFixtureToolName,
                tool_args: { request_key: requestKey, value },
                wire_context: {
                  call_id: expect.stringMatching(/^call_appa_/),
                  thread_id: expect.any(String),
                  item_id: expect.stringMatching(/^fc_call_appa_/),
                },
              },
            },
          });
        } finally {
          config.llmProxy.appaHook = originalHook;
          config.llm.openai.baseUrl = originalOpenAiBaseUrl;
          await mcpClient.disconnectAll();
          await Promise.all([proxy?.close(), upstream?.close()]);
          await stopProcess(runtime);
          await stopProcess(fixture);
          await rm(root, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
        }
      }, 180_000);
    }
  },
);

function createProxyApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { message: error.message, type: error.type },
      });
    }
    return reply
      .status((error as { statusCode?: number }).statusCode ?? 500)
      .send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "api_internal_server_error",
        },
      });
  });
  return app;
}

function codexConfig(params: {
  proxyUrl: string;
  agentId: string;
  workspace: string;
  passthroughToken?: string;
  gateway?: { agentId: string; tokenEnv: string };
}): string {
  return `model = "${model}"
model_provider = "appa_proxy"
model_reasoning_effort = "none"
approval_policy = "never"

[model_providers.appa_proxy]
name = "APPA native proxy fixture"
base_url = "${params.proxyUrl}/v1/openai/${params.agentId}"
env_key = "APPA_NATIVE_CODEX_FAKE_AUTH"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 30000
supports_websockets = false
${params.passthroughToken ? `http_headers = { "X-Archestra-Virtual-Key" = "${params.passthroughToken}" }\n` : ""}

${
  params.gateway
    ? `[mcp_servers.appa_gateway]
url = "${params.proxyUrl}/v1/mcp/${params.gateway.agentId}"
bearer_token_env_var = "${params.gateway.tokenEnv}"
enabled_tools = ["archestra__search_tools", "archestra__run_tool", "archestra__appa_inspect_plan", "archestra__appa_execute_remedy", "archestra__appa_status"]

[mcp_servers.appa_gateway.tools.archestra__search_tools]
approval_mode = "approve"

[mcp_servers.appa_gateway.tools.archestra__run_tool]
approval_mode = "approve"

[mcp_servers.appa_gateway.tools.archestra__appa_inspect_plan]
approval_mode = "approve"

[mcp_servers.appa_gateway.tools.archestra__appa_execute_remedy]
approval_mode = "approve"

[mcp_servers.appa_gateway.tools.archestra__appa_status]
approval_mode = "approve"

`
    : ""
}

[features]
plugins = false
shell_snapshot = false
shell_snapshot_v2 = false

[shell_environment_policy]
inherit = "none"

[projects.${JSON.stringify(params.workspace)}]
trust_level = "trusted"
`;
}

function runtimePolicy(): string {
  return `[policy]
version = 2

[[policy.tool]]
name = "functions.exec_command"
parameters = { type = "object", properties = { cmd = { type = "string", const = "printf '${localExecutionMarker}\\\\n'" }, login = { type = "boolean", const = false }, yield_time_ms = { type = "integer", minimum = 0, maximum = 1000 }, max_output_tokens = { type = "integer", minimum = 1, maximum = 1000 } }, required = ["cmd", "login"], additionalProperties = false }
delta = {}

[externals]
timeout_ms = 1000
review_timeout_ms = 10000
max_body_bytes = 65536
`;
}

function runtimeApprovalPolicy(): string {
  return `[policy]
version = 2

[[policy.tool]]
name = "functions.exec_command"
parameters = { type = "object", properties = { cmd = { type = "string", const = "printf '${localExecutionMarker}\\\\n'" }, login = { type = "boolean", const = false }, yield_time_ms = { type = "integer", minimum = 0, maximum = 1000 }, max_output_tokens = { type = "integer", minimum = 1, maximum = 1000 } }, required = ["cmd", "login"], additionalProperties = false }
delta = {}

[policy.tool.requires]
attention = ["human-approval"]

[[policy.authority]]
name = "native-test-reviewer"
hint = "Synthetic approval fixture."

[policy.authority.permits]
attention = ["human-approval"]

[externals]
timeout_ms = 1000
review_timeout_ms = 30000
max_body_bytes = 65536

[externals.authorities.native-test-reviewer]
builtin = "hitl"
`;
}

function runtimeMcpApprovalPolicy(): string {
  return `[policy]
version = 2

[[policy.tool]]
name = "${nativeFixturePolicyToolName}"
parameters = { type = "object", properties = { request_key = { type = "string" }, value = { type = "string", maxLength = 2000 } }, required = ["request_key", "value"], additionalProperties = false }
delta = {}

[policy.tool.requires]
attention = ["human-approval"]

[[policy.authority]]
name = "native-test-reviewer"
hint = "Synthetic MCP approval fixture."

[policy.authority.permits]
attention = ["human-approval"]

[externals]
timeout_ms = 1000
review_timeout_ms = 30000
max_body_bytes = 65536

[externals.authorities.native-test-reviewer]
builtin = "hitl"
`;
}

async function waitForApproval(params: {
  organizationId: string;
  tool: string;
  codexPromise: Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
}): Promise<{ id: string; sessionId: string }> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const [approval] = await db
      .select({
        id: schema.appaProxyApprovalsTable.id,
        sessionId: schema.appaProxyApprovalsTable.sessionId,
      })
      .from(schema.appaProxyApprovalsTable)
      .where(
        and(
          eq(
            schema.appaProxyApprovalsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.appaProxyApprovalsTable.tool, params.tool),
          eq(schema.appaProxyApprovalsTable.status, "pending"),
        ),
      )
      .limit(1);
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const codex = await params.codexPromise;
  throw new Error(
    `Synthetic MCP approval was not created for ${params.tool}: ${codex.stderr}\nstdout:\n${codex.stdout}`,
  );
}

async function waitForFixture(
  fixtureUrl: string,
  process: ReturnType<typeof spawn>,
  getStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastProbe = "no health response";
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(
        `Native MCP fixture exited before health check (${process.exitCode}): ${getStderr() || "no stderr"}`,
      );
    }
    const probe = await runtimeHealthProbe(fixtureUrl);
    lastProbe = probe.detail;
    if (probe.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for native MCP fixture health endpoint (${lastProbe}): ${getStderr() || "no stderr"}`,
  );
}

async function readFixtureState(params: {
  fixtureUrl: string;
  adminToken: string;
  requestKey: string;
}): Promise<{
  jobs: Array<Record<string, unknown>>;
  invocations: Array<Record<string, unknown>>;
}> {
  const response = await fetch(
    `${params.fixtureUrl}/admin/state?request_key=${encodeURIComponent(params.requestKey)}`,
    {
      headers: { authorization: `Bearer ${params.adminToken}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Native MCP fixture admin inspection failed: HTTP ${response.status}`,
    );
  }
  return (await response.json()) as {
    jobs: Array<Record<string, unknown>>;
    invocations: Array<Record<string, unknown>>;
  };
}

function responseSse(events: unknown[]): string {
  return events
    .map(
      (event) =>
        `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}

function responseCreated(id: string) {
  return {
    type: "response.created",
    response: {
      id,
      object: "response",
      created_at: 1,
      model,
      status: "in_progress",
      output: [],
    },
  };
}

function responseCompleted(id: string) {
  return {
    type: "response.completed",
    response: {
      id,
      object: "response",
      created_at: 1,
      model,
      status: "completed",
      output: [],
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function inputItems(
  body: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return Array.isArray(body.input) ? body.input.filter(isObject) : [];
}

function namespaceFunctions(body: Record<string, unknown>): string[] {
  const functions = (Array.isArray(body.tools) ? body.tools : [])
    .filter(isObject)
    .find((tool) => tool.type === "namespace" && tool.name === "functions");
  return Array.isArray(functions?.tools)
    ? functions.tools
        .filter(isObject)
        .filter((tool) => tool.type === "function")
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === "string")
    : [];
}

function discoveryOutputText(
  item: Record<string, unknown> | undefined,
): string {
  return Array.isArray(item?.output)
    ? item.output
        .filter(isObject)
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("\n")
    : "";
}

function payloadToText(payload: unknown): string {
  return typeof payload === "string"
    ? payload
    : Buffer.isBuffer(payload)
      ? payload.toString("utf8")
      : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for this integration test`);
  return value;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a loopback port for the APPA runtime");
  }
  return address.port;
}

async function waitForRuntime(
  runtimeUrl: string,
  process: ReturnType<typeof spawn>,
  getStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastProbe = "no health response";
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(
        `APPA runtime exited before health check (${process.exitCode}): ${getStderr() || "no stderr"}`,
      );
    }
    const probe = await runtimeHealthProbe(runtimeUrl);
    lastProbe = probe.detail;
    if (probe.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for the APPA runtime health endpoint (${lastProbe}): ${getStderr() || "no stderr"}`,
  );
}

async function runtimeHealthProbe(
  runtimeUrl: string,
): Promise<{ ok: boolean; detail: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const request = httpRequest(`${runtimeUrl}/health`, {}, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.once("end", () => {
        finish({
          ok: response.statusCode === 200,
          detail: `HTTP ${response.statusCode}: ${body}`,
        });
      });
    });
    request.once("error", (error) =>
      finish({ ok: false, detail: error.message }),
    );
    timeout = setTimeout(() => {
      request.destroy();
      finish({ ok: false, detail: "health request timed out" });
    }, 500);
    request.end();
  });
}

async function runCodex(params: {
  binary: string;
  home: string;
  workspace: string;
  gatewayToken?: string;
  prompt?: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: {
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const child = spawn(
      params.binary,
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--json",
        "--cd",
        params.workspace,
        params.prompt ??
          `Call exec_command once with exactly ${JSON.stringify({ cmd: `printf '${localExecutionMarker}\\n'`, login: false, yield_time_ms: 1000, max_output_tokens: 32 })}. Do not use other business tools. Then answer exactly ${providerFinalText}.`,
      ],
      {
        cwd: params.workspace,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: params.home,
          TMPDIR: params.workspace,
          CODEX_HOME: params.home,
          APPA_NATIVE_CODEX_FAKE_AUTH: realProvider
            ? requiredEnv(process.env.OPENAI_API_KEY, "OPENAI_API_KEY")
            : "synthetic-native-codex-auth",
          ...(params.gatewayToken
            ? { APPA_NATIVE_GATEWAY_TOKEN: params.gatewayToken }
            : {}),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (exitCode) => finish({ exitCode, stdout, stderr }));
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        exitCode: child.exitCode,
        stdout,
        stderr: `${stderr}\nCodex did not complete within 30 seconds.`,
      });
    }, 30_000);
  });
}

async function stopProcess(
  process: ReturnType<typeof spawn> | undefined,
): Promise<void> {
  if (!process || process.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    process.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    process.kill("SIGTERM");
  });
}
