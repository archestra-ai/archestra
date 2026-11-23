import { vi } from "vitest";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import { AgentModel, AgentRuntimeUserAccountModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent, AgentRuntime, User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import {
  accountAudits,
  buildAccountTestApp,
  makeKeyWithModel,
  runtimeFor,
} from "./agent-runtime-account.test-helpers";

vi.mock("@/observability");

describe("DELETE /api/agents/:id/runtime/account", () => {
  const ctx = {} as { user: User; organizationId: string };
  let app: FastifyInstanceWithZod;
  let agent: Agent;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    ctx.organizationId = (await makeOrganization()).id;
    ctx.user = await makeUser();
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({ inferenceProtocol: "openai_responses" }),
    });
    app = await buildAccountTestApp(ctx);
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
  });

  const clear = () =>
    app.inject({
      method: "DELETE",
      url: `/api/agents/${agent.id}/runtime/account`,
    });

  test("forgets only the caller's choice and audits it once", async ({
    makeMember,
    makeUser,
  }) => {
    const { key, model } = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const colleague = await makeUser();
    await makeMember(colleague.id, ctx.organizationId, { role: "member" });
    // The agent sets nothing: each of them picked the connection and model.
    const choice = {
      authentication: "provider" as const,
      llmApiKeyId: key.id,
      modelId: model.id,
    };
    for (const userId of [ctx.user.id, colleague.id]) {
      await AgentRuntimeUserAccountModel.upsert({
        agentId: agent.id,
        userId,
        ...choice,
      });
    }

    const cleared = await clear();
    const again = await clear();
    await drainBackgroundWork();

    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({
      agentAccount: { authentication: "provider" },
      choice: null,
    });
    expect(again.statusCode).toBe(200);
    expect(
      await AgentRuntimeUserAccountModel.find({
        agentId: agent.id,
        userId: ctx.user.id,
      }),
    ).toBeNull();
    expect(
      await AgentRuntimeUserAccountModel.find({
        agentId: agent.id,
        userId: colleague.id,
      }),
    ).toMatchObject(choice);
    expect(await accountAudits(agent.id)).toEqual([
      {
        action: "agent.updated",
        actorId: ctx.user.id,
        httpMethod: "DELETE",
        before: { runtimeAccountChoice: { ...choice, claudeModel: null } },
        after: { runtimeAccountChoice: null },
      },
    ]);
  });

  test("forgets a choice on a locked agent", async () => {
    const { key, model } = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    await AgentModel.update(agent.id, {
      llmApiKeyId: key.id,
      modelId: model.id,
      runtime: { ...(agent.runtime as AgentRuntime), accountLock: "key" },
    });
    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: ctx.user.id,
      authentication: "provider",
      modelId: null,
    });

    const cleared = await clear();

    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ lock: "key", choice: null });
    expect(
      await AgentRuntimeUserAccountModel.find({
        agentId: agent.id,
        userId: ctx.user.id,
      }),
    ).toBeNull();
  });

  test("refuses a service account, which has no runs of its own", async ({
    makeServiceAccountToken,
  }) => {
    const { serviceAccount } = await makeServiceAccountToken({
      organizationId: ctx.organizationId,
      role: "admin",
    });
    ctx.user = { ...ctx.user, id: serviceAccountUserId(serviceAccount.id) };

    const refused = await clear();

    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(
      "Only a signed-in person can choose an account for their own runs.",
    );
  });
});
