import {
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useExternalMcpSkills } from "@/lib/skills/skill.query";

const mockIsToolName = vi.fn();
const mockGetToolShortName = vi.fn();

vi.mock("@/lib/mcp/archestra-mcp-server", () => ({
  useArchestraMcpIdentity: () => ({
    isToolName: mockIsToolName,
    getToolShortName: mockGetToolShortName,
  }),
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/skills/skill.query");
vi.mock("@/lib/runtime-credentials.query", () => ({
  useRuntimeCredentials: () => ({ data: [] }),
}));
vi.mock("@/components/settings/runtime-credential-definition-dialog", () => ({
  RuntimeCredentialDefinitionDialog: () => (
    <div role="dialog">Add credential</div>
  ),
}));

vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: ({
    catalogId,
  }: {
    catalogId?: string;
    icon?: string | null;
    size?: number;
  }) => <div data-testid="mcp-catalog-icon">{catalogId}</div>,
}));

import { CompactToolGroup } from "./compact-tool-call";
import {
  collectPreviewedChanges,
  PreviewedChangesProvider,
} from "./previewed-policy-change";

const LOAD_SKILL_TOOL_NAME = "archestra__load_skill";

function loadSkillEntry(input: Record<string, unknown>) {
  return {
    kind: "tool" as const,
    key: "load-skill-1",
    toolName: LOAD_SKILL_TOOL_NAME,
    part: {
      type: `tool-${LOAD_SKILL_TOOL_NAME}`,
      state: "output-available",
      toolCallId: "call-1",
      input,
      output: { ok: true },
    } as never,
    toolResultPart: null,
    errorText: undefined,
  };
}

describe("CompactToolGroup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    // Default: no tool is treated as `load_skill`, so CompactCircle stays on
    // the default code path. Tests that exercise the SkillPill branch can
    // override per-call.
    mockGetToolShortName.mockReturnValue(null);
    vi.mocked(useSession).mockReturnValue({ data: undefined } as never);
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as never);
    vi.mocked(useExternalMcpSkills).mockReturnValue({ data: [] } as never);
  });

  it.each([
    ["preview_guardrails_policy_change", false],
    ["update_guardrails_policy", false],
    ["preview_guardrails_policy_change", true],
    ["update_guardrails_policy", true],
  ] as const)("opens %s with collapsed arguments (wrapped: %s)", (shortName, wrapped) => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const toolName = `archestra__${wrapped ? "run_tool" : shortName}`;
    const args = {
      expectedRevision: 3,
      edits: [{ oldText: "old", newText: "new" }],
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "policy",
              toolName,
              part: {
                type: `tool-${toolName}`,
                state: "output-available",
                toolCallId: "policy",
                input: wrapped
                  ? { tool_name: `archestra__${shortName}`, tool_args: args }
                  : args,
                output: {
                  structuredContent: {
                    delivery: "pull_request",
                    stage: shortName.startsWith("preview")
                      ? "preview"
                      : undefined,
                    number: 7,
                    url: "https://github.com/example/policies/pull/7",
                    before: "old",
                    after: "new",
                  },
                },
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    const toggle = screen.getByRole("button", { name: "Arguments" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/"expectedRevision":/)).not.toBeInTheDocument();
    if (shortName.startsWith("preview")) {
      expect(screen.getByLabelText("Policy diff")).toBeVisible();
    } else {
      expect(screen.getByText("Opened PR #7")).toBeVisible();
    }
    fireEvent.click(toggle);
    expect(screen.getByText(/"expectedRevision":/)).toHaveTextContent("3");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("opens the latest policy result instead of an earlier preview", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const tools = [
      "preview_guardrails_policy_change",
      "update_guardrails_policy",
    ].map((shortName) => ({
      kind: "tool" as const,
      key: shortName,
      toolName: `archestra__${shortName}`,
      part: {
        type: `tool-archestra__${shortName}`,
        state: "output-available",
        toolCallId: shortName,
        input: { expectedRevision: 3 },
        output: {
          structuredContent: {
            stage: shortName.startsWith("preview") ? "preview" : undefined,
            delivery: "pull_request",
            number: 7,
            url: "https://github.com/example/policies/pull/7",
            before: "old",
            after: "new",
          },
        },
      } as never,
      toolResultPart: null,
      errorText: undefined,
    }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup tools={tools} />
      </QueryClientProvider>,
    );
    const preview = screen.getByRole("button", {
      name: "preview guardrails policy change",
    });
    const update = screen.getByRole("button", {
      name: "update guardrails policy",
    });
    expect(preview).toHaveAttribute("aria-expanded", "false");
    expect(update).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Opened PR #7")).toBeVisible();
    fireEvent.click(preview);
    expect(screen.getByLabelText("Policy diff")).toBeVisible();
    expect(update).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a validation preview on its result, with the request in place", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const toolName = "archestra__preview_guardrails_validation_change";
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "validation",
              toolName,
              part: {
                type: `tool-${toolName}`,
                state: "output-available",
                toolCallId: "validation",
                input: { expectedRevision: 3 },
                output: {
                  structuredContent: { stage: "preview", replayed: 4 },
                },
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", {
        name: "preview guardrails validation change",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    // No diff card takes the request's place, so it shows as for any tool.
    expect(screen.getByText(/"expectedRevision":/)).toBeVisible();
    expect(screen.getByText(/"replayed":/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Arguments" }),
    ).not.toBeInTheDocument();
  });

  it("shows a failed policy update's request in place, as for any tool", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const toolName = "archestra__update_guardrails_policy";
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "update",
              toolName,
              part: {
                type: `tool-${toolName}`,
                state: "output-error",
                toolCallId: "update",
                input: { expectedRevision: 3 },
                errorText: "The policy changed since revision 3.",
              } as never,
              toolResultPart: null,
              errorText: "The policy changed since revision 3.",
            },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /update guardrails policy/ }),
    );
    expect(screen.getByText(/"expectedRevision":/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Arguments" }),
    ).not.toBeInTheDocument();
  });

  // The shape a chat stores when only the model's copy of the result is
  // kept: the diff, without the two texts.
  const storedResult = (result: Record<string, unknown>) => ({
    _meta: { archestraExecutedAs: { kind: "platform" } },
    content: JSON.stringify(result),
  });
  const RULES_BEFORE = "[policy]\nversion = 2\n";
  const RULES_AFTER = "[policy]\nversion = 2\n# a note\n";
  const RULES_DIFF =
    "--- a/mcp/helpdesk.toml\n+++ b/mcp/helpdesk.toml\n@@ -1,2 +1,3 @@\n [policy]\n version = 2\n+# a note\n";
  const previewEntry = (content: string, result: Record<string, unknown>) => {
    const toolName = "archestra__preview_guardrails_server_rules_change";
    return {
      kind: "tool" as const,
      key: "preview",
      toolName,
      part: {
        type: `tool-${toolName}`,
        state: "output-available",
        toolCallId: "preview",
        input: { mcpServerId: "server-1", content, expectedCommit: "c1" },
        output: storedResult({
          stage: "preview",
          delivery: "pull_request",
          mcpServer: { id: "server-1", name: "Helpdesk" },
          path: "mcp/helpdesk.toml",
          valid: true,
          autoMerge: true,
          ...result,
        }),
      } as never,
      toolResultPart: null,
      errorText: undefined,
    };
  };

  it.each([
    [
      "a new file, every line added",
      RULES_BEFORE,
      "--- a/mcp/helpdesk.toml\n+++ b/mcp/helpdesk.toml\n@@ -0,0 +1,2 @@\n+[policy]\n+version = 2\n",
      "2 added",
    ],
    ["a changed file, its changed lines", RULES_AFTER, RULES_DIFF, "1 added"],
  ])("opens a server's rules preview on its diff, never its raw result, however the chat stored it: %s", (_case, content, diff, added) => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup tools={[previewEntry(content, { diff })]} />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", {
        name: "preview guardrails server rules change",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Policy diff")).toBeVisible();
    expect(screen.getByText(added)).toBeVisible();
    expect(screen.getByText("mcp/helpdesk.toml")).toBeVisible();
    // Neither the raw result nor the raw file stands in for the diff.
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
    expect(screen.queryByText(/"stage":/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Arguments" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText(/"mcpServerId":/)).not.toBeInTheDocument();
  });

  it("opens a rules preview on its diff for a reader who cannot open tool calls", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[previewEntry(RULES_AFTER, { diff: RULES_DIFF })]}
          canExpandToolCalls={false}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Policy diff")).toBeVisible();
    expect(screen.getByText("1 added")).toBeVisible();
  });

  const proposeEntry = (content: string) => {
    const toolName = "archestra__propose_guardrails_server_rules_change";
    return {
      kind: "tool" as const,
      key: "propose",
      toolName,
      part: {
        type: `tool-${toolName}`,
        state: "approval-requested",
        toolCallId: "propose",
        approval: { id: "approval-1" },
        input: {
          mcpServerId: "server-1",
          content,
          expectedCommit: "c1",
          summary: "Adds a note to the Helpdesk rules.",
        },
      } as never,
      toolResultPart: null,
      errorText: undefined,
    };
  };
  const renderProposal = (proposed: string) => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const preview = previewEntry(RULES_AFTER, { diff: RULES_DIFF });
    const propose = proposeEntry(proposed);
    const onToolApprovalResponse = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PreviewedChangesProvider
          value={collectPreviewedChanges(
            [
              {
                id: "m1",
                role: "assistant",
                parts: [preview.part, propose.part],
              } as never,
            ],
            (name: string) => name.replace(/^archestra__/, "") as never,
          )}
        >
          <CompactToolGroup
            tools={[preview, propose]}
            onToolApprovalResponse={onToolApprovalResponse}
          />
        </PreviewedChangesProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /^propose guardrails server rules change/,
      }),
    );
    return onToolApprovalResponse;
  };

  it("asks the person to approve a proposed file by pointing at its preview, printing neither the diff nor the file again, and opens no pull request before they do", () => {
    const onToolApprovalResponse = renderProposal(RULES_AFTER);
    // The proposal's card is the open one here: it carries no diff of its
    // own and no raw file.
    expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
    expect(screen.queryByText(/"content":/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Adds a note to the Helpdesk rules."),
    ).toBeVisible();
    expect(screen.getByText("The change previewed above")).toBeVisible();
    expect(screen.getByText("mcp/helpdesk.toml")).toBeVisible();
    expect(
      screen.getByText(
        "Approving opens a pull request with the change previewed above on the policy repository. It merges by itself once its checks pass.",
      ),
    ).toBeVisible();
    expect(onToolApprovalResponse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onToolApprovalResponse).toHaveBeenCalledWith({
      id: "approval-1",
      approved: true,
    });
  });

  it("keeps the diff on the preview's card when its file is proposed: the preview stays open, in every flow", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const preview = previewEntry(RULES_AFTER, { diff: RULES_DIFF });
    const propose = proposeEntry(RULES_AFTER);
    const shortName = (name: string) =>
      name.replace(/^archestra__/, "") as never;
    const group = (parts: unknown[]) => (
      <QueryClientProvider client={new QueryClient()}>
        <PreviewedChangesProvider
          value={collectPreviewedChanges(
            [{ id: "m1", role: "assistant", parts } as never],
            shortName,
          )}
        >
          {/* The preview's own row: a call awaiting approval has its own card. */}
          <CompactToolGroup tools={[preview]} />
        </PreviewedChangesProvider>
      </QueryClientProvider>
    );
    const view = render(group([preview.part]));
    const circle = () =>
      screen.getByRole("button", {
        name: "preview guardrails server rules change",
      });
    expect(circle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Policy diff")).toBeVisible();
    // The model proposes that file: the preview still shows its diff.
    view.rerender(group([preview.part, propose.part]));
    expect(circle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByLabelText("Policy diff")).toHaveLength(1);
  });

  it("shows what a proposal sends when its file is not the one previewed", () => {
    renderProposal(`${RULES_AFTER}# and one more line\n`);
    // No preview stands for this file: the person reads the file itself.
    expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
    expect(screen.getByText(/# and one more line/)).toBeVisible();
    expect(
      screen.getByText("Review this tool call before it can continue."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeVisible();
  });

  it.each([
    [true, "it merges once its checks pass"],
    [false, "merge it to apply"],
  ] as const)("opens a proposed server rules change on its pull request, in one line (auto-merge: %s)", (autoMerge, detail) => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const toolName = "archestra__propose_guardrails_server_rules_change";
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "propose",
              toolName,
              part: {
                type: `tool-${toolName}`,
                state: "output-available",
                toolCallId: "propose",
                input: { mcpServerId: "server-1", summary: "Starter rules" },
                output: storedResult({
                  stage: "proposed",
                  delivery: "pull_request",
                  number: 12,
                  url: "https://github.com/example/policies/pull/12",
                  mcpServer: { id: "server-1", name: "Helpdesk" },
                  path: "mcp/helpdesk.toml",
                  diff: RULES_DIFF,
                  autoMerge,
                }),
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Opened PR #12")).toBeVisible();
    expect(screen.getByText(`· ${detail} ·`)).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Review pull request/ }),
    ).toHaveAttribute("href", "https://github.com/example/policies/pull/12");
    expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
  });

  it("opens a saved policy's circle on its one-line result, with no diff", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name === "archestra__update_guardrails_policy"
        ? "update_guardrails_policy"
        : null,
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "publish",
              toolName: "archestra__update_guardrails_policy",
              part: {
                type: "tool-archestra__update_guardrails_policy",
                state: "output-available",
                toolCallId: "publish",
                input: {},
                output: {
                  structuredContent: {
                    delivery: "revision",
                    revision: 1,
                    before: "starter",
                    after: "starter",
                    enforcement: { enabled: true },
                    effective: { error: null, batteries: [] },
                  },
                },
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("link", { name: "View Guardrails" }),
    ).toHaveAttribute("href", "/openappa");
    expect(
      screen.getByRole("button", { name: "update guardrails policy" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Saved revision 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
  });

  it("keeps saved validations and their run outcomes visible without claiming policy activation", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const client = new QueryClient();
    const publication = {
      delivery: "revision",
      revision: 2,
      version: "specs-v2",
      policyChanged: false,
      validation: { valid: true, errors: [], warnings: [] },
    };
    const show = (output: unknown) => (
      <QueryClientProvider client={client}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "publish",
              toolName: "archestra__update_guardrails_validation",
              part: {
                type: "tool-archestra__update_guardrails_validation",
                state: "output-available",
                toolCallId: "publish",
                input: {},
                output,
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(show({ structuredContent: publication }));
    expect(screen.getByText("Saved validations")).toBeInTheDocument();
    expect(screen.getByText(/not run yet/)).toBeInTheDocument();
    expect(screen.queryByText(/draft replay/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View Validations" }),
    ).toHaveAttribute("href", "/openappa/policy");
    expect(
      screen.getByRole("button", {
        name: "update guardrails validation",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText(/Enforcement confirmed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved revision/)).not.toBeInTheDocument();
    rerender(show({ content: JSON.stringify(publication) }));
    expect(screen.getByText("Saved validations")).toBeInTheDocument();
    for (const [status, detail] of [
      ["passed", "passed"],
      ["failed", "failed"],
      ["cannot_run", "could not run"],
    ] as const) {
      rerender(
        show({
          structuredContent: {
            ...publication,
            run: {
              validation: { valid: true },
              files: [{ path: "traces/check.appa", status, steps: [] }],
            },
          },
        }),
      );
      expect(screen.getByText(`· ${detail} ·`)).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "View Validations" }),
      ).toHaveAttribute(
        "href",
        "/openappa/policy?entry=validation%3Atraces%2Fcheck.appa",
      );
    }
    rerender(show({ structuredContent: { ...publication, run: null } }));
    expect(screen.getByText("· saved ·")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View Validations" }),
    ).toHaveAttribute("href", "/openappa/policy");
    rerender(
      show({
        structuredContent: {
          ...publication,
          delivery: "pull_request",
          number: 17,
          url: "https://github.com/example/policies/pull/17",
          before: "unchanged policy",
          after: "unchanged policy",
        },
      }),
    );
    expect(
      screen.getByRole("link", { name: "Review pull request" }),
    ).toHaveAttribute("href", "https://github.com/example/policies/pull/17");
    expect(screen.getByText(/merge it to apply/)).toBeInTheDocument();
    expect(screen.queryByText("Saved validations")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "update guardrails validation",
      }),
    );
    expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
    rerender(show({ structuredContent: publication, isError: true }));
    expect(
      screen.queryByRole("link", { name: "View Validations" }),
    ).not.toBeInTheDocument();
  });

  it("opens the native credential dialog for a completed compact chat tool call", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name === "archestra__request_runtime_credential_setup"
        ? "request_runtime_credential_setup"
        : null,
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "setup",
              toolName: "archestra__request_runtime_credential_setup",
              part: {
                type: "tool-archestra__request_runtime_credential_setup",
                state: "output-available",
                toolCallId: "setup-call",
                input: { kind: "github_app" },
                output: {
                  action: "open_credential_dialog",
                  kind: "github_app",
                },
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("dialog", { name: "" })).toHaveTextContent(
      "Add credential",
    );
  });

  it("shows a denial notice's arguments as the object they hold", async () => {
    const noticeToolName = "archestra__get_remedy_plans";
    mockGetToolShortName.mockImplementation((name: string) =>
      name === noticeToolName ? TOOL_GET_REMEDY_PLANS_SHORT_NAME : null,
    );
    vi.mocked(useSession).mockReturnValue({ data: undefined } as never);

    // The expanded card reaches for queries of its own, so it needs a client.
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "notice-1",
              toolName: noticeToolName,
              part: {
                type: `tool-${noticeToolName}`,
                state: "output-available",
                toolCallId: "call-notice",
                // The blocked call's arguments arrive in their wire form: a JSON
                // string on the OpenAI families.
                input: {
                  tool: "archestra__load_skill",
                  arguments: '{"name":"appa-guide"}',
                  ruling: "[appa] Blocked: this call cannot run yet.",
                  notice: { v: 1, call_id: "call-notice" },
                },
                output: "[appa] Blocked: this call cannot run yet.",
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button"));

    expect(container).toHaveTextContent('"name": "appa-guide"');
  });

  it.each([
    {
      ruling: "deny",
      text: "[appa] Denied: the human reviewer refused this call to archestra__todo_write.",
      circle: "execute remedy plan (denied by you)",
      header: "Denied by you",
    },
    {
      ruling: "approve",
      text: "[appa] Authorized. Call the archestra__todo_write tool again with exactly these arguments: {}",
      circle: "execute remedy plan (approved by you)",
      header: "Approved by you",
    },
    {
      // The reviewer approved, but a policy publish retired the offer first.
      ruling: "superseded",
      text: "[appa] this offer no longer stands; re-propose the call",
      circle: "execute remedy plan (policy changed, the agent will ask again)",
      header: "Policy changed, the agent will ask again",
    },
  ])("says the viewer's own ruling on a reviewed remedy ($ruling)", ({
    ruling,
    text,
    circle,
    header,
  }) => {
    const remedyToolName = "archestra__execute_remedy_plan";
    vi.mocked(useSession).mockReturnValue({ data: undefined } as never);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "remedy-1",
              toolName: remedyToolName,
              part: {
                type: `tool-${remedyToolName}`,
                state: "output-available",
                toolCallId: "call-remedy",
                input: { offer_id: "offer-1", plan: "Human review" },
                output: {
                  content: text,
                  _meta: { archestraHumanRuling: ruling },
                },
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: circle }));

    expect(screen.getByText(header)).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("renders a compact Skill marker for a load_skill activation (no path)", () => {
    mockGetToolShortName.mockReturnValue(TOOL_LOAD_SKILL_SHORT_NAME);

    render(
      <CompactToolGroup tools={[loadSkillEntry({ name: "Build App" })]} />,
    );

    expect(screen.queryByText("Skill:")).not.toBeInTheDocument();
    expect(screen.getByText("Build App")).toBeInTheDocument();
  });

  it("explains a skill pill on hover only when the tooltip adds to its name", async () => {
    mockGetToolShortName.mockReturnValue(TOOL_LOAD_SKILL_SHORT_NAME);
    const user = userEvent.setup();
    const entry = loadSkillEntry({ name: "Build App" });
    const { rerender } = render(<CompactToolGroup tools={[entry]} />);

    await user.hover(screen.getByRole("status", { name: "Build App" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    rerender(
      <CompactToolGroup
        tools={[
          {
            ...entry,
            part: {
              ...(entry.part as object),
              state: "input-available",
              output: undefined,
            } as never,
          },
        ]}
      />,
    );
    await user.hover(screen.getByRole("status", { name: "Loading Build App" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Loading Build App",
    );
  });

  it("hides external installation qualifiers from the Skill marker", () => {
    mockGetToolShortName.mockReturnValue(TOOL_LOAD_SKILL_SHORT_NAME);

    render(
      <CompactToolGroup
        tools={[
          loadSkillEntry({
            name: "TTRPG Helper [personal:7e8933c4] / fallout-rpg",
          }),
        ]}
      />,
    );

    expect(screen.getByText("fallout-rpg")).toBeInTheDocument();
    expect(screen.queryByText(/personal:7e8933c4/)).not.toBeInTheDocument();
    const marker = screen.getByRole("status", {
      name: "fallout-rpg from TTRPG Helper",
    });
    expect(marker).toHaveAttribute("tabindex", "0");
    expect(marker).not.toHaveAttribute("title");
  });

  it("renders a plain tool circle, not a Skill pill, for a load_skill file read (with path)", () => {
    // Reading a bundled file (name + path) is a sub-action of an already-loaded
    // skill, not a second trigger — it must not paint another "Skill:" pill.
    mockGetToolShortName.mockReturnValue(TOOL_LOAD_SKILL_SHORT_NAME);
    mockIsToolName.mockReturnValue(true);

    render(
      <CompactToolGroup
        tools={[
          loadSkillEntry({ name: "Build App", path: "references/api.md" }),
        ]}
      />,
    );

    expect(screen.queryByText("Skill:")).not.toBeInTheDocument();
    expect(screen.getByTestId("mcp-catalog-icon")).toBeInTheDocument();
  });

  it("keeps the built-in MCP icon when the icon map temporarily lacks built-in tool metadata", () => {
    mockIsToolName.mockImplementation(
      (toolName: string) => toolName === "sparky__get_mcp_servers",
    );

    render(
      <CompactToolGroup
        tools={[
          {
            kind: "tool",
            key: "tool-1",
            toolName: "sparky__get_mcp_servers",
            part: {
              type: "tool-sparky__get_mcp_servers",
              state: "output-available",
              toolCallId: "call-1",
              input: {},
              output: { ok: true },
            },
            toolResultPart: null,
            errorText: undefined,
          },
        ]}
        toolIconMap={new Map()}
      />,
    );

    expect(screen.getByTestId("mcp-catalog-icon")).toHaveTextContent(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("shows the target tool's server icon for a run_tool dispatch", () => {
    mockIsToolName.mockImplementation((toolName: string) =>
      toolName.startsWith("archestra__"),
    );
    mockGetToolShortName.mockImplementation((toolName: string) =>
      toolName === "archestra__run_tool" ? TOOL_RUN_TOOL_SHORT_NAME : null,
    );

    render(
      <CompactToolGroup
        tools={[
          {
            kind: "tool",
            key: "tool-1",
            toolName: "archestra__run_tool",
            part: {
              type: "tool-archestra__run_tool",
              state: "output-available",
              toolCallId: "call-1",
              input: {
                tool_name: "context7__resolve-library-id",
                tool_args: { libraryName: "react" },
              },
              output: { ok: true },
            },
            toolResultPart: null,
            errorText: undefined,
          },
        ]}
        toolIconMap={
          new Map([
            [
              "context7__resolve-library-id",
              { icon: "data:image/png;base64,x", catalogId: "catalog-ctx7" },
            ],
          ])
        }
      />,
    );

    expect(screen.getByTestId("mcp-catalog-icon")).toHaveTextContent(
      "catalog-ctx7",
    );
  });

  it("keeps the built-in icon for a run_tool call whose target is not known yet", () => {
    mockIsToolName.mockImplementation((toolName: string) =>
      toolName.startsWith("archestra__"),
    );
    mockGetToolShortName.mockImplementation((toolName: string) =>
      toolName === "archestra__run_tool" ? TOOL_RUN_TOOL_SHORT_NAME : null,
    );

    render(
      <CompactToolGroup
        tools={[
          {
            kind: "tool",
            key: "tool-1",
            toolName: "archestra__run_tool",
            part: {
              type: "tool-archestra__run_tool",
              state: "input-streaming",
              toolCallId: "call-1",
              input: {},
            },
            toolResultPart: null,
            errorText: undefined,
          },
        ]}
        toolIconMap={new Map()}
      />,
    );

    expect(screen.getByTestId("mcp-catalog-icon")).toHaveTextContent(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("renders a hook entry as a circle and expands its card on click", async () => {
    mockIsToolName.mockReturnValue(false);

    render(
      <CompactToolGroup
        tools={[
          {
            kind: "hook",
            key: "hook-1",
            data: {
              hookEventName: "PreToolUse",
              fileName: "guard.py",
              outcome: "proceeded",
              exitCode: 0,
            },
          },
        ]}
        toolIconMap={new Map()}
      />,
    );

    // collapsed: just the circle, no expanded card
    expect(screen.queryByTestId("hook-run-chip")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByTestId("hook-run-chip")).toHaveTextContent(
      "PreToolUse",
    );
  });
});
