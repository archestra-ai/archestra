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
    title: "Retry after provider error",
    messages: [
      userMessage(
        "timeline-user-1",
        "Can you summarize the last deployment health check?",
        baseTimestamp,
      ),
      userMessage(
        "timeline-user-2",
        "The previous response failed. Please try the deployment summary again.",
        "2026-04-23T10:02:00.000Z",
      ),
    ],
    chatErrors: [
      chatError("timeline-error-1", "2026-04-23T10:01:00.000Z", {
        message: "The model provider returned a temporary error.",
      }),
    ],
  },
  {
    id: "compact-tools",
    title: "Release triage with compact tools",
    messages: [
      assistantMessage(
        "compact-tools-assistant",
        [
          {
            type: "tool-demo__list_issues",
            toolCallId: "compact-call-1",
            state: "input-available",
            input: { owner: "example-org", repo: "checkout-service" },
          },
          {
            type: "tool-demo__list_issues",
            toolCallId: "compact-call-1",
            state: "output-available",
            input: { owner: "example-org", repo: "checkout-service" },
            output: {
              issues: [
                {
                  number: 128,
                  title: "Retry queue depth is elevated after deploy",
                },
              ],
            },
          },
          {
            type: "tool-demo__list_pull_requests",
            toolCallId: "compact-call-2",
            state: "input-available",
            input: { owner: "example-org", repo: "checkout-service" },
          },
          {
            type: "tool-demo__list_pull_requests",
            toolCallId: "compact-call-2",
            state: "output-available",
            input: { owner: "example-org", repo: "checkout-service" },
            output: {
              pullRequests: [
                {
                  number: 42,
                  title: "Add queue drain metric to release dashboard",
                },
              ],
            },
          },
          {
            type: "text",
            text: "I found one active issue about retry queue depth and one related pull request adding dashboard coverage.",
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  {
    id: "file-variants",
    title: "Incident files",
    messages: [
      {
        id: "file-user-with-text",
        role: "user",
        metadata: { createdAt: baseTimestamp },
        parts: [
          {
            type: "text",
            text: "Please review these incident materials before I send the follow-up.",
          },
          {
            type: "file",
            url: "https://placehold.co/600x400",
            mediaType: "image/png",
            filename: "latency-dashboard.png",
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
            url: "https://example.test/artifacts/network-trace.txt",
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
            url: "https://example.test/artifacts/rollback-runbook.pdf",
            mediaType: "application/pdf",
            filename: "rollback-runbook.pdf",
          },
          {
            type: "file",
            url: "https://example.test/artifacts/request-sample.csv",
            mediaType: "text/csv",
            filename: "request-sample.csv",
          },
          {
            type: "text",
            text: "The dashboard and trace sample point to a short latency spike during rollout, while the rollback runbook has the recovery steps the on-call team followed.",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:02.000Z",
      ),
    ],
  },
  {
    id: "sdk-message-parts",
    title: "Sourced answer with SDK parts",
    messages: [
      assistantMessage(
        "sdk-parts-assistant",
        [
          { type: "step-start" },
          {
            type: "reasoning",
            text: "Comparing the runbook with the published release notes before giving a short recommendation.",
            state: "done",
          },
          {
            type: "text",
            text: "The safest next step is to pause the rollout, drain the retry queue below the alert threshold, and then resume with the patched health-check configuration.",
          },
          {
            type: "source-url",
            sourceId: "release-notes-2026-04",
            url: "https://example.test/releases/2026-04-checkout",
            title: "Checkout release notes",
          },
          {
            type: "source-url",
            sourceId: "release-notes-2026-04",
            url: "https://example.test/releases/2026-04-checkout?duplicate=true",
            title: "Checkout release notes duplicate",
          },
          {
            type: "source-document",
            sourceId: "rollout-runbook-v3",
            mediaType: "application/pdf",
            title: "Rollout recovery runbook",
            filename: "rollout-recovery-runbook.pdf",
          },
          {
            type: "data-heartbeat",
            data: { timestamp: 1, phase: "source-review" },
          },
          {
            type: "data-token-usage",
            data: { inputTokens: 812, outputTokens: 94, totalTokens: 906 },
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  {
    id: "dynamic-tool",
    title: "Dynamic web search",
    messages: [
      assistantMessage(
        "dynamic-tool-assistant",
        [
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "dynamic-call-1",
            state: "input-available",
            input: { query: "checkout service April release retry queue" },
          },
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "dynamic-call-1",
            state: "output-available",
            input: { query: "checkout service April release retry queue" },
            output: {
              results: [
                {
                  title: "April checkout release notes",
                  url: "https://example.test/releases/checkout-april",
                },
              ],
            },
          },
          {
            type: "text",
            text: "The release notes mention a retry backoff change, so I would inspect queue drain metrics before rolling forward.",
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  {
    id: "system-and-thinking",
    title: "System prompt and thinking",
    messages: [
      systemMessage(
        "system-thinking-system",
        "Use only the sandbox workspace and avoid making changes unless the operator approves them.",
        baseTimestamp,
      ),
      assistantMessage(
        "system-thinking-assistant",
        [
          {
            type: "text",
            text: "<think>Confirm the target workspace and avoid side effects.</think>I will inspect the sandbox workspace first and keep the response read-only until you approve an action.",
          },
          {
            type: "reasoning",
            text: "Checking the request boundary and confirming that this turn should not mutate production data.",
            state: "done",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:01.000Z",
      ),
    ],
  },
  {
    id: "tool-states",
    title: "Tool states and approval",
    messages: [
      assistantMessage(
        "tool-states-assistant",
        [
          {
            type: "data-tool-ui-start",
            data: {
              toolCallId: "tool-ui-call-1",
              toolName: "demo__open_pull_request",
              uiResourceUri: "ui://demo/release-pr-view",
              html: "<div>Release pull request preview</div>",
            },
          } as never,
          {
            type: "tool-demo__open_pull_request",
            toolCallId: "tool-ui-call-1",
            state: "output-available",
            input: {
              owner: "example-org",
              repo: "checkout-service",
              number: 42,
            },
            output: { ok: true, title: "Release pull request preview" },
          },
          {
            type: "tool-archestra__todo_write",
            toolCallId: "todo-approval-call",
            state: "approval-requested",
            input: {
              todos: [
                { content: "Review rollout pull request", status: "completed" },
                {
                  content: "Ask operator before updating checklist",
                  status: "pending",
                },
              ],
            },
            approval: { id: "approval-1" },
          },
          {
            type: "tool-archestra__swap_agent",
            toolCallId: "swap-call",
            state: "output-available",
            input: { agent_name: "Release Coordinator" },
            output: { ok: true },
          },
          {
            type: "text",
            text: "The pull request preview is ready, and the checklist update is waiting for approval.",
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
    ],
  },
  {
    id: "auth-states",
    title: "Authentication states",
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
                  message:
                    'Expired or invalid authentication for "Issue Tracker".',
                  catalogId: "demo-catalog",
                  catalogName: "Issue Tracker",
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
                  message:
                    "Assigned credential is unavailable for this workspace.",
                  catalogId: "demo-assigned-catalog",
                  catalogName: "Remote Change Manager",
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
            text: 'Authentication required for "Issue Tracker".\n\nNo credentials were found for this sandbox account.\nTo set up credentials, visit this URL: http://localhost:3000/mcp/registry?install=demo-catalog',
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:01.000Z",
      ),
    ],
  },
  {
    id: "unsafe-and-policy",
    title: "Unsafe context and policy denial",
    messages: [
      assistantMessage(
        "unsafe-tool-assistant",
        [
          {
            type: "tool-demo__read_note",
            toolCallId: "unsafe-call",
            state: "output-available",
            input: { folder: "incident-notes" },
            output: {
              content:
                "Internal incident note contains sensitive deployment credentials.",
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
            text: "I found an internal note that must be treated as sensitive context before any follow-up tools are invoked.",
          },
        ] as UIMessage["parts"],
        baseTimestamp,
      ),
      assistantMessage(
        "unsafe-policy-denied-assistant",
        [
          {
            type: "text",
            text: "\nI tried to invoke the demo__send_incident_update tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains sensitive data",
          },
        ] as UIMessage["parts"],
        "2026-04-23T10:00:01.000Z",
      ),
    ],
  },
  {
    id: "mega-conversation",
    title: "Full incident workflow",
    messages: [
      systemMessage(
        "mega-system",
        "Prefer read-only inspection first and keep all identifiers fictional in summaries.",
        "2026-04-23T09:57:00.000Z",
      ),
      userMessage(
        "mega-user-text",
        "Walk me through the failed checkout rollout and prepare a safe operator summary.",
        "2026-04-23T09:58:00.000Z",
      ),
      assistantMessage(
        "mega-thinking",
        [
          {
            type: "text",
            text: "<think>Gather rollout status, attachments, tools, and policy state.</think>I will combine the deployment notes, attached artifacts, and tool results into a concise operator summary.",
          },
          {
            type: "reasoning",
            text: "Sequencing the investigation so tool output, files, and final summary appear in a realistic order.",
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
            url: "https://example.test/artifacts/operator-summary.pdf",
            mediaType: "application/pdf",
            filename: "operator-summary.pdf",
          },
          {
            type: "file",
            url: "https://example.test/artifacts/retry-queue-sample.csv",
            mediaType: "text/csv",
            filename: "retry-queue-sample.csv",
          },
          {
            type: "text",
            text: "I attached the operator summary draft and the retry queue sample used for the analysis.",
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
            input: { owner: "example-org", repo: "checkout-service" },
          },
          {
            type: "tool-demo__list_issues",
            toolCallId: "mega-call-1",
            state: "output-available",
            input: { owner: "example-org", repo: "checkout-service" },
            output: {
              issues: [
                {
                  number: 128,
                  title: "Retry queue depth is elevated after deploy",
                },
              ],
            },
          },
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "mega-dynamic-call-1",
            state: "output-available",
            input: { query: "checkout rollout retry queue release notes" },
            output: {
              results: [
                {
                  title: "Checkout rollout release notes",
                  url: "https://example.test/releases/checkout-rollout",
                },
              ],
            },
          },
          {
            type: "text",
            text: "The open issue and release notes both point to the retry backoff change, so the summary should call out queue drain monitoring before resuming rollout.",
          },
        ] as UIMessage["parts"],
        "2026-04-23T09:59:20.000Z",
      ),
    ],
    chatErrors: [
      chatError("mega-error", "2026-04-23T09:58:15.000Z", {
        message: "The first summary attempt timed out while waiting for tools.",
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
