import { vi } from "vitest";

const mockGetThreadMuteMarker = vi.fn().mockResolvedValue(null);
vi.mock("@/agents/chatops/channel-activation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/agents/chatops/channel-activation")
    >();
  return {
    ...actual,
    claimThreadMuteHint: vi.fn().mockResolvedValue(false),
    getThreadMuteMarker: (
      ...args: Parameters<typeof actual.getThreadMuteMarker>
    ) => mockGetThreadMuteMarker(...args),
  };
});

import * as a2aExecutor from "@/agents/a2a-executor";
import { ChatOpsManager } from "@/agents/chatops/chatops-manager";
import config from "@/config";
import { AgentTeamModel, ChatOpsChannelBindingModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import { applyAdmittedParts } from "@/openappa/native-contract";
import {
  admitChatOpsTurn,
  chatOpsRoomFacts,
  NATIVE_TRANSPORT_BLOCKED_NOTICE,
} from "@/openappa/native-transport";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type {
  ChatOpsProvider,
  ChatReplyOptions,
  IncomingChatMessage,
} from "@/types";

describe("native transport parts", () => {
  test("a runtime file replacement drops the original bytes", () => {
    const applied = applyAdmittedParts({
      admitted: [
        { id: "", text: "hello", outputSource: "tool" },
        { id: "attachment:0", text: "file withheld", outputSource: "runtime" },
      ],
      body: "hello",
      history: [],
      attachments: [
        {
          contentType: "text/plain",
          contentBase64: "U0VDUkVULUZZTEU=",
          name: "secret.txt",
        },
      ],
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attachments).toEqual([]);
    expect(applied.body).toContain("file withheld");
    expect(applied.body).not.toContain("U0VDUkVULUZZTEU=");
  });

  test("unknown readers stay unresolved", () => {
    expect(
      chatOpsRoomFacts({
        provider: "slack",
        threadId: "T1",
        context: {
          roomId: JSON.stringify(["slack", "W1", "C1"]),
          trust: "suspicious",
          readers: null,
        },
      })?.readers,
    ).toEqual({ status: "unresolved" });
  });
});

describe("native transport gating", () => {
  const previous = config.openappa.enabled;

  beforeEach(() => {
    config.openappa.enabled = previous;
  });

  afterEach(() => {
    config.openappa.enabled = previous;
  });

  test("an inactive arrival does not look up room facts and is recorded off", async ({
    makeOrganization,
  }) => {
    config.openappa.enabled = false;
    const org = await makeOrganization();
    const lookup = vi.fn();
    const result = await admitChatOpsTurn({
      session: {
        organizationId: org.id,
        sessionId: "chatops:slack:C1",
        callerId: "user:user-1",
      },
      providerId: "slack",
      eventId: "msg-off",
      threadId: "C1",
      body: "raw history secret",
      history: ["earlier secret"],
      attachments: [],
      resolveFacts: lookup,
    });

    expect(result).toEqual({ decision: "pass" });
    expect(lookup).not.toHaveBeenCalled();
    const recorded = await OpenAppaUnenforcedModel.findSessions({
      organizationId: org.id,
      sessionIds: ["chatops:slack:C1"],
    });
    expect(recorded.map((row) => row.sessionId)).toContain("chatops:slack:C1");
  });

  test("an unsupported transport is refused while guardrails are active, without a fact lookup", async ({
    makeOrganization,
  }) => {
    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
    const org = await makeOrganization();
    const lookup = vi.fn();
    const result = await admitChatOpsTurn({
      session: {
        organizationId: org.id,
        sessionId: "chatops:telegram:chat-1",
        callerId: "user:user-1",
      },
      providerId: "unsupported",
      eventId: "tg-1",
      threadId: "chat-1",
      body: "telegram secret",
      history: [],
      attachments: [],
      resolveFacts: lookup,
    });

    expect(result.decision).toBe("refused");
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("native transport delivery", () => {
  const previous = config.openappa.enabled;

  beforeEach(() => {
    config.openappa.enabled = previous;
    mockGetThreadMuteMarker.mockResolvedValue(null);
  });

  afterEach(() => {
    config.openappa.enabled = previous;
  });

  test("does not publish a private result or raw attachment while v2 is active", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
    const user = await makeUser({ email: "native-transport@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "slack",
      channelId: "C-native",
      workspaceId: "W-native",
      agentId: agent.id,
    });

    const execute = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValue({
        text: "SECRET-OUTPUT",
        messageId: "model-1",
        finishReason: "stop",
        responseUiMessage: {
          id: "model-1",
          role: "assistant",
          parts: [{ type: "text", text: "SECRET-OUTPUT" }],
        },
      });
    const sent: string[] = [];
    const provider = slackProvider({
      getUserEmail: async () => user.email,
      sendReply: async (options) => {
        sent.push(options.text);
        return "ts-1";
      },
    });
    const manager = new ChatOpsManager();
    (manager as unknown as { slackProvider: ChatOpsProvider }).slackProvider =
      provider;

    const result = await manager.processMessage({
      message: message({
        text: "SECRET-INPUT",
        attachments: [
          {
            contentType: "text/plain",
            contentBase64: "U0VDUkVULUZZTEU=",
            name: "secret.txt",
          },
        ],
      }),
      provider,
    });

    const modelSaw = execute.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .join("\n");
    expect(sent.join("\n")).not.toContain("SECRET-OUTPUT");
    expect(sent.join("\n")).not.toContain("U0VDUkVULUZZTEU=");
    if (result.error === "NATIVE_TRANSPORT_REFUSED") {
      expect(execute).not.toHaveBeenCalled();
      expect(modelSaw).not.toContain("SECRET-INPUT");
      expect(sent).toContain(NATIVE_TRANSPORT_BLOCKED_NOTICE);
    } else if (execute.mock.calls.length > 0) {
      expect(modelSaw).not.toContain("U0VDUkVULUZZTEU=");
    }
  });

  test("a background result without a producing session is not posted while v2 is active", async ({
    makeOrganization,
  }) => {
    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
    const org = await makeOrganization();
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "slack",
      channelId: "C-bg",
      workspaceId: "W-bg",
      agentId: null,
    });
    const sent: string[] = [];
    const provider = slackProvider({
      sendReply: async (options) => {
        sent.push(options.text);
        return "ts-bg";
      },
    });
    const manager = new ChatOpsManager();
    (manager as unknown as { slackProvider: ChatOpsProvider }).slackProvider =
      provider;

    await manager.notifyBindingThread({
      bindingId: binding.id,
      threadId: "T-bg",
      text: "SECRET-BACKGROUND",
    });

    expect(sent).toEqual([NATIVE_TRANSPORT_BLOCKED_NOTICE]);
    expect(sent.join("\n")).not.toContain("SECRET-BACKGROUND");
  });
});

function slackProvider(overrides: {
  getUserEmail?: (userId: string) => Promise<string | null>;
  sendReply?: (options: ChatReplyOptions) => Promise<string>;
}): ChatOpsProvider {
  return {
    providerId: "slack",
    displayName: "Slack",
    isConfigured: () => true,
    initialize: async () => {},
    cleanup: async () => {},
    validateWebhookRequest: async () => true,
    handleValidationChallenge: () => null,
    parseWebhookNotification: async () => null,
    sendReply: overrides.sendReply ?? (async () => "reply-id"),
    parseInteractivePayload: () => null,
    sendAgentSelectionCard: async () => {},
    getThreadHistory: async () => [],
    getUserEmail: overrides.getUserEmail ?? (async () => null),
    getChannelName: async () => "native",
    getWorkspaceId: () => "W-native",
    getWorkspaceName: () => "Native",
    hasMissingScopes: () => false,
    notifyMissingScopes: async () => {},
    downloadFiles: async () => [],
    discoverChannels: async () => null,
    addApprovalRequestForm: async () => {},
    updateApprovalRequest: async () => {},
    getGuardrailsContext: async () => ({
      roomId: JSON.stringify(["slack", "W-native", "C-native"]),
      trust: "suspicious",
      readers: ["reader@example.com"],
    }),
  };
}

function message(
  overrides: Partial<IncomingChatMessage> = {},
): IncomingChatMessage {
  return {
    messageId: "native-msg-1",
    channelId: "C-native",
    workspaceId: "W-native",
    senderId: "U-native",
    senderEmail: "native-transport@example.com",
    senderName: "Native",
    text: "hello",
    rawText: "hello",
    timestamp: new Date(),
    isThreadReply: false,
    metadata: { conversationType: "personal" },
    ...overrides,
  };
}
