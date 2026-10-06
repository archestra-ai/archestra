import { vi } from "vitest";
import config from "@/config";
import {
  A2ATaskModel,
  AgentRunModel,
  AgentTeamModel,
  AgentWorkspaceModel,
} from "@/models";
import ProcessedEmailModel from "@/models/processed-email";
import * as podRun from "@/services/agent-runtime/pod-run";
import { bindRuntimeEmailLaunch } from "@/services/agent-runtime/runtime-email-ingress";
import { afterEach, beforeEach, expect, test } from "@/test";
import type { AgentRuntime, IncomingEmail } from "@/types";
import { isTerminalA2ATaskState } from "@/types/a2a-task";
import { MAX_EMAIL_BODY_SIZE } from "./constants";
import { processIncomingEmail } from "./index";
import type { OutlookEmailProvider } from "./outlook-provider";

const runtime: AgentRuntime = {
  image: "example.invalid/runtime-agent:test",
  command: null,
  inferenceProtocol: "openai_responses",
  backend: "kubernetes",
  steerMode: "pipe",
  privileged: false,
  resources: null,
  environment: null,
  credentials: null,
  ttlHours: null,
  idleTimeoutMinutes: null,
};

type Launch = {
  taskId: string;
  resumeFromTaskId?: string;
  actorId: string;
  actorKind: string;
};

const launches: Launch[] = [];

test("oversized runtime email is refused before admission or launch", async () => {
  await expect(
    bindRuntimeEmailLaunch({
      session: {
        organization_id: "fixture-org",
        session_id: "fixture-session",
        caller_id: "user:fixture",
      },
      turn: {
        messageId: "oversized",
        mailbox: "agent@example.com",
        sourceSenderAddress: "user@example.com",
        threadId: "thread",
      },
      task: "x".repeat(MAX_EMAIL_BODY_SIZE + 1),
      attachments: [],
      stampSession: true,
    }),
  ).rejects.toThrow("size bound");
  expect(launches).toHaveLength(0);
});

function providerFor(agentId: string): OutlookEmailProvider {
  return {
    providerId: "outlook",
    extractPromptIdFromEmail: () => agentId,
  } as unknown as OutlookEmailProvider;
}

function email(params: {
  agentId: string;
  fromAddress: string;
  messageId: string;
  conversationId?: string;
}): IncomingEmail {
  return {
    messageId: params.messageId,
    conversationId: params.conversationId,
    toAddress: `agents+agent-${params.agentId}@example.com`,
    fromAddress: params.fromAddress,
    subject: "Follow up",
    body: `Body ${params.messageId}`,
    receivedAt: new Date(),
  };
}

beforeEach(() => {
  launches.length = 0;
  config.agentRuntime.enabled = true;
  vi.spyOn(podRun, "runTaskInAgentRuntime").mockImplementation(
    async (params) => {
      launches.push({
        taskId: params.taskId,
        resumeFromTaskId: params.resumeFromTaskId,
        actorId: params.actor.id,
        actorKind: params.actor.kind,
      });
      if (params.resumeFromTaskId) {
        const prior = await AgentRunModel.findByTaskId(params.resumeFromTaskId);
        const workspace = prior
          ? await AgentWorkspaceModel.findByWorkloadName(prior.workloadName)
          : null;
        if (
          !prior ||
          !workspace ||
          workspace.actorId !== params.actor.id ||
          workspace.actorKind !== params.actor.kind ||
          workspace.agentId !== params.agentId ||
          workspace.organizationId !== params.organizationId
        ) {
          throw new Error("refusing to resume another actor's workspace");
        }
        await AgentRunModel.create({
          organizationId: params.organizationId,
          agentId: params.agentId,
          taskId: params.taskId,
          actorKind: params.actor.kind,
          actorId: params.actor.id,
          actorUserId: params.actor.kind === "user" ? params.actor.id : null,
          backend: "kubernetes",
          runtimeScope: workspace.runtimeScope,
          workloadName: workspace.workloadName,
        });
        return completed();
      }
      const workloadName = `workspace-${params.taskId}`;
      await AgentRunModel.create({
        organizationId: params.organizationId,
        agentId: params.agentId,
        taskId: params.taskId,
        actorKind: params.actor.kind,
        actorId: params.actor.id,
        actorUserId: params.actor.kind === "user" ? params.actor.id : null,
        backend: "kubernetes",
        runtimeScope: "test",
        workloadName,
      });
      await AgentWorkspaceModel.create({
        id: params.taskId,
        organizationId: params.organizationId,
        agentId: params.agentId,
        actorKind: params.actor.kind,
        actorId: params.actor.id,
        backend: "kubernetes",
        runtimeScope: "test",
        workloadName,
        state: "idle",
        lastTaskId: params.taskId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      return completed();
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function completed() {
  const messageId = crypto.randomUUID();
  return {
    messageId,
    text: "done",
    finishReason: "stop" as const,
    responseUiMessage: {
      id: messageId,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "done" }],
    },
  };
}

async function settle(taskId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const task = await A2ATaskModel.findById(taskId);
    if (task && isTerminalA2ATaskState(task.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${taskId} did not settle`);
}

test("public mail reuses one workspace per sender and does not promote the sender to a user", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeTeam,
  makeInternalAgent,
}) => {
  const user = await makeUser({ email: "sender@example.com" });
  const org = await makeOrganization();
  await makeMember(user.id, org.id);
  const team = await makeTeam(org.id, user.id);
  const agent = await makeInternalAgent({
    organizationId: org.id,
    incomingEmailEnabled: true,
    incomingEmailSecurityMode: "public",
    runtime,
  });
  await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
  const provider = providerFor(agent.id);

  await processIncomingEmail(
    email({
      agentId: agent.id,
      fromAddress: "Sender@Example.com",
      messageId: "msg-1",
      conversationId: "conversation-1",
    }),
    provider,
  );
  await settle(launches[0].taskId);
  await processIncomingEmail(
    email({
      agentId: agent.id,
      fromAddress: "sender@example.com",
      messageId: "msg-2",
      conversationId: "conversation-1",
    }),
    provider,
  );
  await settle(launches[1].taskId);
  await processIncomingEmail(
    email({
      agentId: agent.id,
      fromAddress: "other@example.com",
      messageId: "msg-3",
      conversationId: "conversation-1",
    }),
    provider,
  );
  await settle(launches[2].taskId);

  expect(launches.map((launch) => launch.actorKind)).toEqual([
    "system",
    "system",
    "system",
  ]);
  expect(launches.every((launch) => launch.actorId === "system")).toBe(true);
  expect(launches[1]?.resumeFromTaskId).toBe(launches[0]?.taskId);
  expect(launches[2]?.resumeFromTaskId).toBeUndefined();
  const firstTask = await A2ATaskModel.findById(launches[0].taskId);
  const otherTask = await A2ATaskModel.findById(launches[2].taskId);
  expect(otherTask?.contextId).not.toBe(firstTask?.contextId);
  expect((await A2ATaskModel.findById(launches[1].taskId))?.contextId).toBe(
    firstTask?.contextId,
  );
});

test("mail without a conversation id continues only the same message", async ({
  makeOrganization,
  makeInternalAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({
    organizationId: org.id,
    incomingEmailEnabled: true,
    incomingEmailSecurityMode: "public",
    runtime,
  });
  const provider = providerFor(agent.id);
  await processIncomingEmail(
    email({
      agentId: agent.id,
      fromAddress: "sender@example.com",
      messageId: "solo-1",
    }),
    provider,
  );
  await settle(launches[0].taskId);
  await processIncomingEmail(
    email({
      agentId: agent.id,
      fromAddress: "sender@example.com",
      messageId: "solo-2",
    }),
    provider,
  );
  await settle(launches[1].taskId);
  expect(launches[1]?.resumeFromTaskId).toBeUndefined();

  await ProcessedEmailModel.deleteByMessageId("solo-1");
  await processIncomingEmail(
    email({
      agentId: agent.id,
      fromAddress: "sender@example.com",
      messageId: "solo-1",
    }),
    provider,
  );
  await settle(launches[2].taskId);
  expect(launches[2]?.resumeFromTaskId).toBe(launches[0]?.taskId);
});

test("private mail keeps the user actor and does not share that workspace with another sender", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeTeam,
  makeInternalAgent,
}) => {
  const owner = await makeUser({ email: "owner@example.com" });
  const other = await makeUser({ email: "other@example.com" });
  const org = await makeOrganization();
  await makeMember(owner.id, org.id);
  await makeMember(other.id, org.id);
  const team = await makeTeam(org.id, owner.id);
  await makeTeam(org.id, other.id);
  const agent = await makeInternalAgent({
    organizationId: org.id,
    incomingEmailEnabled: true,
    incomingEmailSecurityMode: "private",
    runtime,
    access: "org",
  });
  await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
  const provider = providerFor(agent.id);

  await processIncomingEmail(
    email({
      agentId: agent.id,
      fromAddress: owner.email,
      messageId: "private-1",
      conversationId: "private-thread",
    }),
    provider,
  );
  await settle(launches[0].taskId);
  await processIncomingEmail(
    email({
      agentId: agent.id,
      fromAddress: owner.email,
      messageId: "private-2",
      conversationId: "private-thread",
    }),
    provider,
  );
  await settle(launches[1].taskId);

  expect(launches[0]).toMatchObject({
    actorKind: "user",
    actorId: owner.id,
  });
  expect(launches[1]?.resumeFromTaskId).toBe(launches[0]?.taskId);

  await processIncomingEmail(
    email({
      agentId: agent.id,
      fromAddress: other.email,
      messageId: "private-3",
      conversationId: "private-thread",
    }),
    provider,
  );
  await settle(launches[2].taskId);
  expect(launches[2]).toMatchObject({
    actorKind: "user",
    actorId: other.id,
  });
  expect(launches[2]?.resumeFromTaskId).toBeUndefined();
  expect((await A2ATaskModel.findById(launches[2].taskId))?.contextId).not.toBe(
    (await A2ATaskModel.findById(launches[0].taskId))?.contextId,
  );
});
