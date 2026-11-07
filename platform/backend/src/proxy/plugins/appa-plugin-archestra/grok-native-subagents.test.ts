// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import * as native from "@archestra/openappa-rs";
import { Client } from "pg";
import { expect, test, vi } from "vitest";
import config from "@/config";
import * as database from "@/database";
import {
  collectAndStripChildReturns,
  mintChildReturnMarker,
} from "@/openappa/child-return";
import {
  collectDelegationMarkers,
  mintDelegationMarker,
} from "@/openappa/delegation";
import { grokChildResumeSuffix } from "@/openappa/grok-child-resume";
import type { OpenAppaSession } from "@/openappa/service";
import { stripChildTrajectoryReceiptsFromRequest } from "@/openappa/wire";
import { asRecord } from "@/utils/as-record";
import { AppaGrokAdapter } from "./adapters/grok";

// Only the model is synthetic. The official CLI executes the spawn, file read
// and background retrieval; production adapters and the real native ledger
// bind the child, lower its trust and admit its schema-checked return.
for (const [background, resume, delivery] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
  [false, false, "steer"],
  [false, false, "queue"],
  [false, false, "interject"],
] as const) {
  test.skipIf(
    !process.env.ARCHESTRA_GROK_TEST_BINARY ||
      !process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL,
  )(
    `official Grok ${background ? "background" : "foreground"} ${delivery ? `message ${delivery}` : resume ? "resume" : "child"} preserves restrictions and returns only its attested value`,
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "grok-protected-child-"));
      const authPath = path.join(home, "synthetic-auth.json");
      await mkdir(path.join(home, "native"));
      const source = path.join(home, "synthetic-source.txt");
      await writeFile(
        source,
        "SYNTHETIC_UNTRUSTED_INSTRUCTION; the answer is 7.",
      );
      const clientId = "b1a00492-073a-47ea-816f-4c329264a828";
      await writeFile(
        authPath,
        JSON.stringify({
          [`https://auth.x.ai::${clientId}`]: {
            key: "synthetic-native-access",
            auth_mode: "oidc",
            oidc_issuer: "https://auth.x.ai",
            oidc_client_id: clientId,
            user_id: "synthetic",
            expires_at: "2099-01-01T00:00:00Z",
            create_time: new Date().toISOString(),
          },
        }),
      );
      await native.initializeOpenappa(
        process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL as string,
        4,
      );
      const databaseSource = vi
        .spyOn(database, "getDatabaseConnectionString")
        .mockReturnValue(
          process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL as string,
        );
      config.openappa.offerSigningSecret =
        "synthetic-grok-child-secret-for-tests";
      const policy = {
        content: `[policy]
version = 2
[[policy.tool]]
name = "host/archestra/Agent"
delta = {}
[[policy.tool]]
name = "host/archestra/SendMessage"
delta = {}
[[policy.tool]]
name = "host/archestra/read_file"
delta = { trust = "suspicious", audience = ["synthetic-private"] }
[[policy.tool]]
name = "host/archestra/publish_probe"
delta = {}
requires = { trust = "trusted" }
[[policy.tool]]
name = "host/archestra/public_probe"
delta = {}
requires = { audience = { contains = ["public"] } }
[[policy.sanitizer]]
name = "attest-schema"
on = ["tool_output"]
[policy.sanitizer.permits]
trust = { from = "suspicious", to = "trusted" }
[policy.deployment]
context_control = true
`,
        credentials: {},
      };
      const presentation = {
        control_tool: "archestra__execute_remedy_plan",
        supports_delegation: true,
      };
      const organization = `grok-child-${randomUUID()}`;
      const ledger = new Client({
        connectionString: process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL,
      });
      await ledger.connect();
      try {
        await ledger.query(
          "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $1, $1, now())",
          [organization],
        );
      } finally {
        await ledger.end();
      }
      let parent: OpenAppaSession | undefined,
        childSession: OpenAppaSession | undefined;
      let childId: string | undefined,
        rootStage = 0,
        childStage = 0;
      let verifiedReturns = 0;
      let peerDeliveries = 0;
      let peerSends = 0;
      let resumedNativeId: string | undefined;
      const boundIds = new Map<string, string>();
      const failures: unknown[] = [];
      let runningCli: ReturnType<typeof spawn> | undefined;
      const adapter = new AppaGrokAdapter();
      const hook = async (session: OpenAppaSession, event: object) =>
        JSON.parse(
          await native.dispatchHook(
            JSON.stringify({ ...session, ...event }),
            policy,
          ),
        );
      const remedy = async (
        session: OpenAppaSession,
        callId: string,
        args: object,
      ) =>
        JSON.parse(
          await native.executeRemedyByOffer(
            JSON.stringify({
              organization_id: organization,
              caller_id: session.caller_id,
              trajectory: {
                v: 1,
                session_id: session.session_id,
                ...(session.parent_id ? { parent_id: session.parent_id } : {}),
              },
              execution_mode: "tracked",
              tool_call_id: callId,
              arguments: args,
              original_arguments: JSON.stringify(args),
              presentation,
            }),
            policy,
          ),
        );
      const functionCall = (id: string, name: string, args: object) => ({
        type: "function_call",
        id: `fc_${id}`,
        call_id: id,
        name,
        arguments: JSON.stringify(args),
        status: "completed",
      });
      const message = (text: string) => ({
        type: "message",
        id: "msg_synthetic",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      });
      const server = createServer(async (request, response) => {
        try {
          response.setHeader("Content-Type", "application/json");
          if (request.method === "GET") {
            if (request.url?.endsWith("/models"))
              response.end(
                JSON.stringify({
                  data: [
                    {
                      id: "synthetic",
                      model: "synthetic",
                      api_backend: "responses",
                      context_window: 200000,
                    },
                  ],
                  default_model: "synthetic",
                }),
              );
            else if (request.url?.endsWith("/settings"))
              response.end('{"default_model":"synthetic"}');
            else response.writeHead(404).end();
            return;
          }
          let raw = "";
          for await (const chunk of request) raw += chunk;
          const body = JSON.parse(raw);
          const sid = String(request.headers["x-grok-session-id"] ?? "");
          const primary = !String(
            request.headers["x-grok-conv-id"] ?? "",
          ).startsWith("turn-summary-");
          let output: object[] = [message("Synthetic complete.")];
          if (sid && !parent) {
            parent = {
              organization_id: organization,
              caller_id: "user:synthetic",
              session_id: sid,
            };
            expect(
              (await hook(parent, { event: "session_start" })).decision,
            ).toBe("ack");
            const declared = await remedy(parent, "declare-return", {
              label: { audience: ["synthetic-private"] },
              return_schema: {
                type: "object",
                properties: {
                  answer: { type: "integer", minimum: 0, maximum: 10 },
                },
                required: ["answer"],
              },
            });
            expect(declared.result?.isError, JSON.stringify(declared)).toBe(
              false,
            );
          }
          if (primary && sid && parent && sid === parent.session_id) {
            const returns = collectAndStripChildReturns(body, {
              grokSubagentReturns: true,
            });
            for (const completion of returns.completions) {
              expect(completion.value).toBe('{"answer":7}');
              expect(boundIds.has(completion.childNativeId ?? "")).toBe(true);
              if (!childSession) throw new Error("No protected child");
              const checked = await hook(parent, {
                event: "tool_result",
                tool_call_id: "spawn-one",
                spawned_id: childSession.session_id,
                output: completion.value,
                outcome: "success",
              });
              expect(["ack", "replace_output"]).toContain(checked.decision);
              verifiedReturns++;
            }
            if (rootStage === 0) {
              rootStage++;
              const args = {
                prompt:
                  "Read the synthetic source and return the answer as JSON.",
                description: "Synthetic child",
                background,
              };
              const allowed = await hook(parent, {
                event: "tool_call",
                operation_id: "call:spawn-one",
                tool: "Agent",
                arguments: args,
                spawn: true,
                presentation,
              });
              expect(allowed.decision, JSON.stringify(allowed)).toBe(
                "allow_call",
              );
              const marker = mintDelegationMarker({
                organizationId: organization,
                callerId: parent.caller_id,
                parentId: sid,
                spawnerNativeId: sid,
                prompt: args.prompt,
                spawnCallId: "spawn-one",
              });
              output = [
                functionCall("spawn-one", "spawn_subagent", {
                  ...args,
                  prompt: `${args.prompt}\n\n${marker}`,
                }),
              ];
            } else if (
              (background && rootStage === 1) ||
              ((background || delivery) && rootStage === 3)
            ) {
              const resumedWait = rootStage === 3;
              rootStage++;
              const launch = (body.input as Array<{ output?: string }>)
                .filter((item) => item.output?.includes('"state":"running"'))
                .at(-1);
              const status =
                launch && asRecord(JSON.parse(launch.output as string).status);
              const id = Object.keys(status ?? {})[0] ?? childId;
              if (!id) throw new Error("Missing background child identity");
              output = [
                functionCall(
                  resumedWait ? "wait-resume" : "wait-one",
                  "get_command_or_subagent_output",
                  {
                    task_ids: [id],
                    // A one-second poll can expire before the native background
                    // process starts under parallel test load. Wait for the
                    // result instead of treating that timeout as completion.
                    timeout_ms: 10000,
                  },
                ),
              ];
            } else if (delivery && rootStage < 3) {
              rootStage = 3;
              if (!childSession || !childId)
                throw new Error("No message target");
              expect(
                body.tools.some(
                  (tool: { name: string }) =>
                    tool.name === "send_subagent_message",
                ),
              ).toBe(true);
              const args = {
                subagent_id: childId,
                text: `NATIVE_PEER_${delivery}`,
                delivery,
              };
              const allowed = await hook(parent, {
                event: "tool_call",
                operation_id: "call:peer-one",
                tool: "SendMessage",
                arguments: args,
                presentation,
              });
              expect(allowed.decision, JSON.stringify(allowed)).toBe(
                "allow_call",
              );
              const send = {
                ...parent,
                operation_id: "peer_send:peer-one",
                recipient_session_id: childSession.session_id,
                recipient_parent_id: parent.session_id,
                recipient_native_id: childId,
                value: args.text,
              };
              const released = JSON.parse(
                await native.sendPeerMessage(JSON.stringify(send), policy),
              );
              expect(released.kind, JSON.stringify(released)).toBe("released");
              expect(
                JSON.parse(
                  await native.sendPeerMessage(JSON.stringify(send), policy),
                ),
              ).toEqual(released);
              expect(
                JSON.parse(
                  await native.sendPeerMessage(
                    JSON.stringify({ ...send, value: "CHANGED" }),
                    policy,
                  ),
                ).kind,
              ).toBe("denied");
              const wire = adapter.rewriteRelayMessage(
                args,
                `${args.text}\n\n[appa] peer message appapm1-${released.message_id}.`,
                { senderSessionId: parent.session_id },
              );
              output = [
                functionCall(
                  "peer-one",
                  "send_subagent_message",
                  JSON.parse(wire),
                ),
              ];
              peerSends++;
            } else if (resume && rootStage < 3) {
              rootStage = 3;
              if (!childId) throw new Error("No resume source");
              const args = {
                prompt: "Continue and return the same bounded JSON answer.",
                description: "Synthetic resume",
                resume_from: childId,
                background,
              };
              expect(
                adapter.isSpawnTool("spawn_subagent", undefined, args),
              ).toBe(false);
              const allowed = await hook(parent, {
                event: "tool_call",
                operation_id: "call:resume-one",
                tool: "Agent",
                arguments: args,
                presentation,
              });
              expect(allowed.decision, JSON.stringify(allowed)).toBe(
                "allow_call",
              );
              for (const unbound of [
                { session: parent, sourceNativeId: randomUUID() },
                {
                  session: { ...parent, session_id: randomUUID() },
                  sourceNativeId: childId,
                },
                {
                  session: {
                    ...parent,
                    organization_id: `foreign-${organization}`,
                  },
                  sourceNativeId: childId,
                },
              ])
                await expect(
                  grokChildResumeSuffix(
                    {
                      ...unbound,
                      callId: "foreign-source",
                      spawnerNativeId: sid,
                      prompt: args.prompt,
                    },
                    policy,
                  ),
                ).rejects.toThrow("could not verify");
              const appended = await grokChildResumeSuffix(
                {
                  session: parent,
                  callId: "resume-one",
                  sourceNativeId: childId,
                  spawnerNativeId: sid,
                  prompt: args.prompt,
                },
                policy,
              );
              output = [
                functionCall("resume-one", "spawn_subagent", {
                  ...args,
                  prompt: args.prompt + appended,
                }),
              ];
            } else {
              expect(verifiedReturns).toBeGreaterThan(0);
              if (resume) {
                expect(resumedNativeId).toBeTruthy();
                expect(
                  returns.completions.some(
                    (entry) => entry.childNativeId === resumedNativeId,
                  ),
                ).toBe(true);
              }
              const status = await native.getOpenappaStatus(
                organization,
                parent.session_id,
                policy,
              );
              expect(status?.trust).toBe("trusted");
              expect(JSON.stringify(body)).not.toContain(
                "SYNTHETIC_UNTRUSTED_INSTRUCTION",
              );
            }
          } else if (primary && sid && parent) {
            if (!childSession || sid !== childId) {
              const previousActor = childSession?.session_id;
              if (previousActor) resumedNativeId = sid;
              childId = sid;
              const receipts = stripChildTrajectoryReceiptsFromRequest({
                family: "openai:responses",
                body,
              });
              const bound = adapter.bindChildTrajectory({
                headers: request.headers,
                requestBody: body,
                trustedContext: {
                  session: { ...parent, session_id: sid },
                  profileId: "synthetic",
                  toolIdentity: {
                    canonicalize: (name) => name,
                    attestationOf: () => undefined,
                    looseRunToolDispatch: false,
                  },
                  request: {
                    tools: undefined,
                    session: {},
                    customTools: new Set(),
                    declaredTools: [],
                    childTrajectoryReceipts: receipts,
                    delegation: {
                      markers: collectDelegationMarkers({
                        family: "openai:responses",
                        body,
                      }),
                    },
                  },
                },
              });
              if (!bound) throw new Error("Child was not bound");
              if (previousActor) expect(bound.sessionId).toBe(previousActor);
              boundIds.set(sid, bound.sessionId);
              childSession = {
                ...parent,
                session_id: bound.sessionId,
                parent_id: bound.parentId,
              };
              const start = await hook(childSession, {
                event: "session_start",
                spawn_call_id: bound.lineage?.spawnCallId,
                child_native_id: sid,
              });
              expect(["context", "ack"]).toContain(start.decision);
            }
            for (const arrival of adapter.relayArrivals(body)) {
              expect(arrival.peer).not.toBe("malformed");
              if (!arrival.peer || arrival.peer === "malformed")
                throw new Error("Missing protected arrival");
              expect(arrival.senderSessionId).toBe(parent.session_id);
              const checked = JSON.parse(
                await native.admitPeerMessage(
                  JSON.stringify({
                    ...childSession,
                    message_id: arrival.peer.messageId,
                    sender_session_id: arrival.senderSessionId,
                    value: arrival.peer.value,
                  }),
                  policy,
                ),
              );
              expect(checked.kind, JSON.stringify(checked)).toBe("admitted");
              expect(checked.value).toBe(`NATIVE_PEER_${delivery}`);
              arrival.replace(checked.value);
              peerDeliveries++;
            }
            if (delivery)
              expect(JSON.stringify(body)).not.toContain("[appa-peer-v1]");
            if (childStage++ === 0) {
              const call = {
                event: "tool_call",
                operation_id: "call:read-one",
                tool: "read_file",
                arguments: { target_file: source },
                presentation,
              };
              const held = await hook(childSession, call);
              expect(held.decision, JSON.stringify(held)).toBe("deny_call");
              const accepted = await remedy(childSession, "accept-read", {
                offer_id: held.offers[0].offer_id,
                label: { audience: ["synthetic-private"] },
              });
              expect(accepted.result?.isError).toBe(false);
              expect(
                (
                  await hook(childSession, {
                    ...call,
                    operation_id: "call:read-two",
                  })
                ).decision,
              ).toBe("allow_call");
              output = [
                functionCall("read-two", "read_file", { target_file: source }),
              ];
            } else {
              const read = (
                body.input as Array<{
                  type?: string;
                  call_id?: string;
                  output?: string;
                }>
              ).find(
                (item) =>
                  item.type === "function_call_output" &&
                  item.call_id === "read-two",
              );
              expect(read?.output).toContain("SYNTHETIC_UNTRUSTED_INSTRUCTION");
              const readResult = await hook(childSession, {
                event: "tool_result",
                tool_call_id: "read-two",
                output: read?.output,
                outcome: "success",
              });
              expect(readResult.decision, JSON.stringify(readResult)).toBe(
                "ack",
              );
              const childPublish = await hook(childSession, {
                event: "tool_call",
                operation_id: "call:child-publish",
                tool: "publish_probe",
                arguments: {},
                presentation,
              });
              expect(childPublish.decision, JSON.stringify(childPublish)).toBe(
                "deny_call",
              );
              const publicPublish = await hook(childSession, {
                event: "tool_call",
                operation_id: "call:child-public",
                tool: "public_probe",
                arguments: {},
                presentation,
              });
              expect(
                publicPublish.decision,
                JSON.stringify(publicPublish),
              ).toBe("deny_call");
              const value = '{"answer":7}';
              const end = await hook(childSession, {
                event: "child_end",
                operation_id: `child_end:${sid}:${childStage}`,
                spawn_call_id: "spawn-one",
                child_native_id: sid,
                output: value,
              });
              expect(end.decision, JSON.stringify(end)).toBe("ack");
              const marker = mintChildReturnMarker({
                organizationId: organization,
                callerId: parent.caller_id,
                parentId: parent.session_id,
                childId: childSession.session_id,
                childNativeId: sid,
                spawnCallId: "spawn-one",
                value,
              });
              output = [message(`${value}\n\n${marker}`)];
            }
          }
          response.setHeader("Content-Type", "text/event-stream");
          response.end(
            `event: response.completed\ndata: ${JSON.stringify({
              type: "response.completed",
              sequence_number: 1,
              response: {
                id: "resp_synthetic",
                object: "response",
                created_at: 1,
                model: body.model,
                status: "completed",
                output,
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
        } catch (error) {
          failures.push(error);
          runningCli?.kill("SIGTERM");
          response
            .writeHead(502)
            .end("Synthetic fixture rejected an invalid flow.");
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address() as { port: number };
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^(GROK_|XAI_)/.test(key),
          ),
        );
        Object.assign(env, {
          HOME: home,
          GROK_HOME: path.join(home, "native"),
          GROK_AUTH_PATH: authPath,
          GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${address.port}`,
          GROK_DISABLE_AUTOUPDATER: "1",
          ...(delivery ? { GROK_ACTIVE_AGENT_MESSAGES: "1" } : {}),
          GROK_TELEMETRY_ENABLED: "0",
          GROK_DISABLE_API_KEY_AUTH: "1",
          NO_PROXY: "127.0.0.1",
        });
        const result = await new Promise<{
          code: number | null;
          stderr: string;
        }>((resolve, reject) => {
          const childProcess = spawn(
            process.env.ARCHESTRA_GROK_TEST_BINARY as string,
            [
              "--permission-mode=bypassPermissions",
              "-m",
              "synthetic",
              "-p",
              "Synthetic protected child fixture.",
              "--output-format=json",
              "--max-turns",
              "6",
            ],
            { cwd: home, env, stdio: ["ignore", "ignore", "pipe"] },
          );
          runningCli = childProcess;
          let stderr = "";
          childProcess.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          const timer = setTimeout(() => childProcess.kill("SIGKILL"), 45000);
          childProcess.once("error", reject);
          childProcess.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stderr });
          });
        });
        expect(
          failures.map((error) =>
            error instanceof Error ? error.stack : error,
          ),
        ).toEqual([]);
        expect(result.code, result.stderr.slice(-1500)).toBe(0);
        expect(verifiedReturns).toBeGreaterThan(0);
        if (delivery) {
          expect(peerSends).toBe(1);
          expect(peerDeliveries).toBeGreaterThan(0);
          expect(boundIds.size).toBe(1);
        }
      } finally {
        databaseSource.mockRestore();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
      }
    },
    60000,
  );
}
