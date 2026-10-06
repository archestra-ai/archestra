import { beforeEach, describe, expect, test } from "vitest";
import config from "@/config";
import { mintDelegationMarker } from "@/openappa/delegation";
import { prepareAppaRequest } from "@/openappa/request";
import { anthropicAdapterFactory } from "@/routes/proxy/adapters/anthropic";
import type { Anthropic } from "@/types";
import type { AppaMatchContext } from "../types";
import { AppaClaudeCodeAdapter } from "./claude-code";

const FORK_LAUNCH = "Fork started \u2014 processing in background";
const DIRECTIVE =
  "<fork-boilerplate>\nYou are a worker fork. The transcript above is the parent's history.\n</fork-boilerplate>\n\nYour directive: read the public marker.";
const LOCAL_DENIAL =
  "claude-sonnet-5[1m] is temporarily unavailable, so auto mode cannot determine the safety of Agent right now.";
const FAILED_SPAWN =
  "the spawn did not take: no prepared fork to open this child";
const PARENT_LAUNCH = `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)
agentId: a0bd844ae7b0839ce (internal ID - do not mention to user. Use SendMessage with to: 'a0bd844ae7b0839ce' to continue this agent.)
output_file: /tmp/claude/tasks/a0bd844ae7b0839ce.output`;

const SECRET = "fork-launch-test-secret-0123456789abcdef";
const PARENT = "11111111-2222-4333-8444-555555555555";
const SPAWN = "toolu_fork_spawn";

describe("Claude Code fork launch acknowledgements", () => {
  const claudeCode = new AppaClaudeCodeAdapter();

  beforeEach(() => {
    config.openappa.offerSigningSecret = SECRET;
  });

  test("treats the child's exact launch ack as a launch and keeps handbacks, denials, and failed spawns distinct", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_denied",
            name: "Agent",
            input: { description: "read", subagent_type: "general-purpose" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_denied",
            is_error: true,
            content: LOCAL_DENIAL,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_failed",
            name: "Agent",
            input: { description: "read", subagent_type: "general-purpose" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_failed",
            is_error: true,
            content: FAILED_SPAWN,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_fork",
            name: "Agent",
            input: {
              description: "read",
              prompt: "read the public marker",
              subagent_type: "fork",
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_fork",
            content: [{ type: "text", text: FORK_LAUNCH }],
          },
          {
            type: "text",
            text: DIRECTIVE,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_parent",
            name: "Agent",
            input: { description: "read", subagent_type: "fork" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_parent",
            content: [{ type: "text", text: PARENT_LAUNCH }],
          },
        ],
      },
    ] as Anthropic.Types.MessagesRequest["messages"];

    const results = anthropicAdapterFactory
      .createRequestAdapter({
        model: "claude-opus-5-5",
        max_tokens: 1024,
        messages,
      })
      .getToolResults();

    const byId = new Map(results.map((result) => [result.id, result]));
    const denied = byId.get("toolu_denied");
    const failed = byId.get("toolu_failed");
    const fork = byId.get("toolu_fork");
    const parent = byId.get("toolu_parent");
    if (!denied || !failed || !fork || !parent) {
      throw new Error("expected every spawn result");
    }

    expect(denied.isError).toBe(true);
    expect(claudeCode.normalizeChildLaunchResult(denied)).toBeUndefined();
    expect(claudeCode.isChildCompletionResult?.(denied)).toBe(false);
    expect(failed.isError).toBe(true);
    expect(claudeCode.normalizeChildLaunchResult(failed)).toBeUndefined();
    expect(claudeCode.isChildCompletionResult?.(failed)).toBe(false);

    expect(claudeCode.normalizeChildLaunchResult(fork)).toBe(FORK_LAUNCH);
    expect(claudeCode.normalizeChildLaunchResult(fork)).not.toContain(
      "fork-boilerplate",
    );
    expect(claudeCode.isChildCompletionResult?.(fork)).toBe(false);
    expect(fork.content).toEqual([{ type: "text", text: FORK_LAUNCH }]);

    expect(claudeCode.normalizeChildLaunchResult(parent)).toBe(
      "Async agent launched successfully.\nagentId: a0bd844ae7b0839ce",
    );
    expect(claudeCode.isChildCompletionResult?.(parent)).toBe(false);

    for (const content of [
      `${FORK_LAUNCH}\nREPORT-RAW-KOALA-0831`,
      "Fork started - processing in background",
      "Fork started \u2014 processing in background.",
      [
        { type: "text", text: FORK_LAUNCH },
        { type: "text", text: "extra" },
      ],
      FAILED_SPAWN,
      "SUMMARY(24 characters): safe",
    ]) {
      const result = {
        id: "toolu_handback",
        name: "Agent",
        content,
        isError: false,
      };
      expect(claudeCode.normalizeChildLaunchResult(result)).toBeUndefined();
      expect(claudeCode.isChildCompletionResult?.(result)).toBe(true);
    }
  });

  test("binds the fork child from the signed directive beside its launch ack, not from the ack", () => {
    const bound = claudeCode.bindChildTrajectory(
      forkContext(forkBody({ spawnCallId: SPAWN })),
    );
    expect(bound).toEqual({
      sessionId: `${PARENT}:${SPAWN}`,
      parentId: PARENT,
      lineage: {
        source: "marker",
        nativeParentId: PARENT,
        spawnCallId: SPAWN,
        spawnPromptDigest: expect.any(String),
      },
    });
    expect(bound?.sessionId).not.toBe(PARENT);

    expect(
      claudeCode.bindChildTrajectory(
        forkContext(forkBody({ spawnCallId: SPAWN, marker: false })),
      ),
    ).toBeUndefined();
    expect(
      claudeCode.bindChildTrajectory(
        forkContext(
          forkBody({
            spawnCallId: SPAWN,
            markerText: `[appa] delegated trajectory appa2-${Buffer.from(SPAWN).toString("base64url")}.${"ab".repeat(20)} — child of ${PARENT}.`,
          }),
        ),
      ),
    ).toBeUndefined();
    expect(
      claudeCode.bindChildTrajectory(
        forkContext(
          forkBody({
            spawnCallId: SPAWN,
            markerFor: "toolu_reused",
          }),
        ),
      ),
    ).toBeUndefined();
  });
});

function forkBody(params: {
  spawnCallId: string;
  marker?: boolean;
  markerText?: string;
  markerFor?: string;
}) {
  const prompt = "read the public marker";
  const marker =
    params.markerText ??
    (params.marker === false
      ? undefined
      : mintDelegationMarker({
          organizationId: "org",
          callerId: "user:user",
          parentId: PARENT,
          spawnerNativeId: PARENT,
          prompt,
          spawnCallId: params.markerFor ?? params.spawnCallId,
        }));
  const directive = marker ? `${prompt}\n\n${marker}` : prompt;
  return {
    model: "claude-opus-5-5",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.285.de3; cc_entrypoint=cli; cc_is_subagent=true;",
      },
    ],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_denied",
            name: "Agent",
            input: { subagent_type: "general-purpose", prompt },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_denied",
            is_error: true,
            content: LOCAL_DENIAL,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: params.spawnCallId,
            name: "Agent",
            input: { subagent_type: "fork", prompt, description: "read" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: params.spawnCallId,
            content: [{ type: "text", text: FORK_LAUNCH }],
          },
          {
            type: "text",
            text: directive,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  };
}

function forkContext(body: ReturnType<typeof forkBody>): AppaMatchContext {
  return {
    headers: { "x-claude-code-session-id": PARENT },
    requestBody: body,
    trustedContext: {
      session: {
        organization_id: "org",
        caller_id: "user:user",
        session_id: `user:user|${PARENT}`,
      },
      profileId: "profile",
      toolIdentity: {
        canonicalize: (name) => name,
        attestationOf: () => undefined,
        looseRunToolDispatch: false,
      },
      request: prepareAppaRequest({
        body,
        interactionType: "anthropic:messages",
        identity: {
          mode: "compat",
          gatewayConnected: true,
          canonicalize: (name) => name,
          attestationOf: () => undefined,
          verified: [],
          unverifiedMarkerCount: 0,
        },
      }),
    },
  };
}
