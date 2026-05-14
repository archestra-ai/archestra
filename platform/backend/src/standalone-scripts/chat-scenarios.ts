import {
  type archestraApiTypes,
  ChatErrorCode,
  type ChatErrorResponse,
} from "@shared";
import type { UIMessage } from "ai";

export type SeededChatPreviewScenario = {
  id: string;
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
    title: "Timeline errors",
    messages: [
      userMessage("timeline-user-1", "first try", baseTimestamp),
      userMessage("timeline-user-2", "try again", "2026-04-23T10:02:00.000Z"),
    ],
    chatErrors: [
      chatError("timeline-error-1", "2026-04-23T10:01:00.000Z", {
        message: "Provider failed",
      }),
    ],
  },
  {
    id: "compact-tools",
    title: "Compact tools",
    messages: [
      assistantMessage(
        "compact-tools-assistant",
        [
          {
            type: "tool-demo__list_issues",
            toolCallId: "compact-call-1",
            state: "input-available",
            input: { owner: "demo-owner", repo: "demo-repo" },
          },
          {
            type: "tool-demo__list_issues",
            toolCallId: "compact-call-1",
            state: "output-available",
            input: { owner: "demo-owner", repo: "demo-repo" },
            output: { issues: [{ number: 1, title: "Demo issue" }] },
          },
          {
            type: "tool-demo__list_pull_requests",
            toolCallId: "compact-call-2",
            state: "input-available",
            input: { owner: "demo-owner", repo: "demo-repo" },
          },
          {
            type: "tool-demo__list_pull_requests",
            toolCallId: "compact-call-2",
            state: "output-available",
            input: { owner: "demo-owner", repo: "demo-repo" },
            output: { pullRequests: [{ number: 7, title: "Demo PR" }] },
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
    title: "File variants",
    messages: [
      {
        id: "file-user-with-text",
        role: "user",
        metadata: { createdAt: baseTimestamp },
        parts: [
          {
            type: "text",
            text: "Please review the attached incident files.",
          },
          {
            type: "file",
            url: "https://example.test/incident-report.png",
            mediaType: "image/png",
            filename: "incident-report.png",
          },
        ],
      } as UIMessage,
      {
        id: "file-user-only",
        role: "user",
        metadata: { createdAt: "2026-04-23T10:00:01.000Z" },
        parts: [
          {
            type: "file",
            url: "https://example.test/network-trace.txt",
            mediaType: "text/plain",
            filename: "network-trace.txt",
          },
        ],
      } as UIMessage,
      assistantMessage(
        "file-assistant",
        [
          {
            type: "file",
            url: "https://example.test/runbook.pdf",
            mediaType: "application/pdf",
            filename: "runbook.pdf",
          },
          {
            type: "file",
            url: "https://example.test/trace.csv",
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
    title: "SDK message parts",
    messages: [
      assistantMessage(
        "sdk-parts-assistant",
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
            url: "https://example.test/sdk-source",
            title: "SDK Source",
          },
          {
            type: "source-url",
            sourceId: "sdk-source-1",
            url: "https://example.test/sdk-source-duplicate",
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
    title: "Dynamic tool",
    messages: [
      assistantMessage(
        "dynamic-tool-assistant",
        [
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "dynamic-call-1",
            state: "input-available",
            input: { query: "release notes" },
          },
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "dynamic-call-1",
            state: "output-available",
            input: { query: "release notes" },
            output: {
              results: [
                { title: "Release notes", url: "https://example.test" },
              ],
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
    title: "System and thinking",
    messages: [
      systemMessage(
        "system-thinking-system",
        "Use demo credentials only.",
        baseTimestamp,
      ),
      assistantMessage(
        "system-thinking-assistant",
        [
          {
            type: "text",
            text: "<think>Need to inspect config first.</think>Use the demo credentials only.",
          },
          {
            type: "reasoning",
            text: "Double-checking the demo environment details.",
            state: "done",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:01.000Z",
      ),
    ],
  },
  {
    id: "tool-states",
    title: "Tool states",
    messages: [
      assistantMessage(
        "tool-states-assistant",
        [
          {
            type: "data-tool-ui-start",
            data: {
              toolCallId: "tool-ui-call-1",
              toolName: "demo__open_pull_request",
              uiResourceUri: "ui://demo/pr-view",
              html: "<div>Pull request preview</div>",
            },
          } as never,
          {
            type: "tool-demo__open_pull_request",
            toolCallId: "tool-ui-call-1",
            state: "output-available",
            input: { owner: "demo-owner", repo: "demo-repo", number: 42 },
            output: { ok: true, title: "Pull request preview" },
          },
          {
            type: "tool-archestra__todo_write",
            toolCallId: "todo-approval-call",
            state: "approval-requested",
            input: {
              todos: [
                { content: "Find demo tools", status: "completed" },
                { content: "Request approval", status: "pending" },
              ],
            },
            approval: { id: "approval-1" },
          },
          {
            type: "tool-archestra__swap_agent",
            toolCallId: "swap-call",
            state: "output-available",
            input: { agent_name: "Demo Agent" },
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
    title: "Auth states",
    messages: [
      assistantMessage(
        "auth-states-tool-errors",
        [
          {
            type: "tool-demo_server__get_server_info",
            toolCallId: "auth-expired-call",
            state: "output-available",
            input: {},
            output: {
              isError: true,
              _meta: {
                archestraError: {
                  type: "auth_expired",
                  message: 'Expired or invalid authentication for "Demo MCP".',
                  catalogId: "demo-catalog",
                  catalogName: "Demo MCP",
                  serverId: "demo-server",
                  reauthUrl:
                    "http://localhost:3000/mcp/registry?reauth=demo-catalog&server=demo-server",
                },
              },
            },
          },
          {
            type: "tool-demo_remote__issue_write",
            toolCallId: "assigned-credential-call",
            state: "output-available",
            input: {},
            output: {
              isError: true,
              _meta: {
                archestraError: {
                  type: "assigned_credential_unavailable",
                  message: "Assigned credential unavailable",
                  catalogId: "demo-assigned-catalog",
                  catalogName: "Demo Remote MCP",
                },
              },
            },
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
      assistantMessage(
        "auth-states-text",
        [
          {
            type: "text",
            text: 'Authentication required for "Demo MCP".\n\nNo credentials were found for your account (user: demo-user).\nTo set up your credentials, visit this URL: http://localhost:3000/mcp/registry?install=demo-catalog',
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:01.000Z",
      ),
    ],
  },
  {
    id: "unsafe-and-policy",
    title: "Unsafe and policy denied",
    messages: [
      assistantMessage(
        "unsafe-tool-assistant",
        [
          {
            type: "tool-demo__read_note",
            toolCallId: "unsafe-call",
            state: "output-available",
            input: { folder: "demo" },
            output: {
              content: "DEMO_SECRET = demo-value",
              unsafeContextBoundary: {
                kind: "tool_result",
                reason: "tool_result_marked_untrusted",
                toolCallId: "unsafe-call",
                toolName: "demo__read_note",
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
        "unsafe-policy-denied-assistant",
        [
          {
            type: "text",
            text: "\nI tried to invoke the demo__print_secret tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains sensitive data",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:01.000Z",
      ),
    ],
  },
  {
    id: "mega-conversation",
    title: "Mega conversation",
    messages: [
      systemMessage(
        "mega-system",
        "Always prefer the demo environment first.",
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
            url: "https://example.test/mega-summary.pdf",
            mediaType: "application/pdf",
            filename: "mega-summary.pdf",
          },
          {
            type: "file",
            url: "https://example.test/mega-results.csv",
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
            type: "tool-demo__list_issues",
            toolCallId: "mega-call-1",
            state: "input-available",
            input: { owner: "demo-owner", repo: "demo-repo" },
          },
          {
            type: "tool-demo__list_issues",
            toolCallId: "mega-call-1",
            state: "output-available",
            input: { owner: "demo-owner", repo: "demo-repo" },
            output: { issues: [{ number: 1, title: "Demo issue" }] },
          },
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "mega-dynamic-call-1",
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
      chatError("mega-error", "2026-04-23T09:58:15.000Z", {
        message: "Previous attempt failed",
      }),
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
  params: { message: string },
): SeededChatPreviewError {
  return {
    id,
    createdAt,
    error: {
      code: ChatErrorCode.ServerError,
      message: params.message,
      isRetryable: true,
    },
  };
}
