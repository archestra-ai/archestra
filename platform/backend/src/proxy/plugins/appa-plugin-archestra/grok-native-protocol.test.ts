import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { Client } from "pg";
import { vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import config from "@/config";
import * as database from "@/database";
import { ModelModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import { openappaBatteriesService } from "@/openappa/batteries";
import { readNotice } from "@/openappa/notice";
import type { OpenAppaSession } from "@/openappa/service";
import { withoutTrajectoryStamp } from "@/openappa/trajectory-stamp";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import {
  grokCanonicalToolName,
  grokToolName,
} from "@/routes/mcp-gateway/grok-tool-names";
import { openaiAdapterFactory } from "@/routes/proxy/adapters";
import type { AccumulatedToolCall } from "@/routes/proxy/llm-proxy-helpers";
import openAiProxyRoutes from "@/routes/proxy/routes/openai";
import xaiProxyRoutes from "@/routes/proxy/routes/xai";
import { detectGrokClientId } from "@/routes/proxy/utils/headers/client-app";
import { grokSetup } from "@/services/agent-connection-setup/agents/grok";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { afterEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { ApiError, type OpenAi } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import { registerLlmProxyPlugin } from "../registry";

setupTestCacheManager();
const originalEnabled = config.openappa.enabled;
const originalPlugins = config.llmProxy.plugins;
const originalSubscriptionBase = config.llm.xai.subscription.baseUrl;
let app: FastifyInstance | undefined;
let unregister: (() => void) | undefined;
afterEach(async () => {
  unregister?.();
  await drainBackgroundWork();
  await app?.close();
  app = undefined;
  unregister = undefined;
  config.llmProxy.plugins = originalPlugins;
  config.openappa.enabled = originalEnabled;
  config.llm.xai.subscription.baseUrl = originalSubscriptionBase;
  vi.restoreAllMocks();
});

test.skipIf(!process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL)(
  "real native ledger and MCP controls preserve Grok denial, bound native review, and exact approval retry",
  async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const databaseUrl = process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error("Isolated native test ledger required");
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      databaseUrl,
    );
    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
    const organizationId = (await makeOrganization()).id;
    const user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });
    await seedAndAssignArchestraTools(gateway.id);
    const platformKey = await makePassthroughCredential({
      organizationId,
      ownerId: user.id,
    });
    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    config.llmProxy.plugins = [];
    unregister = registerLlmProxyPlugin(createAppaLlmProxyPlugin());
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) =>
      reply.status(error instanceof ApiError ? error.statusCode : 500).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type:
            error instanceof ApiError
              ? error.type
              : "api_internal_server_error",
        },
      }),
    );
    await app.register(openAiProxyRoutes);
    await app.register(xaiProxyRoutes);
    let upstreamCalls: AccumulatedToolCall[] = [];
    const providerRequests: unknown[] = [];
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(() => {
      const client = createOpenAiTestClient({
        nonStreamingToolCalls: upstreamCalls,
      });
      const create = client.chat.completions.create;
      client.chat.completions.create = async (params) => {
        providerRequests.push(structuredClone(params));
        return create(params);
      };
      return client as never;
    });
    const revision = await guardrailsPolicyService.get(organizationId);
    await guardrailsPolicyService.update({
      organizationId,
      userId: user.id,
      expectedRevision: revision.revision,
      content: `[policy]\nversion = 2\n[[policy.tool]]\nname = "host/archestra/Write"\ndelta = {}\nrequires = { attention = ["synthetic-review"] }\n[[policy.authority]]\nname = "synthetic-operator"\npermits = { attention = ["synthetic-review"] }\n[externals.authorities.synthetic-operator]\nbuiltin = "hitl"\n`,
    });
    await openappaBatteriesService.getEffectivePolicy(organizationId);
    const storedPolicy =
      await OpenAppaEffectivePolicyModel.find(organizationId);
    if (!storedPolicy) throw new Error("Expected compiled test policy");
    const ledger = new Client({ connectionString: databaseUrl });
    await ledger.connect();
    try {
      await ledger.query(
        "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING",
        [organizationId, "synthetic-native", `synthetic-${organizationId}`],
      );
      await ledger.query(
        "INSERT INTO openappa_effective_policies (organization_id, content, content_hash, root_revision, install_fingerprint, compiled_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          organizationId,
          storedPolicy.content,
          storedPolicy.contentHash,
          storedPolicy.rootRevision,
          storedPolicy.installFingerprint,
          storedPolicy.compiledAt,
        ],
      );
    } finally {
      await ledger.end();
    }
    const names = ["get_remedy_plans", "execute_remedy_plan", "ask_user"];
    const rulings = [
      "Approve",
      "Deny",
      "unrecognized",
      "wrong-question",
      "unoffered",
    ] as const;
    for (const { ruling, encoded, direct } of [
      { encoded: false, direct: false },
      { encoded: true, direct: false },
      { encoded: true, direct: true },
    ].flatMap((mode) => rulings.map((ruling) => ({ ruling, ...mode })))) {
      const controlName = (name: string) =>
        `gateway__${encoded ? grokToolName(`archestra__${name}`) : `archestra__${name}`}`;
      const discovered = names.map((name) => ({
        tool_name: controlName(name),
        description: attestToolDescription({
          organizationId,
          gatewayId: gateway.id,
          advertisedName: `archestra__${name}`,
          kind: "b",
          description: "Synthetic gateway control",
        }),
        input_schema: { type: "object", additionalProperties: true },
      }));
      const nativeId = randomUUID();
      const session: OpenAppaSession = {
        organization_id: organizationId,
        caller_id: `user:${user.id}`,
        session_id: `user:${user.id}|${nativeId}`,
      };
      const history: OpenAi.Types.ChatCompletionsRequest["messages"] = [
        { role: "user", content: "Synthetic policy protocol verification" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "discovery",
              type: "function",
              function: {
                name: "search_tool",
                arguments: '{"query":"gateway remedy"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "discovery",
          content: JSON.stringify({
            results: [{ server: "gateway", tools: discovered }],
            status: "ready",
            total_hidden_tools: 3,
            note: null,
          }),
        },
      ];
      const turn = async (
        calls: AccumulatedToolCall[],
        expectedDecision: "allow" | "refuse" = "allow",
      ) => {
        const body: OpenAi.Types.ChatCompletionsRequest = {
          model: "gpt-4o",
          stream: false,
          messages: structuredClone(history),
          tools: ["write", "use_tool", "search_tool", "ask_user_question"].map(
            (name) => ({
              type: "function",
              function: { name, parameters: { type: "object" } },
            }),
          ),
        };
        upstreamCalls = calls;
        if (!app) throw new Error("Native protocol proxy app is not running");
        const response = await app.inject({
          method: "POST",
          url: `/v1/openai/${gateway.id}/chat/completions`,
          headers: {
            authorization: "Bearer synthetic-upstream-key",
            "x-archestra-virtual-key": platformKey,
            "x-archestra-agent-id": "grok-build",
            "x-grok-session-id": nativeId,
            "x-appa-session-id": nativeId,
            "x-grok-client-mode": "interactive",
          },
          payload: body,
        });
        expect(response.statusCode, response.body).toBe(200);
        if (expectedDecision === "refuse") {
          expect(response.json().choices[0].message.tool_calls).toBeUndefined();
          expect(response.json().choices[0].message.content).toContain(
            "did not approve",
          );
          return [];
        }
        expect(JSON.stringify(providerRequests)).not.toContain("[[gwa1");
        return (response.json().choices[0].message.tool_calls ?? []).map(
          (call: {
            id: string;
            function: { name: string; arguments: string };
          }) => ({
            id: withoutTrajectoryStamp(call.id),
            wireId: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          }),
        ) as AccumulatedToolCall[];
      };
      const execute = async (call: AccumulatedToolCall) => {
        expect(call.name).toBe("use_tool");
        const input = JSON.parse(call.arguments);
        const result = await executeArchestraTool(
          encoded
            ? (grokCanonicalToolName(
                input.tool_name.replace(/^gateway__/, ""),
              ) ?? "invalid")
            : input.tool_name.replace(/^gateway__/, ""),
          input.tool_input,
          {
            agent: { id: gateway.id, name: gateway.name },
            organizationId,
            userId: user.id,
            openappaSession: session,
            mrtr: { enabled: false, clientCapabilities: {} },
          },
        );
        const text = result.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        history.push(
          {
            role: "assistant",
            tool_calls: [
              {
                id: call.wireId ?? call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              },
            ],
          },
          { role: "tool", tool_call_id: call.wireId ?? call.id, content: text },
        );
        return text;
      };
      const original = {
        file_path: "/synthetic/note.txt",
        content: "synthetic",
      };
      const [notice] = await turn([
        {
          id: "write-denied",
          name: "write",
          arguments: JSON.stringify(original),
        },
      ]);
      expect(JSON.parse(notice.arguments).tool_name).toBe(
        controlName("get_remedy_plans"),
      );
      const parsedNotice = readNotice({
        callId: notice.id,
        arguments: JSON.parse(notice.arguments).tool_input,
      });
      expect(parsedNotice).toBeTruthy();
      const offerId = parsedNotice?.result.match(
        /offer_id["\s:]+([a-zA-Z0-9_-]+)/,
      )?.[1];
      expect(offerId, parsedNotice?.result).toBeTruthy();
      await execute(notice);
      const control = () => ({
        id: randomUUID(),
        name: direct ? controlName("execute_remedy_plan") : "use_tool",
        arguments: JSON.stringify(
          direct
            ? { offer_id: offerId, plan: "Request synthetic review" }
            : {
                tool_name: controlName("execute_remedy_plan"),
                tool_input: {
                  offer_id: offerId,
                  plan: "Request synthetic review",
                },
              },
        ),
      });
      const [review] = await turn([control()]);
      const reviewResult = await execute(review);
      expect(reviewResult).toContain("review_required");
      const [question] = await turn([
        {
          id: "ask",
          name: direct ? controlName("ask_user") : "use_tool",
          arguments: JSON.stringify(
            direct
              ? {
                  question: "Synthetic review",
                  options: [{ label: "Approve" }, { label: "Deny" }],
                  remedy_offer_ids: [offerId],
                }
              : {
                  tool_name: controlName("ask_user"),
                  tool_input: {
                    question: "Synthetic review",
                    options: [{ label: "Approve" }, { label: "Deny" }],
                    remedy_offer_ids: [offerId],
                  },
                },
          ),
        },
      ]);
      expect(question.name).toBe("ask_user_question");
      const card = JSON.parse(question.arguments).questions[0];
      const asked = card.question;
      const selectedLabel = card.options[ruling === "Approve" ? 0 : 1].label;
      history.push(
        {
          role: "assistant",
          tool_calls: [
            {
              id: question.wireId ?? question.id,
              type: "function",
              function: { name: question.name, arguments: question.arguments },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: question.wireId ?? question.id,
          content:
            ruling === "unrecognized"
              ? JSON.stringify({ answer: "Approve" })
              : `User has answered your questions: "${ruling === "wrong-question" ? "A different question" : asked}"="${ruling === "unoffered" ? "Yes" : selectedLabel}". You can now continue with the user's answers in mind.`,
        },
      );
      const [authorized] = await turn(
        [control()],
        ruling === "Approve" ? "allow" : "refuse",
      );
      if (ruling !== "Approve") {
        expect(authorized).toBeUndefined();
        const [deniedRetry] = await turn([
          {
            id: "denied-retry",
            name: "write",
            arguments: JSON.stringify(original),
          },
        ]);
        expect(deniedRetry.name).not.toBe("write");
        continue;
      }
      const authorization = await execute(authorized);
      expect(authorization).toContain("authorized");
      const [changedRetry] = await turn([
        {
          id: "changed-retry",
          name: "write",
          arguments: JSON.stringify({
            ...original,
            file_path: "/synthetic/different.txt",
          }),
        },
      ]);
      expect(changedRetry.name).not.toBe("write");
      const [retry] = await turn([
        {
          id: "write-retry",
          name: "write",
          arguments: JSON.stringify(original),
        },
      ]);
      expect(retry.name).toBe("write");
      expect(JSON.parse(retry.arguments)).toEqual(original);
    }
    if (process.env.ARCHESTRA_GROK_TEST_BINARY) {
      const nativeBinary = process.env.ARCHESTRA_GROK_TEST_BINARY;
      vi.mocked(openaiAdapterFactory.createClient).mockRestore();
      const observations: {
        callerKey: boolean;
        platformKeyAbsent: boolean;
        model: string;
        skillLoaded: boolean;
        ambientLoaded: boolean;
        auxiliary: boolean;
      }[] = [];
      const nativeToken = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "synthetic-native", email: "fixture@example.test", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.synthetic`;
      const upstream = createServer(async (request, response) => {
        if (request.method === "GET") {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              object: "list",
              default_model: "synthetic-native-model",
              data: [
                {
                  id: "synthetic-native-model",
                  model: "synthetic-native-model",
                  api_backend: "chat_completions",
                  object: "model",
                  owned_by: "synthetic",
                },
              ],
            }),
          );
          return;
        }
        let input = "";
        for await (const chunk of request) input += chunk;
        const body = JSON.parse(input);
        if (typeof body.model !== "string") {
          response.setHeader("content-type", "application/json");
          response.end("{}");
          return;
        }
        observations.push({
          callerKey:
            request.headers.authorization === "Bearer synthetic-caller-only" ||
            request.headers.authorization === `Bearer ${nativeToken}`,
          platformKeyAbsent: !request.headers["x-archestra-virtual-key"],
          model: body.model,
          auxiliary:
            String(request.headers["x-grok-conv-id"] ?? "").startsWith(
              "turn-summary-",
            ) ||
            !Array.isArray(body.tools) ||
            body.tools.every(
              (tool: { name?: string; function?: { name?: string } }) =>
                (tool.name ?? tool.function?.name) === "session_title",
            ),
          skillLoaded: JSON.stringify(
            body.messages ?? body.input ?? [],
          ).includes("GROK_NATIVE_SKILL_MARKER"),
          ambientLoaded:
            JSON.stringify(body).includes("AMBIENT_CLIENT_MUST_NOT_LOAD") ||
            JSON.stringify(body.tools ?? []).includes("ambient-"),
        });
        if (request.url?.endsWith("/responses")) {
          response.setHeader("content-type", "text/event-stream");
          response.end(
            `data: ${JSON.stringify({
              type: "response.completed",
              sequence_number: 1,
              response: {
                id: "resp_synthetic",
                object: "response",
                created_at: 1,
                status: "completed",
                model: body.model,
                output: [
                  {
                    type: "message",
                    id: "msg_synthetic",
                    role: "assistant",
                    status: "completed",
                    content: [
                      {
                        type: "output_text",
                        text: "SYNTHETIC NATIVE CLI PASSTHROUGH VERIFIED",
                        annotations: [],
                      },
                    ],
                  },
                ],
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  total_tokens: 2,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 },
                },
              },
            })}\n\n`,
          );
          return;
        }
        const chunk = (delta: object, finishReason: string | null) =>
          `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
        response.setHeader("content-type", "text/event-stream");
        response.end(
          chunk(
            {
              role: "assistant",
              content: "SYNTHETIC NATIVE CLI PASSTHROUGH VERIFIED",
            },
            null,
          ) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
        );
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const address = upstream.address();
      if (!address || typeof address === "string")
        throw new Error("Expected isolated upstream port");
      const upstreamUrl = `http://127.0.0.1:${address.port}/v1`;
      vi.spyOn(openaiAdapterFactory, "getBaseUrl").mockReturnValue(upstreamUrl);
      const ingress: {
        session: unknown;
        attribution: boolean;
        marker: unknown;
        detected: unknown;
      }[] = [];
      app.server.on("request", (request) => {
        if (
          request.url?.endsWith("/chat/completions") ||
          request.url?.endsWith("/responses")
        )
          ingress.push({
            session: request.headers["x-grok-session-id"],
            attribution:
              request.headers["x-archestra-virtual-key"] === platformKey,
            marker: request.headers["x-archestra-agent-id"],
            detected: detectGrokClientId(request.headers),
          });
      });
      const proxyUrl = await app.listen({ port: 0, host: "127.0.0.1" });
      const home = await mkdtemp(path.join(tmpdir(), "grok-native-proxy-"));
      const grokHome = path.join(home, ".grok"),
        remote = path.join(home, "remote"),
        plugin = path.join(remote, "plugins/team-skills"),
        skills = path.join(plugin, "skills"),
        bin = path.join(home, "bin"),
        gitConfig = path.join(home, "gitconfig");
      const run = (command: string, args: string[], input?: string) =>
        new Promise<{ status: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(command, args, {
              cwd: home,
              env: {
                ...Object.fromEntries(
                  Object.entries(process.env).filter(
                    ([name]) => !/^(GROK_|XAI_)/.test(name),
                  ),
                ),
                HOME: home,
                GROK_HOME: grokHome,
                PATH: bin + path.delimiter + process.env.PATH,
                GIT_CONFIG_GLOBAL: gitConfig,
                GIT_CONFIG_NOSYSTEM: "1",
                GROK_DISABLE_AUTOUPDATER: "1",
                GROK_TELEMETRY_ENABLED: "0",
                OPENAI_API_KEY: "synthetic-caller-only",
                GROK_MODELS_BASE_URL: upstreamUrl,
                GROK_CLI_CHAT_PROXY_BASE_URL: upstreamUrl,
              },
              stdio: "pipe",
            });
            let stdout = "",
              stderr = "";
            child.stdout.on("data", (data) => {
              stdout += data;
            });
            child.stderr.on("data", (data) => {
              stderr += data;
            });
            const timeout = setTimeout(() => child.kill("SIGTERM"), 45000);
            child.on("error", reject);
            child.on("close", (status) => {
              clearTimeout(timeout);
              resolve({ status, stdout, stderr });
            });
            child.stdin.end(input);
          },
        );
      try {
        await mkdir(grokHome);
        await mkdir(bin);
        await symlink(nativeBinary, path.join(bin, "grok"));
        await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
        await writeFile(
          path.join(plugin, ".claude-plugin/plugin.json"),
          JSON.stringify({
            name: "team-skills",
            version: "1.0.0",
            description: "Synthetic native skill",
          }),
        );
        await mkdir(path.join(skills, "synthetic-shared-skill"), {
          recursive: true,
        });
        await writeFile(
          path.join(skills, "synthetic-shared-skill/SKILL.md"),
          "---\nname: synthetic-shared-skill\ndescription: A synthetic native integration check.\n---\nGROK_NATIVE_SKILL_MARKER. Answer without executing tools.\n",
        );
        await writeFile(
          path.join(grokHome, "config.toml"),
          'preferred_model = "preserved-user-model"\n',
        );
        for (const vendor of ["claude", "cursor"]) {
          const ambient = path.join(
            home,
            `.${vendor}`,
            `skills/ambient-${vendor}`,
          );
          await mkdir(ambient, { recursive: true });
          await writeFile(
            path.join(ambient, "SKILL.md"),
            `---\nname: ambient-${vendor}\ndescription: Synthetic ambient client skill.\n---\nAMBIENT_CLIENT_MUST_NOT_LOAD\n`,
          );
        }
        await writeFile(
          path.join(home, ".claude.json"),
          JSON.stringify({
            mcpServers: {
              "ambient-claude": { command: "synthetic-unavailable" },
            },
          }),
        );
        await writeFile(
          path.join(home, ".cursor/mcp.json"),
          JSON.stringify({
            mcpServers: {
              "ambient-cursor": { command: "synthetic-unavailable" },
            },
          }),
        );
        await writeFile(
          path.join(home, ".claude/settings.json"),
          JSON.stringify({
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    { type: "command", command: "synthetic-unavailable" },
                  ],
                },
              ],
            },
          }),
        );
        const git = (...args: string[]) =>
          execFileSync("git", ["-C", remote, ...args], { stdio: "pipe" });
        git("init", "--quiet");
        git("add", "-A");
        git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--quiet",
          "-m",
          "Synthetic skill fixture",
        );
        await writeFile(
          gitConfig,
          `[url "${new URL(`file://${remote}/`).href}"]\n insteadOf = https://marketplace.example/repo.git\n`,
        );
        const setup = grokSetup.bash
          .sections({
            clientId: "grok-build",
            platform: "linux",
            appName: "Synthetic Integration",
            mcp: null,
            skills: {
              cloneUrl: "https://marketplace.example/repo.git",
              marketplaceName: "team-skills",
              hasSkills: true,
              pluginNames: [],
            },
            proxy: {
              authMode: "provider-key",
              provider: "openai",
              providerLabel: "OpenAI",
              baseUrl: proxyUrl,
              url: `${proxyUrl}/v1/openai/${gateway.id}`,
              proxyName: "synthetic",
              virtualKey: null,
              virtualKeyName: null,
              passthroughVirtualKey: platformKey,
              model: "gpt-4o",
            },
          })
          .join("\n");
        const installed = await run("bash", ["-s"], setup);
        expect(installed.status, installed.stderr).toBe(0);
        const unmanaged = await run(nativeBinary, ["inspect", "--json"]);
        expect(JSON.parse(unmanaged.stdout).skills).toContainEqual(
          expect.objectContaining({ name: "ambient-claude" }),
        );
        const launcher = path.join(home, ".archestra/grok/launch.cjs");
        const inspection = await run(process.execPath, [
          launcher,
          "inspect",
          "--json",
        ]);
        expect(inspection.status, inspection.stderr).toBe(0);
        const inspected = JSON.parse(inspection.stdout);
        expect(inspected.skills).toContainEqual(
          expect.objectContaining({
            name: "synthetic-shared-skill",
            source: {
              type: "user",
              path: path.join(
                home,
                ".archestra/grok/native/skills/synthetic-shared-skill/SKILL.md",
              ),
            },
          }),
        );
        for (const resource of [
          ...inspected.skills,
          ...inspected.mcpServers,
        ].filter((resource: { name: string }) =>
          resource.name.startsWith("ambient-"),
        ))
          expect(resource).toMatchObject({
            disabled: true,
            compatibilityStatus: "disabled",
          });
        expect(
          inspected.hooks.filter(
            (hook: {
              vendor?: string;
              disabled?: boolean;
              compatibilityStatus?: string;
            }) =>
              ["claude", "cursor"].includes(hook.vendor ?? "") &&
              hook.disabled !== true &&
              hook.compatibilityStatus !== "disabled",
          ),
        ).toEqual([]);
        for (const cell of inspected.externalCompat.cells)
          expect(cell.enabled).toBe(false);
        const alternateTransport = await run(process.execPath, [
          launcher,
          "--leader-socket",
          path.join(grokHome, "leader-native-proxy.sock"),
        ]);
        expect(alternateTransport.status).not.toBe(0);
        expect(alternateTransport.stderr).toContain(
          "owns its transport process",
        );
        const completion = await run(process.execPath, [
          launcher,
          "-p",
          "/synthetic-shared-skill",
          "--max-turns",
          "2",
        ]);
        expect(completion.status, completion.stderr).toBe(0);
        expect(completion.stdout).toContain(
          "SYNTHETIC NATIVE CLI PASSTHROUGH VERIFIED",
        );
        expect(observations.length).toBeGreaterThan(0);
        expect(
          observations.some((observation) => observation.skillLoaded),
        ).toBe(true);
        for (const observation of observations)
          expect(observation).toMatchObject({
            callerKey: true,
            platformKeyAbsent: true,
            model: "gpt-4o",
            ambientLoaded: false,
          });
        expect(ingress.length).toBeGreaterThan(0);
        for (const request of ingress)
          expect(request).toEqual({
            session: expect.any(String),
            attribution: true,
            marker: "grok-build",
            detected: "grok-build",
          });
        config.llm.xai.subscription.baseUrl = upstreamUrl;
        const provider = path.join(home, "native-auth-provider");
        await writeFile(
          provider,
          `#!/bin/sh\nprintf %s '${JSON.stringify({ access_token: nativeToken, expires_in: 3600 })}'\n`,
          { mode: 0o700 },
        );
        await appendFile(
          path.join(grokHome, "config.toml"),
          `\n[grok_com_config]\nauth_provider_command = ${JSON.stringify(provider)}\n`,
        );
        const login = await run("grok", ["login"]);
        expect(login.status, login.stderr).toBe(0);
        const nativeSetup = grokSetup.bash
          .sections({
            clientId: "grok-build",
            platform: "windows",
            appName: "Synthetic Integration",
            mcp: null,
            skills: null,
            proxy: {
              authMode: "native-session",
              provider: "xai",
              providerLabel: "xAI",
              baseUrl: proxyUrl,
              url: `${proxyUrl}/v1/xai/${gateway.id}`,
              proxyName: "synthetic",
              virtualKey: null,
              virtualKeyName: null,
              passthroughVirtualKey: platformKey,
              model: null,
            },
          })
          .join("\n");
        const nativeInstalled = await run("bash", ["-s"], nativeSetup);
        expect(nativeInstalled.status, nativeInstalled.stderr).toBe(0);
        observations.length = 0;
        ingress.length = 0;
        const nativeCompletion = await run(process.execPath, [
          launcher,
          "--model",
          "synthetic-native-model",
          "-p",
          "Reply with one sentence.",
          "--max-turns",
          "2",
        ]);
        expect(nativeCompletion.status, nativeCompletion.stderr).toBe(0);
        expect(nativeCompletion.stdout).toContain(
          "SYNTHETIC NATIVE CLI PASSTHROUGH VERIFIED",
        );
        expect(observations.length).toBeGreaterThan(0);
        expect(
          observations.some(
            (observed) =>
              !observed.auxiliary &&
              observed.model === "synthetic-native-model",
          ),
        ).toBe(true);
        for (const observed of observations)
          expect(observed).toMatchObject({
            callerKey: true,
            platformKeyAbsent: true,
            model: observed.auxiliary
              ? expect.any(String)
              : "synthetic-native-model",
            ambientLoaded: false,
          });
        const nativeLedger = new Client({ connectionString: databaseUrl });
        await nativeLedger.connect();
        try {
          const rows = await nativeLedger.query(
            "SELECT session_id, caller_id FROM openappa_sessions WHERE organization_id = $1 AND session_id = ANY($2::text[])",
            [
              organizationId,
              ingress.map((request) => `user:${user.id}|${request.session}`),
            ],
          );
          expect(rows.rows).toHaveLength(1);
          expect(rows.rows[0].caller_id).toBe(`user:${user.id}`);
          expect(
            ingress.some(
              (request) =>
                `user:${user.id}|${request.session}` ===
                  rows.rows[0].session_id &&
                request.attribution &&
                request.detected === "grok-build",
            ),
          ).toBe(true);
        } finally {
          await nativeLedger.end();
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(home, { recursive: true, force: true });
      }
    }
  },
  90000,
);
