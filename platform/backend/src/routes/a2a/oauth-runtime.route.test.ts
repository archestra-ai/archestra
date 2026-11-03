import {
  AGENT_TOOL_PREFIX,
  OAUTH_CLIENT_REFERENCE_PREFIX,
  OAUTH_TOKEN_ID_PREFIX,
  slugify,
  TOOL_STEER_AGENT_RUN_FULL_NAME,
} from "@archestra/shared";
import { afterEach, describe, vi } from "vitest";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import { A2AProtocolRole } from "@/agents/a2a/a2a-protocol";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { requireActor, startDelegatedTask } from "@/archestra-mcp-server/tasks";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import { createFastifyInstance } from "@/fastify-instance";
import {
  A2AContextModel,
  A2AMessageModel,
  A2ATaskModel,
  AgentToolModel,
  ManagedOauthClientModel,
  OAuthAccessTokenModel,
  ToolModel,
} from "@/models";
import {
  authorizeA2AOAuthExecution,
  validateMCPGatewayToken,
} from "@/routes/mcp-gateway/utils";
import * as runtimeBackends from "@/services/agent-runtime/backends";
import * as runtimeExecution from "@/services/agent-runtime/pod-run";
import { beforeEach, expect, test } from "@/test";
import type { Agent } from "@/types";
import a2aV2Routes from "./v2";

for (const bound of [false, true]) {
  describe(`${bound ? "bound" : "unbound"} OAuth runtime execution`, () => {
    let agent: Agent;
    let bearer: string;
    let userId: string;
    let execution: {
      tokenId: string;
      clientId: string;
      serviceAccountId?: string;
    };
    let contextsBefore: number;
    let messagesBefore: number;

    beforeEach(
      async ({
        makeOrganization,
        makeUser,
        makeMember,
        makeInternalAgent,
        makeServiceAccount,
      }) => {
        const org = await makeOrganization();
        const user = await makeUser();
        userId = user.id;
        await makeMember(user.id, org.id, { role: "admin" });
        const account = bound
          ? await makeServiceAccount(org.id, { role: "admin" })
          : undefined;
        agent = await makeInternalAgent({
          organizationId: org.id,
          runtime: {
            image: "example.invalid/oauth-runtime:test",
            command: null,
            inferenceProtocol: "openai_responses",
            backend: "kubernetes",
            steerMode: "pipe",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            idleTimeoutMinutes: null,
          },
        });
        const { oauthClient } = await ManagedOauthClientModel.create({
          organizationId: org.id,
          authorId: user.id,
          name: "Synthetic runtime application",
          grantType: "client_credentials",
          scopes: ["a2a"],
          serviceAccountId: account?.id,
          allowedGatewayIds: [agent.id],
        });
        bearer = crypto.randomUUID();
        const token = await OAuthAccessTokenModel.createClientCredentialsToken({
          tokenHash: OAuthAccessTokenModel.hashTokenForLookup(bearer),
          clientId: oauthClient.clientId,
          expiresAt: new Date(Date.now() + 60_000),
          scopes: ["a2a"],
          referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
        });
        execution = {
          tokenId: `${OAUTH_TOKEN_ID_PREFIX}${token.id}`,
          clientId: oauthClient.clientId,
          serviceAccountId: account?.id,
        };
        contextsBefore = await A2AContextModel.getTotalCount();
        messagesBefore = await A2AMessageModel.getTotalCount();
        vi.spyOn(
          runtimeBackends,
          "prepareAgentRuntimeBackendDriver",
        ).mockRejectedValue(
          new Error("Unexpected runtime backend preparation"),
        );
        vi.spyOn(runtimeExecution, "runTaskInAgentRuntime").mockRejectedValue(
          new Error("Unexpected runtime execution"),
        );
      },
    );

    afterEach(() => vi.restoreAllMocks());

    for (const mode of ["blocking", "detached", "streaming"] as const) {
      test(`refuses ${mode} A2A before task persistence or runtime credentials`, async () => {
        const app = createFastifyInstance();
        await app.register(a2aV2Routes);
        try {
          const response = await app.inject({
            method: "POST",
            url: `/v2/a2a/${agent.id}`,
            headers: { authorization: `Bearer ${bearer}` },
            payload: {
              jsonrpc: "2.0",
              id: 1,
              method:
                mode === "streaming" ? "SendStreamingMessage" : "SendMessage",
              params: {
                message: {
                  messageId: crypto.randomUUID(),
                  role: "ROLE_USER",
                  parts: [{ text: "Run the task." }],
                },
                configuration: { returnImmediately: mode === "detached" },
              },
            },
          });
          expect(response.headers["content-type"]).not.toContain(
            "text/event-stream",
          );
          expect(response.json().error, response.body).toMatchObject({
            code: -32004,
            message: expect.stringContaining(
              "OAuth applications cannot use Agent Runtime",
            ),
          });
          expect(runtimeExecution.runTaskInAgentRuntime).not.toHaveBeenCalled();
          expect(
            runtimeBackends.prepareAgentRuntimeBackendDriver,
          ).not.toHaveBeenCalled();
          expect(await A2AContextModel.getTotalCount()).toBe(contextsBefore);
          expect(await A2AMessageModel.getTotalCount()).toBe(messagesBefore);
        } finally {
          await app.close();
        }
      });
    }

    if (!bound)
      test("preserves runtime execution for authorization-code user tokens", async () => {
        const { oauthClient } = await ManagedOauthClientModel.create({
          organizationId: agent.organizationId,
          authorId: userId,
          name: "Synthetic user app",
          grantType: "authorization_code",
          scopes: ["a2a"],
          redirectUris: ["https://example.com/callback"],
        });
        const userBearer = crypto.randomUUID();
        await OAuthAccessTokenModel.create({
          tokenHash: OAuthAccessTokenModel.hashTokenForLookup(userBearer),
          clientId: oauthClient.clientId,
          userId,
          expiresAt: new Date(Date.now() + 60000),
          scopes: ["a2a"],
        });
        const tokenAuth = await validateMCPGatewayToken(
          agent.id,
          userBearer,
          "a2a",
        );
        expect(tokenAuth).toMatchObject({
          userId,
          isUserToken: true,
          oauthClientId: oauthClient.clientId,
        });
        expect(
          requireActor({
            agent: { id: agent.id, name: agent.name },
            userId,
            organizationId: agent.organizationId,
            tokenAuth: tokenAuth ?? undefined,
          }),
        ).toEqual({
          id: userId,
          kind: "user",
          organizationId: agent.organizationId,
        });
        vi.mocked(runtimeExecution.runTaskInAgentRuntime).mockResolvedValue({
          messageId: crypto.randomUUID(),
          text: "User runtime completed",
          finishReason: "stop",
          responseUiMessage: {
            id: crypto.randomUUID(),
            role: "assistant",
            parts: [{ type: "text", text: "User runtime completed" }],
          },
        });
        const app = createFastifyInstance();
        await app.register(a2aV2Routes);
        try {
          const response = await app.inject({
            method: "POST",
            url: `/v2/a2a/${agent.id}`,
            headers: { authorization: `Bearer ${userBearer}` },
            payload: {
              jsonrpc: "2.0",
              id: 1,
              method: "SendMessage",
              params: {
                message: {
                  messageId: crypto.randomUUID(),
                  role: "ROLE_USER",
                  parts: [{ text: "Run task." }],
                },
              },
            },
          });
          expect(
            response.json().result?.task?.status?.state,
            response.body,
          ).toBe("TASK_STATE_COMPLETED");
          expect(runtimeExecution.runTaskInAgentRuntime).toHaveBeenCalledWith(
            expect.objectContaining({
              actor: {
                id: userId,
                kind: "user",
                organizationId: agent.organizationId,
              },
            }),
          );
          await startDelegatedTask({
            agentId: agent.id,
            message: "Run task.",
            context: {
              agent: { id: agent.id, name: agent.name },
              userId,
              organizationId: agent.organizationId,
              tokenAuth: tokenAuth ?? undefined,
            },
          });
          expect(
            runtimeBackends.prepareAgentRuntimeBackendDriver,
          ).toHaveBeenCalledOnce();
        } finally {
          await app.close();
        }
      });

    test("refuses an internal task resume before mutating task state or history", async () => {
      const manager = new A2AManager({ taskMode: "full" });
      const actor = await manager.resolveActorByMCPGatewayToken(
        agent.id,
        bearer,
      );
      const context = await A2AContextModel.create({
        actorKind: actor.kind,
        actorId: actor.id,
      });
      const task = await A2ATaskModel.create({
        contextId: context.id,
        agentId: agent.id,
        state: "TASK_STATE_INPUT_REQUIRED",
      });
      await expect(
        manager.sendMessage({
          actor,
          agentId: agent.id,
          request: {
            message: {
              messageId: crypto.randomUUID(),
              taskId: task.id,
              role: A2AProtocolRole.User,
              parts: [{ text: "Continue." }],
            },
          },
        }),
      ).rejects.toMatchObject({ code: -32004 });
      expect(await A2ATaskModel.findById(task.id)).toMatchObject({
        state: "TASK_STATE_INPUT_REQUIRED",
      });
      expect(await A2AMessageModel.getTotalCount()).toBe(messagesBefore);
      expect(runtimeExecution.runTaskInAgentRuntime).not.toHaveBeenCalled();
      expect(
        runtimeBackends.prepareAgentRuntimeBackendDriver,
      ).not.toHaveBeenCalled();
    });

    test("refuses both agent delegation and the explicit run tool before dropping OAuth identity", async ({
      makeInternalAgent,
    }) => {
      const parent = await makeInternalAgent({
        organizationId: agent.organizationId,
      });
      const tool = await ToolModel.findOrCreateDelegationTool(agent.id);
      await AgentToolModel.create(parent.id, tool.id);
      const tokenAuth = await authorizeA2AOAuthExecution({
        agentId: agent.id,
        organizationId: agent.organizationId,
        execution,
      });
      const context = {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: agent.organizationId,
        userId: execution.serviceAccountId
          ? serviceAccountUserId(execution.serviceAccountId)
          : "system",
        tokenAuth: { ...tokenAuth, oauthExecution: execution },
      };
      const delegated = await executeArchestraTool(
        `${AGENT_TOOL_PREFIX}${slugify(agent.name)}`,
        { message: "Run the task." },
        context,
      );
      expect(delegated).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringContaining(
              "OAuth applications cannot use Agent Runtime",
            ),
          },
        ],
      });
      const explicit = await startDelegatedTask({
        agentId: agent.id,
        message: "Run the task.",
        context,
      });
      expect(explicit).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringContaining(
              "OAuth applications cannot use Agent Runtime",
            ),
          },
        ],
      });
      for (const auth of [
        context.tokenAuth,
        { ...tokenAuth, oauthExecution: undefined },
      ]) {
        expect(() =>
          requireActor({ ...context, userId, tokenAuth: auth }),
        ).toThrow("OAuth applications cannot use Agent Runtime");
        const steer = await executeArchestraTool(
          TOOL_STEER_AGENT_RUN_FULL_NAME,
          { run_id: crypto.randomUUID(), message: "Continue." },
          { ...context, userId, tokenAuth: auth },
        );
        expect(steer.isError).toBe(true);
        expect(JSON.stringify(steer.content)).not.toContain("Run not found");
        const start = await startDelegatedTask({
          agentId: agent.id,
          message: "Start.",
          context: { ...context, userId, tokenAuth: auth },
        });
        expect(start).toMatchObject({
          isError: true,
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                "OAuth applications cannot use Agent Runtime",
              ),
            },
          ],
        });
      }
      expect(
        runtimeBackends.prepareAgentRuntimeBackendDriver,
      ).not.toHaveBeenCalled();
      expect(runtimeExecution.runTaskInAgentRuntime).not.toHaveBeenCalled();
      expect(await A2AContextModel.getTotalCount()).toBe(contextsBefore);
      expect(await A2AMessageModel.getTotalCount()).toBe(messagesBefore);
    });
  });
}
