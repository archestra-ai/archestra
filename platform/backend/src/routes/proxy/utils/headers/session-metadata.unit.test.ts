import {
  OPENCODE_AGENT_HEADER,
  SESSION_ID_HEADER,
} from "@archestra/shared/consts";
import {
  CHATGPT_CLIENT_ID,
  CODEX_CLIENT_ID,
  OPENCODE_CLIENT_ID,
} from "@archestra/shared/interactions/client";
import { describe, expect, test } from "vitest";
import { extractAutoRoutingSessionMetadata } from "./session-metadata";

const CODEX_THREAD = "0199a213-81c0-7800-8aa1-bbab2a035a53";

const chatCompletionsBody = {
  model: "gpt-5",
  messages: [{ role: "user", content: "fix the flaky test" }],
};

const responsesBody = {
  model: "gpt-5",
  input: [
    { role: "user", content: [{ type: "input_text", text: "fix the test" }] },
  ],
};

describe("extractAutoRoutingSessionMetadata", () => {
  test.each([
    {
      name: "Chat Completions main turn",
      headers: { "user-agent": "opencode/1.2.3", "x-session-id": "ses_main" },
      body: chatCompletionsBody,
      expected: {
        sessionId: "ses_main",
        sessionSource: "opencode_session",
        client: OPENCODE_CLIENT_ID,
      },
    },
    {
      name: "Chat Completions subagent keeps its own session id",
      headers: {
        "user-agent": "opencode/1.2.3",
        "x-session-id": "ses_child",
        "x-parent-session-id": "ses_main",
      },
      body: chatCompletionsBody,
      expected: {
        sessionId: "ses_child",
        sessionSource: "opencode_session",
        client: OPENCODE_CLIENT_ID,
      },
    },
    {
      name: "Responses main turn from Codex",
      headers: { originator: "codex_cli_rs" },
      body: { ...responsesBody, client_metadata: { thread_id: CODEX_THREAD } },
      expected: {
        sessionId: CODEX_THREAD,
        sessionSource: "codex_session",
        client: CODEX_CLIENT_ID,
      },
    },
    {
      name: "Responses subagent",
      headers: {
        originator: "opencode",
        "session-id": "ses_child",
        "x-parent-session-id": "ses_main",
      },
      body: responsesBody,
      expected: {
        sessionId: "ses_child",
        sessionSource: "opencode_session",
        client: OPENCODE_CLIENT_ID,
      },
    },
  ])("$name", ({ headers, body, expected }) => {
    expect(extractAutoRoutingSessionMetadata({ headers, body })).toEqual(
      expected,
    );
  });

  test.each([
    ["Chat Completions", chatCompletionsBody],
    ["Responses", responsesBody],
  ])("%s request without session or client signals", (_, body) => {
    expect(
      extractAutoRoutingSessionMetadata({
        headers: { "user-agent": "curl/8.7.1" },
        body,
      }),
    ).toEqual({
      sessionId: null,
      sessionSource: null,
      client: null,
    });
  });

  test.each([
    ["Chat Completions", chatCompletionsBody],
    ["Responses", responsesBody],
  ])("%s request from an unknown client", (_, body) => {
    expect(
      extractAutoRoutingSessionMetadata({
        headers: {
          "user-agent": "my-script/0.1",
          [SESSION_ID_HEADER.toLowerCase()]: "run-42",
          // Parent and OpenCode turn headers only count for OpenCode-family clients.
          "x-parent-session-id": "run-41",
          [OPENCODE_AGENT_HEADER.toLowerCase()]: "title",
        },
        body,
      }),
    ).toEqual({
      sessionId: "run-42",
      sessionSource: "header",
      client: null,
    });
  });

  // The ChatGPT desktop app reads Codex's config.toml, so it sends the agent id
  // the Codex setup wrote there; its originator names the app.
  test.each([
    {
      name: "a Work thread",
      headers: {
        originator: "codex_work_desktop",
        "user-agent": "Codex Desktop/0.163.0 (Windows 10.0.26200; x86_64)",
      },
    },
    {
      name: "the Codex tab",
      headers: {
        originator: "Codex Desktop",
        "user-agent": "Codex Desktop/0.163.0 (Mac OS 15.6.0; arm64)",
      },
    },
    {
      name: "a CLI thread the app resumed",
      headers: {
        originator: "codex_cli_rs",
        "user-agent": "Codex Desktop/0.163.0 (Windows 10.0.26200; x86_64)",
      },
    },
  ])("names ChatGPT for $name of the desktop app", ({ headers }) => {
    for (const agentId of [undefined, CODEX_CLIENT_ID]) {
      expect(
        extractAutoRoutingSessionMetadata({
          headers: {
            ...headers,
            ...(agentId ? { "x-archestra-agent-id": agentId } : {}),
          },
          body: {
            ...responsesBody,
            client_metadata: { thread_id: CODEX_THREAD },
          },
        }),
      ).toEqual({
        sessionId: CODEX_THREAD,
        sessionSource: "chatgpt_session",
        client: CHATGPT_CLIENT_ID,
      });
    }
  });

  test("keeps a caller's own agent id on a desktop app request", () => {
    expect(
      extractAutoRoutingSessionMetadata({
        headers: {
          originator: "codex_work_desktop",
          "x-archestra-agent-id": "nightly-bot",
        },
        body: responsesBody,
      }),
    ).toMatchObject({ client: "nightly-bot" });
  });

  test("an explicit agent id header names the client", () => {
    expect(
      extractAutoRoutingSessionMetadata({
        headers: {
          "x-archestra-agent-id": "nightly-bot",
          "user-agent": "opencode/1.2.3",
          "x-parent-session-id": "ses_main",
        },
        body: chatCompletionsBody,
      }),
    ).toMatchObject({ client: "nightly-bot" });
  });
});
