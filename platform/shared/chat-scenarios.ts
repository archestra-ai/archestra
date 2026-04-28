import type { UIMessage } from "ai";
import { ChatErrorCode, type ChatErrorResponse } from "./chat-error";
import type * as archestraApiTypes from "./hey-api/clients/api/types.gen";

export type SeededChatPreviewScenario = {
  id: string;
  conversationId: string;
  title: string;
  messages: UIMessage[];
  chatErrors?: SeededChatPreviewError[];
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
};

export type SeededChatPreviewError = {
  id: string;
  createdAt: string;
  error: ChatErrorResponse;
};

const baseTimestamp = "2026-04-23T10:00:00.000Z";

export const seededChatPreviewScenarios: SeededChatPreviewScenario[] = [
  {
    id: "timeline-errors",
    conversationId: "00000000-0000-4000-8000-000000000002",
    title: "Timeline errors",
    messages: [
      userMessage("user-1", "first try", "2026-04-23T10:00:00.000Z"),
      userMessage("user-2", "try again", "2026-04-23T10:02:00.000Z"),
    ],
    chatErrors: [
      chatError("error-1", "2026-04-23T10:01:00.000Z", "Provider failed"),
    ],
  },
  {
    id: "compact-tools",
    conversationId: "00000000-0000-4000-8000-000000000003",
    title: "Compact tools",
    messages: [
      assistantMessage(
        "assistant-tools",
        [
          {
            type: "tool-github__list_issues",
            toolCallId: "call-1",
            state: "input-available",
            input: { owner: "openai", repo: "openai-node" },
          },
          {
            type: "tool-github__list_issues",
            toolCallId: "call-1",
            state: "output-available",
            output: { issues: [{ number: 1 }] },
          },
          {
            type: "tool-github__list_pull_requests",
            toolCallId: "call-2",
            state: "input-available",
            input: { owner: "openai", repo: "openai-node" },
          },
          {
            type: "tool-github__list_pull_requests",
            toolCallId: "call-2",
            state: "output-available",
            output: { pullRequests: [{ number: 7 }] },
          },
          {
            type: "text",
            text: "Checked the current issues and pull requests.",
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  {
    id: "file-variants",
    conversationId: "00000000-0000-4000-8000-000000000009",
    title: "File variants",
    messages: [
      {
        id: "user-file-with-text",
        role: "user",
        metadata: { createdAt: "2026-04-23T10:00:00.000Z" },
        parts: [
          {
            type: "text",
            text: "Please review the attached incident files.",
          },
          {
            type: "file",
            url: "https://example.com/incident-report.png",
            mediaType: "image/png",
            filename: "incident-report.png",
          },
        ],
      } as UIMessage,
      {
        id: "user-file-only",
        role: "user",
        metadata: { createdAt: "2026-04-23T10:00:01.000Z" },
        parts: [
          {
            type: "file",
            url: "https://example.com/network-trace.txt",
            mediaType: "text/plain",
            filename: "network-trace.txt",
          },
        ],
      } as UIMessage,
      assistantMessage(
        "assistant-files",
        [
          {
            type: "file",
            url: "https://example.com/runbook.pdf",
            mediaType: "application/pdf",
            filename: "runbook.pdf",
          },
          {
            type: "file",
            url: "https://example.com/trace.csv",
            mediaType: "text/csv",
            filename: "trace.csv",
          },
          {
            type: "text",
            text: "I reviewed the attached files.",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:02.000Z",
      ),
    ],
  },
  {
    id: "sdk-message-parts",
    conversationId: "00000000-0000-4000-8000-000000000017",
    title: "SDK message parts",
    messages: [
      assistantMessage(
        "assistant-sdk-parts",
        [
          { type: "step-start" },
          {
            type: "reasoning",
            text: "Checking SDK reasoning before composing the answer.",
            state: "done",
          },
          {
            type: "text",
            text: "The SDK message parts rendered correctly.",
          },
          {
            type: "source-url",
            sourceId: "sdk-source-1",
            url: "https://example.com/sdk-source",
            title: "SDK Source",
          },
          {
            type: "source-url",
            sourceId: "sdk-source-1",
            url: "https://example.com/sdk-source-duplicate",
            title: "SDK Source Duplicate",
          },
          {
            type: "source-document",
            sourceId: "sdk-doc-1",
            mediaType: "application/pdf",
            title: "SDK Source Document",
            filename: "sdk-source-document.pdf",
          },
          {
            type: "data-heartbeat",
            data: { timestamp: 1 },
          },
          {
            type: "data-token-usage",
            data: { inputTokens: 7, outputTokens: 11, totalTokens: 18 },
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  {
    id: "dynamic-tool",
    conversationId: "00000000-0000-4000-8000-000000000010",
    title: "Dynamic tool",
    messages: [
      assistantMessage(
        "assistant-dynamic-tool",
        [
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "dyn-1",
            state: "input-available",
            input: { query: "release notes" },
          },
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "dyn-1",
            state: "output-available",
            input: { query: "release notes" },
            output: {
              results: [{ title: "Release notes", url: "https://example.com" }],
            },
          },
          {
            type: "text",
            text: "I checked the release notes.",
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  {
    id: "system-and-thinking",
    conversationId: "00000000-0000-4000-8000-000000000013",
    title: "System and thinking",
    messages: [
      systemMessage(
        "system-1",
        "Use staging credentials only.",
        "2026-04-23T10:00:00.000Z",
      ),
      assistantMessage(
        "assistant-thinking",
        [
          {
            type: "text",
            text: "<think>Need to inspect config first.</think>Use the staging credentials only.",
          },
          {
            type: "reasoning",
            text: "Double-checking the staging environment details.",
            state: "done",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:01.000Z",
      ),
    ],
  },
  {
    id: "tool-states",
    conversationId: "00000000-0000-4000-8000-000000000018",
    title: "Tool states",
    messages: [
      assistantMessage(
        "assistant-tool-states",
        [
          {
            type: "data-tool-ui-start",
            data: {
              toolCallId: "ui-call-1",
              toolName: "github__open_pull_request",
              uiResourceUri: "ui://github/pr-view",
              html: "<div>Pull request preview</div>",
            },
          } as never,
          {
            type: "tool-github__open_pull_request",
            toolCallId: "ui-call-1",
            state: "output-available",
            input: { owner: "openai", repo: "openai-node", number: 42 },
            output: { ok: true, title: "Pull request preview" },
          },
          {
            type: "tool-archestra__todo_write",
            toolCallId: "todo-approval-call",
            state: "approval-requested",
            input: {
              todos: [
                { content: "Find GitHub tools", status: "completed" },
                { content: "Request approval", status: "pending" },
              ],
            },
            approval: { id: "approval-1" },
          },
          {
            type: "tool-sparky__swap_agent",
            toolCallId: "swap-call",
            state: "output-available",
            input: { agent_name: "GitHub Agent" },
            output: { ok: true },
          },
          {
            type: "text",
            text: "Tool previews are ready.",
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  {
    id: "auth-states",
    conversationId: "00000000-0000-4000-8000-000000000004",
    title: "Auth states",
    messages: [
      assistantMessage(
        "assistant-auth-errors",
        [
          {
            type: "tool-id-jag_test__get_server_info",
            toolCallId: "call-auth-expired",
            state: "output-available",
            input: {},
            output: {
              isError: true,
              _meta: {
                archestraError: {
                  type: "auth_expired",
                  message:
                    'Expired or invalid authentication for "id-jag test".',
                  catalogId: "cat_abc",
                  catalogName: "id-jag test",
                  serverId: "srv_xyz",
                  reauthUrl:
                    "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz",
                },
              },
            },
          },
          {
            type: "tool-githubcopilot__remote-mcp__issue_write",
            toolCallId: "call-assigned",
            state: "output-available",
            input: {},
            output: {
              isError: true,
              _meta: {
                archestraError: {
                  type: "assigned_credential_unavailable",
                  message: "Assigned credential unavailable",
                  catalogId: "cat_assigned",
                  catalogName: "githubcopilot__remote-mcp",
                },
              },
            },
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
      assistantMessage(
        "assistant-auth-required",
        [
          {
            type: "text",
            text: 'Authentication required for "jwks demo".\n\nNo credentials were found for your account (user: usr_123).\nTo set up your credentials, visit this URL: http://localhost:3000/mcp/registry?install=cat_install',
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:01.000Z",
      ),
    ],
  },
  {
    id: "unsafe-and-policy",
    conversationId: "00000000-0000-4000-8000-000000000019",
    title: "Unsafe and policy denied",
    messages: [
      assistantMessage(
        "assistant-unsafe",
        [
          {
            type: "tool-read_email",
            toolCallId: "call-unsafe",
            state: "output-available",
            input: { folder: "inbox" },
            output: {
              content: "ARCH_TEST = secret-value",
              unsafeContextBoundary: {
                kind: "tool_result",
                reason: "tool_result_marked_untrusted",
                toolCallId: "call-unsafe",
                toolName: "read_email",
              },
            },
          },
          {
            type: "text",
            text: "Unsafe context is now active.",
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
      assistantMessage(
        "assistant-denied",
        [
          {
            type: "text",
            text: "\nI tried to invoke the internal-dev-test-server__print_archestra_test tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains sensitive data",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:01.000Z",
      ),
    ],
  },
  {
    id: "mega-conversation",
    conversationId: "00000000-0000-4000-8000-000000000015",
    title: "Mega conversation",
    messages: [
      systemMessage(
        "mega-system",
        "Always prefer the staging environment first.",
        "2026-04-23T09:57:00.000Z",
      ),
      userMessage(
        "mega-user-text",
        "Show me every chat block and feature.",
        "2026-04-23T09:58:00.000Z",
      ),
      assistantMessage(
        "mega-thinking",
        [
          {
            type: "text",
            text: "<think>Gathering every render branch.</think>Here is the combined demo.",
          },
          {
            type: "reasoning",
            text: "Streaming reasoning block inside the mega conversation.",
            state: "done",
          },
        ] as UIMessage["parts"],
        "2026-04-23T09:59:00.000Z",
      ),
      assistantMessage(
        "mega-files",
        [
          {
            type: "file",
            url: "https://example.com/mega-summary.pdf",
            mediaType: "application/pdf",
            filename: "mega-summary.pdf",
          },
          {
            type: "file",
            url: "https://example.com/mega-results.csv",
            mediaType: "text/csv",
            filename: "mega-results.csv",
          },
          {
            type: "text",
            text: "Attached the generated summary and results.",
          },
        ] as UIMessage["parts"],
        "2026-04-23T09:59:10.000Z",
      ),
      assistantMessage(
        "mega-tools",
        [
          {
            type: "tool-github__list_issues",
            toolCallId: "mega-call-1",
            state: "input-available",
            input: { owner: "openai", repo: "openai-node" },
          },
          {
            type: "tool-github__list_issues",
            toolCallId: "mega-call-1",
            state: "output-available",
            input: { owner: "openai", repo: "openai-node" },
            output: { issues: [{ number: 1 }] },
          },
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "mega-dyn-1",
            state: "output-available",
            input: { query: "mega scenario release notes" },
            output: { results: [{ title: "Mega release notes" }] },
          },
          {
            type: "text",
            text: "Compact and dynamic tool branches completed.",
          },
        ] as UIMessage["parts"],
        "2026-04-23T09:59:20.000Z",
      ),
    ],
    chatErrors: [
      chatError(
        "mega-error",
        "2026-04-23T09:58:15.000Z",
        "Previous attempt failed",
      ),
    ],
  },
];

export const seededChatPreviewScenariosById = new Map(
  seededChatPreviewScenarios.map((scenario) => [scenario.id, scenario]),
);

export function userMessage(
  id: string,
  text: string,
  createdAt: string,
): UIMessage {
  return {
    id,
    role: "user",
    metadata: { createdAt },
    parts: [{ type: "text", text }],
  } as UIMessage;
}

export function assistantMessage(
  id: string,
  parts: UIMessage["parts"],
  createdAt: string,
): UIMessage {
  return {
    id,
    role: "assistant",
    metadata: { createdAt },
    parts,
  } as UIMessage;
}

export function systemMessage(
  id: string,
  text: string,
  createdAt: string,
): UIMessage {
  return {
    id,
    role: "system",
    metadata: { createdAt },
    parts: [{ type: "text", text }],
  } as UIMessage;
}

function chatError(
  id: string,
  createdAt: string,
  message: string,
): SeededChatPreviewError {
  return {
    id,
    createdAt,
    error: {
      code: ChatErrorCode.ServerError,
      message,
      isRetryable: true,
    },
  };
}
