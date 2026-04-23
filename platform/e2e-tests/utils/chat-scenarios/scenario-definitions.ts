import type { UIMessage } from "ai";
import type { MockChatScenario, PersistedChatError } from "./types";

const baseTimestamp = "2026-04-23T10:00:00.000Z";

const reasoningAndTextId = "00000000-0000-4000-8000-000000000001";
const timelineErrorsId = "00000000-0000-4000-8000-000000000002";
const compactToolsId = "00000000-0000-4000-8000-000000000003";
const authStatesId = "00000000-0000-4000-8000-000000000004";
const unsafeContextId = "00000000-0000-4000-8000-000000000005";
const mcpAppEarlyUiId = "00000000-0000-4000-8000-000000000006";
const swapAgentId = "00000000-0000-4000-8000-000000000007";
const mixedDemoId = "00000000-0000-4000-8000-000000000008";
const fileVariantsId = "00000000-0000-4000-8000-000000000009";
const dynamicToolId = "00000000-0000-4000-8000-000000000010";
const preexistingUnsafeId = "00000000-0000-4000-8000-000000000011";
const policyDeniedId = "00000000-0000-4000-8000-000000000012";
const systemThinkingId = "00000000-0000-4000-8000-000000000013";
const todoApprovalId = "00000000-0000-4000-8000-000000000014";
const megaScenarioId = "00000000-0000-4000-8000-000000000015";
const megaStreamingScenarioId = "00000000-0000-4000-8000-000000000016";

export const timelineErrorsScenario: MockChatScenario = {
  id: "timeline-errors",
  mode: "seeded",
  route: {
    initialPath: `/chat/${timelineErrorsId}`,
    conversationId: timelineErrorsId,
  },
  seededConversation: {
    messages: [
      userMessage("user-1", "first try", "2026-04-23T10:00:00.000Z"),
      userMessage("user-2", "try again", "2026-04-23T10:02:00.000Z"),
    ],
    chatErrors: [
      chatError(
        "error-1",
        timelineErrorsId,
        "2026-04-23T10:01:00.000Z",
        "Provider failed",
      ),
    ],
  },
  assertions: {
    visibleText: ["first try", "Provider failed", "try again"],
    orderedText: ["first try", "Provider failed", "try again"],
  },
};

export const reasoningAndTextScenario: MockChatScenario = {
  id: "reasoning-and-text",
  mode: "stream",
  route: {
    initialPath: `/chat/${reasoningAndTextId}`,
    conversationId: reasoningAndTextId,
  },
  request: {
    assertLastUserMessageIncludes: "show reasoning",
  },
  seededConversation: {
    messages: [],
  },
  stream: {
    events: [
      {
        type: "assistant-reasoning",
        text: "Checking the deployment graph before answering.",
      },
      { type: "delay", ms: 400 },
      {
        type: "assistant-text",
        text: "The rollout is blocked by a missing database migration.",
      },
      { type: "finish" },
    ],
  },
  assertions: {
    visibleText: [
      "Checking the deployment graph before answering.",
      "The rollout is blocked by a missing database migration.",
    ],
    orderedText: [
      "Checking the deployment graph before answering.",
      "The rollout is blocked by a missing database migration.",
    ],
  },
};

export const compactToolsScenario: MockChatScenario = {
  id: "compact-tools",
  mode: "seeded",
  route: {
    initialPath: `/chat/${compactToolsId}`,
    conversationId: compactToolsId,
  },
  seededConversation: {
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
  assertions: {
    visibleText: ["Checked the current issues and pull requests."],
  },
};

export const fileVariantsScenario: MockChatScenario = {
  id: "file-variants",
  mode: "seeded",
  route: {
    initialPath: `/chat/${fileVariantsId}`,
    conversationId: fileVariantsId,
  },
  seededConversation: {
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
  assertions: {
    visibleText: [
      "Please review the attached incident files.",
      "network-trace.txt",
      "runbook.pdf",
      "trace.csv",
      "I reviewed the attached files.",
    ],
    visibleImages: ["incident-report.png"],
  },
};

export const dynamicToolScenario: MockChatScenario = {
  id: "dynamic-tool",
  mode: "seeded",
  route: {
    initialPath: `/chat/${dynamicToolId}`,
    conversationId: dynamicToolId,
  },
  seededConversation: {
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
  assertions: {
    visibleText: ["I checked the release notes."],
  },
};

export const preexistingUnsafeScenario: MockChatScenario = {
  id: "preexisting-unsafe",
  mode: "seeded",
  route: {
    initialPath: `/chat/${preexistingUnsafeId}`,
    conversationId: preexistingUnsafeId,
  },
  seededConversation: {
    messages: [
      assistantMessage(
        "assistant-preexisting-unsafe",
        [{ type: "text", text: "Continuing the workflow." }] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
    unsafeContextBoundary: {
      kind: "preexisting_untrusted",
      reason: "inherited_from_parent",
    },
  },
  assertions: {
    visibleText: ["Continuing the workflow."],
    hiddenText: ["Sensitive context below"],
  },
};

export const policyDeniedScenario: MockChatScenario = {
  id: "policy-denied",
  mode: "seeded",
  route: {
    initialPath: `/chat/${policyDeniedId}`,
    conversationId: policyDeniedId,
  },
  seededConversation: {
    messages: [
      assistantMessage(
        "assistant-sensitive",
        [
          {
            type: "tool-internal-dev-test-server__print_archestra_test",
            toolCallId: "policy-call-1",
            state: "output-available",
            input: {},
            output: { content: "ARCHESTRA_TEST = asdfasdfadsf" },
          },
          {
            type: "text",
            text: "Done.",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:00.000Z",
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
  assertions: {
    visibleText: ["Sensitive context below", "Done.", "Rejected"],
  },
};

export const systemAndThinkingScenario: MockChatScenario = {
  id: "system-and-thinking",
  mode: "seeded",
  route: {
    initialPath: `/chat/${systemThinkingId}`,
    conversationId: systemThinkingId,
  },
  seededConversation: {
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
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:01.000Z",
      ),
    ],
  },
  assertions: {
    visibleText: [
      "System Prompt",
      "Use staging credentials only.",
      "Need to inspect config first.",
      "Double-checking the staging environment details.",
    ],
  },
};

export const todoApprovalScenario: MockChatScenario = {
  id: "todo-approval",
  mode: "seeded",
  route: {
    initialPath: `/chat/${todoApprovalId}`,
    conversationId: todoApprovalId,
  },
  seededConversation: {
    messages: [
      assistantMessage(
        "assistant-todo-approval",
        [
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
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  assertions: {
    visibleText: ["Tasks", "Find GitHub tools", "Request approval"],
    visibleButtons: ["Approve", "Deny"],
  },
};

export const authStatesScenario: MockChatScenario = {
  id: "auth-states",
  mode: "seeded",
  route: {
    initialPath: `/chat/${authStatesId}`,
    conversationId: authStatesId,
  },
  seededConversation: {
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
                  message: 'Expired or invalid authentication for "id-jag test".',
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
  assertions: {
    visibleText: [
      "Your credentials for",
      "id-jag test",
      "Ask the agent owner or an admin to re-authenticate",
      "No credentials found for",
      "jwks demo",
      "githubcopilot__remote-mcp",
    ],
    visibleButtons: ["Re-authenticate", "Set up credentials"],
  },
};

export const unsafeContextScenario: MockChatScenario = {
  id: "unsafe-context",
  mode: "seeded",
  route: {
    initialPath: `/chat/${unsafeContextId}`,
    conversationId: unsafeContextId,
  },
  seededConversation: {
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
            text: "Done.",
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  assertions: {
    visibleText: ["Sensitive context below", "Done."],
    orderedText: ["Sensitive context below", "Done."],
  },
};

export const mcpAppEarlyUiScenario: MockChatScenario = {
  id: "mcp-app-early-ui",
  mode: "stream",
  route: {
    initialPath: `/chat/${mcpAppEarlyUiId}`,
    conversationId: mcpAppEarlyUiId,
  },
  request: {
    assertLastUserMessageIncludes: "open the app",
  },
  seededConversation: {
    messages: [],
  },
  stream: {
    events: [
      {
        type: "tool-call",
        toolCallId: "mcp-app-call",
        toolName: "github__open_pull_request",
        input: { owner: "openai", repo: "openai-node", number: 42 },
      },
      {
        type: "data-tool-ui-start",
        toolCallId: "mcp-app-call",
        toolName: "github__open_pull_request",
        uiResourceUri: "ui://github/pr-view",
        html: "<div>Pull request preview</div>",
      },
      { type: "delay", ms: 300 },
      {
        type: "tool-result",
        toolCallId: "mcp-app-call",
        result: {
          state: "output-available",
          output: { ok: true, title: "Pull request preview" },
        },
      },
      {
        type: "assistant-text",
        text: "The pull request preview is ready.",
      },
      { type: "finish" },
    ],
  },
  assertions: {
    visibleText: ["The pull request preview is ready."],
  },
};

export const swapAgentScenario: MockChatScenario = {
  id: "swap-agent",
  mode: "seeded",
  route: {
    initialPath: `/chat/${swapAgentId}`,
    conversationId: swapAgentId,
  },
  seededConversation: {
    messages: [
      assistantMessage(
        "assistant-swap",
        [
          {
            type: "tool-sparky__swap_agent",
            toolCallId: "swap-call",
            state: "output-available",
            input: { agent_name: "GitHub Agent" },
            output: { ok: true },
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  assertions: {
    visibleText: ["Switched to GitHub Agent"],
  },
};

export const megaConversationScenario: MockChatScenario = {
  id: "mega-conversation",
  mode: "seeded",
  route: {
    initialPath: `/chat/${megaScenarioId}`,
    conversationId: megaScenarioId,
  },
  seededConversation: {
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
      {
        id: "mega-user-attachments",
        role: "user",
        metadata: { createdAt: "2026-04-23T09:58:30.000Z" },
        parts: [
          { type: "text", text: "Attached the screenshot and trace." },
          {
            type: "file",
            url: "https://example.com/mega-screenshot.png",
            mediaType: "image/png",
            filename: "mega-screenshot.png",
          },
          {
            type: "file",
            url: "https://example.com/mega-trace.txt",
            mediaType: "text/plain",
            filename: "mega-trace.txt",
          },
        ],
      } as UIMessage,
      {
        id: "mega-user-file-only",
        role: "user",
        metadata: { createdAt: "2026-04-23T09:58:45.000Z" },
        parts: [
          {
            type: "file",
            url: "https://example.com/mega-runbook.pdf",
            mediaType: "application/pdf",
            filename: "mega-runbook.pdf",
          },
        ],
      } as UIMessage,
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
        "mega-compact-tools",
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
            type: "tool-github__list_pull_requests",
            toolCallId: "mega-call-2",
            state: "input-available",
            input: { owner: "openai", repo: "openai-node" },
          },
          {
            type: "tool-github__list_pull_requests",
            toolCallId: "mega-call-2",
            state: "output-available",
            input: { owner: "openai", repo: "openai-node" },
            output: { pullRequests: [{ number: 7 }] },
          },
          {
            type: "text",
            text: "Compact tool group completed.",
          },
        ] as UIMessage["parts"],
        "2026-04-23T09:59:20.000Z",
      ),
      assistantMessage(
        "mega-dynamic-tool",
        [
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "mega-dyn-1",
            state: "input-available",
            input: { query: "mega scenario release notes" },
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
            text: "Dynamic tool branch completed.",
          },
        ] as UIMessage["parts"],
        "2026-04-23T09:59:30.000Z",
      ),
      assistantMessage(
        "mega-early-ui",
        [
          {
            type: "data-tool-ui-start",
            data: {
              toolCallId: "mega-ui-1",
              toolName: "github__open_pull_request",
              uiResourceUri: "ui://github/pr-view",
              html: "<div>Pull request preview</div>",
            },
          } as never,
          {
            type: "tool-github__open_pull_request",
            toolCallId: "mega-ui-1",
            state: "input-available",
            input: { owner: "openai", repo: "openai-node", number: 42 },
          },
          {
            type: "tool-github__open_pull_request",
            toolCallId: "mega-ui-1",
            state: "output-available",
            input: { owner: "openai", repo: "openai-node", number: 42 },
            output: { ok: true, title: "Pull request preview" },
          },
          {
            type: "text",
            text: "Early UI start branch completed.",
          },
        ] as UIMessage["parts"],
        "2026-04-23T09:59:40.000Z",
      ),
      assistantMessage(
        "mega-todo",
        [
          {
            type: "tool-archestra__todo_write",
            toolCallId: "mega-todo-1",
            state: "approval-requested",
            input: {
              todos: [
                { content: "Collect scenarios", status: "completed" },
                { content: "Approve mega demo", status: "pending" },
              ],
            },
            approval: { id: "mega-approval-1" },
          },
        ] as UIMessage["parts"],
        "2026-04-23T09:59:50.000Z",
      ),
      assistantMessage(
        "mega-auth-errors",
        [
          {
            type: "tool-id-jag_test__get_server_info",
            toolCallId: "mega-auth-expired",
            state: "output-available",
            input: {},
            output: {
              isError: true,
              _meta: {
                archestraError: {
                  type: "auth_expired",
                  message: 'Expired or invalid authentication for "id-jag test".',
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
            toolCallId: "mega-assigned",
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
        "2026-04-23T10:00:00.000Z",
      ),
      assistantMessage(
        "mega-auth-required",
        [
          {
            type: "text",
            text: 'Authentication required for "jwks demo".\n\nNo credentials were found for your account (user: usr_123).\nTo set up your credentials, visit this URL: http://localhost:3000/mcp/registry?install=cat_install',
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:10.000Z",
      ),
      assistantMessage(
        "mega-unsafe",
        [
          {
            type: "tool-read_email",
            toolCallId: "mega-unsafe-call",
            state: "output-available",
            input: { folder: "security" },
            output: {
              content: "ARCH_TEST = secret-value",
              unsafeContextBoundary: {
                kind: "tool_result",
                reason: "tool_result_marked_untrusted",
                toolCallId: "mega-unsafe-call",
                toolName: "read_email",
              },
            },
          },
          {
            type: "text",
            text: "Unsafe context is now active.",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:20.000Z",
      ),
      assistantMessage(
        "mega-policy-denied",
        [
          {
            type: "text",
            text: "\nI tried to invoke the internal-dev-test-server__print_archestra_test tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains sensitive data",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:30.000Z",
      ),
      assistantMessage(
        "mega-swap",
        [
          {
            type: "tool-sparky__swap_agent",
            toolCallId: "mega-swap-call",
            state: "output-available",
            input: { agent_name: "GitHub Agent" },
            output: { ok: true },
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:40.000Z",
      ),
    ],
    chatErrors: [
      chatError(
        "mega-error",
        megaScenarioId,
        "2026-04-23T09:58:15.000Z",
        "Previous attempt failed",
      ),
    ],
  },
  assertions: {
    visibleText: [
      "System Prompt",
      "Always prefer the staging environment first.",
      "Show me every chat block and feature.",
      "Attached the screenshot and trace.",
      "mega-trace.txt",
      "mega-runbook.pdf",
      "Gathering every render branch.",
      "Here is the combined demo.",
      "Streaming reasoning block inside the mega conversation.",
      "mega-summary.pdf",
      "mega-results.csv",
      "Compact tool group completed.",
      "Dynamic tool branch completed.",
      "Early UI start branch completed.",
      "Tasks",
      "Collect scenarios",
      "Approve mega demo",
      "Your credentials for",
      "id-jag test",
      "Ask the agent owner or an admin to re-authenticate",
      "No credentials found for",
      "jwks demo",
      "githubcopilot__remote-mcp",
      "Sensitive context below",
      "Unsafe context is now active.",
      "Rejected",
      "Previous attempt failed",
    ],
    visibleButtons: [
      "Approve",
      "Deny",
      "Re-authenticate",
      "Set up credentials",
    ],
    visibleImages: ["mega-screenshot.png"],
    orderedText: [
      "Show me every chat block and feature.",
      "Previous attempt failed",
      "Here is the combined demo.",
      "Compact tool group completed.",
      "Dynamic tool branch completed.",
      "Early UI start branch completed.",
      "Sensitive context below",
      "Switched to GitHub Agent",
    ],
  },
};

export const megaConversationStreamScenario: MockChatScenario = {
  id: "mega-conversation-stream",
  mode: "hybrid",
  route: {
    initialPath: `/chat/${megaStreamingScenarioId}`,
    conversationId: megaStreamingScenarioId,
  },
  request: {
    assertLastUserMessageIncludes: "show me the streaming mega conversation",
  },
  seededConversation: {
    messages: [
      systemMessage(
        "mega-stream-system",
        "Always prefer the staging environment first.",
        "2026-04-23T09:57:00.000Z",
      ),
      userMessage(
        "mega-stream-user-text",
        "Show me every chat block and feature.",
        "2026-04-23T09:58:00.000Z",
      ),
      {
        id: "mega-stream-user-attachments",
        role: "user",
        metadata: { createdAt: "2026-04-23T09:58:30.000Z" },
        parts: [
          { type: "text", text: "Attached the screenshot and trace." },
          {
            type: "file",
            url: "https://example.com/mega-screenshot.png",
            mediaType: "image/png",
            filename: "mega-screenshot.png",
          },
          {
            type: "file",
            url: "https://example.com/mega-trace.txt",
            mediaType: "text/plain",
            filename: "mega-trace.txt",
          },
        ],
      } as UIMessage,
    ],
    chatErrors: [
      chatError(
        "mega-stream-error",
        megaStreamingScenarioId,
        "2026-04-23T09:58:15.000Z",
        "Previous attempt failed",
      ),
    ],
  },
  stream: {
    events: [
      {
        type: "assistant-reasoning",
        text: "Streaming reasoning block inside the mega conversation.",
      },
      { type: "delay", ms: 150 },
      {
        type: "assistant-text",
        text: "Here is the combined demo.",
      },
      {
        type: "tool-call",
        toolCallId: "mega-stream-call-1",
        toolName: "github__list_issues",
        input: { owner: "openai", repo: "openai-node" },
      },
      {
        type: "tool-result",
        toolCallId: "mega-stream-call-1",
        result: {
          state: "output-available",
          output: { issues: [{ number: 1 }] },
        },
      },
      {
        type: "tool-call",
        toolCallId: "mega-stream-call-2",
        toolName: "github__list_pull_requests",
        input: { owner: "openai", repo: "openai-node" },
      },
      {
        type: "tool-result",
        toolCallId: "mega-stream-call-2",
        result: {
          state: "output-available",
          output: { pullRequests: [{ number: 7 }] },
        },
      },
      {
        type: "assistant-text",
        text: "Compact tool group completed.",
      },
      {
        type: "tool-call",
        toolCallId: "mega-stream-dyn-1",
        toolName: "web_search",
        input: { query: "mega scenario release notes" },
        dynamic: true,
      },
      {
        type: "tool-result",
        toolCallId: "mega-stream-dyn-1",
        result: {
          state: "output-available",
          dynamic: true,
          output: { results: [{ title: "Mega release notes" }] },
        },
      },
      {
        type: "assistant-text",
        text: "Dynamic tool branch completed.",
      },
      {
        type: "tool-call",
        toolCallId: "mega-stream-ui-1",
        toolName: "github__open_pull_request",
        input: { owner: "openai", repo: "openai-node", number: 42 },
      },
      {
        type: "data-tool-ui-start",
        toolCallId: "mega-stream-ui-1",
        toolName: "github__open_pull_request",
        uiResourceUri: "ui://github/pr-view",
        html: "<div>Pull request preview</div>",
      },
      {
        type: "tool-result",
        toolCallId: "mega-stream-ui-1",
        result: {
          state: "output-available",
          output: { ok: true, title: "Pull request preview" },
        },
      },
      {
        type: "assistant-text",
        text: "Early UI start branch completed.",
      },
      {
        type: "tool-call",
        toolCallId: "mega-stream-todo-1",
        toolName: "archestra__todo_write",
        input: {
          todos: [
            { content: "Collect scenarios", status: "completed" },
            { content: "Approve mega demo", status: "pending" },
          ],
        },
      },
      {
        type: "tool-result",
        toolCallId: "mega-stream-todo-1",
        result: {
          state: "output-available",
          output: {
            todos: [
              { content: "Collect scenarios", status: "completed" },
              { content: "Approve mega demo", status: "pending" },
            ],
          },
        },
      },
      {
        type: "assistant-text",
        text: "Tasks are visible in the streamed mega conversation.",
      },
      {
        type: "tool-call",
        toolCallId: "mega-stream-unsafe",
        toolName: "read_email",
        input: { folder: "security" },
      },
      {
        type: "tool-result",
        toolCallId: "mega-stream-unsafe",
        result: {
          state: "output-available",
          output: {
            content: "ARCH_TEST = secret-value",
            unsafeContextBoundary: {
              kind: "tool_result",
              reason: "tool_result_marked_untrusted",
              toolCallId: "mega-stream-unsafe",
              toolName: "read_email",
            },
          },
        },
      },
      {
        type: "assistant-text",
        text: "Unsafe context is now active.",
      },
      {
        type: "tool-call",
        toolCallId: "mega-stream-swap",
        toolName: "sparky__swap_agent",
        input: { agent_name: "GitHub Agent" },
      },
      {
        type: "tool-result",
        toolCallId: "mega-stream-swap",
        result: {
          state: "output-available",
          output: { ok: true },
        },
      },
      { type: "finish" },
    ],
  },
  assertions: {
    visibleText: [
      "Always prefer the staging environment first.",
      "Show me every chat block and feature.",
      "Attached the screenshot and trace.",
      "mega-trace.txt",
      "Previous attempt failed",
      "Streaming reasoning block inside the mega conversation.",
      "Here is the combined demo.",
      "Compact tool group completed.",
      "Dynamic tool branch completed.",
      "Early UI start branch completed.",
      "Tasks are visible in the streamed mega conversation.",
      "Sensitive context below",
      "Unsafe context is now active.",
      "Switched to GitHub Agent",
    ],
    visibleImages: ["mega-screenshot.png"],
    orderedText: [
      "Show me every chat block and feature.",
      "Previous attempt failed",
      "Streaming reasoning block inside the mega conversation.",
      "Here is the combined demo.",
      "Compact tool group completed.",
      "Dynamic tool branch completed.",
      "Early UI start branch completed.",
      "Sensitive context below",
      "Switched to GitHub Agent",
    ],
  },
};

export const mixedDemoScenario: MockChatScenario = {
  id: "mixed-demo",
  mode: "hybrid",
  route: {
    initialPath: `/chat/${mixedDemoId}`,
    conversationId: mixedDemoId,
  },
  request: {
    assertLastUserMessageIncludes: "show me everything",
  },
  seededConversation: {
    messages: [
      userMessage(
        "seed-user",
        "Initial seeded context",
        "2026-04-23T09:58:00.000Z",
      ),
    ],
    chatErrors: [
      chatError(
        "seed-error",
        mixedDemoId,
        "2026-04-23T09:59:00.000Z",
        "Previous attempt failed",
      ),
    ],
  },
  stream: {
    events: [
      {
        type: "assistant-reasoning",
        text: "Collecting the previous failure and the current tool state.",
      },
      { type: "delay", ms: 250 },
      {
        type: "tool-call",
        toolCallId: "mixed-tool",
        toolName: "read_email",
        input: { folder: "security" },
      },
      {
        type: "tool-result",
        toolCallId: "mixed-tool",
        result: {
          state: "output-available",
          output: {
            content: "security@example.com",
            unsafeContextBoundary: {
              kind: "tool_result",
              reason: "tool_result_marked_untrusted",
              toolCallId: "mixed-tool",
              toolName: "read_email",
            },
          },
        },
      },
      {
        type: "assistant-text",
        text: "Sensitive context is now active, and the previous error is preserved above.",
      },
      { type: "finish" },
    ],
  },
  assertions: {
    visibleText: [
      "Initial seeded context",
      "Previous attempt failed",
      "Collecting the previous failure and the current tool state.",
      "Sensitive context below",
      "Sensitive context is now active, and the previous error is preserved above.",
    ],
    orderedText: [
      "Initial seeded context",
      "Previous attempt failed",
      "Collecting the previous failure and the current tool state.",
      "Sensitive context below",
      "Sensitive context is now active, and the previous error is preserved above.",
    ],
  },
};

export const mockChatScenarios: MockChatScenario[] = [
  timelineErrorsScenario,
  reasoningAndTextScenario,
  compactToolsScenario,
  fileVariantsScenario,
  dynamicToolScenario,
  preexistingUnsafeScenario,
  policyDeniedScenario,
  systemAndThinkingScenario,
  todoApprovalScenario,
  authStatesScenario,
  unsafeContextScenario,
  mcpAppEarlyUiScenario,
  swapAgentScenario,
  megaConversationScenario,
  megaConversationStreamScenario,
  mixedDemoScenario,
];

function userMessage(id: string, text: string, createdAt: string): UIMessage {
  return {
    id,
    role: "user",
    metadata: { createdAt },
    parts: [{ type: "text", text }],
  } as UIMessage;
}

function assistantMessage(
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

function systemMessage(id: string, text: string, createdAt: string): UIMessage {
  return {
    id,
    role: "system",
    metadata: { createdAt },
    parts: [{ type: "text", text }],
  } as UIMessage;
}

function chatError(
  id: string,
  conversationId: string,
  createdAt: string,
  message: string,
): PersistedChatError {
  return {
    id,
    conversationId,
    createdAt,
    error: {
      code: "server_error",
      message,
      isRetryable: true,
    },
  };
}
