import {
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
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
import { McpTaskProvider } from "./mcp-task-context";
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
  ] as const)("shows the request of %s as for any tool, above its result (wrapped: %s)", (shortName, wrapped) => {
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
    // The card differs from another tool's only in how its result reads: a
    // diff or one line, in place of the raw result.
    const request = screen.getByText("Request");
    const result = screen.getByText("Result");
    const special = shortName.startsWith("preview")
      ? screen.getByLabelText("Policy diff")
      : screen.getByText("Opened PR #7");
    expect(screen.getByText(/"expectedRevision":/)).toBeVisible();
    expect(special).toBeVisible();
    expect(
      request.compareDocumentPosition(result) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      result.compareDocumentPosition(special) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText(/"delivery":/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Arguments" }),
    ).not.toBeInTheDocument();
  });

  it("tells its host before a circle's card opens and before it closes", () => {
    mockGetToolShortName.mockReturnValue(null);
    const onBeforeToggle = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "read-1",
              toolName: "fs__read_file",
              part: {
                type: "tool-fs__read_file",
                state: "output-available",
                toolCallId: "call-read",
                input: { path: "/notes.md" },
                output: "notes",
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
          onBeforeToggle={onBeforeToggle}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "read file" }));
    expect(onBeforeToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "read file" }));
    expect(onBeforeToggle).toHaveBeenCalledTimes(2);
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
    // The raw result does not stand in for the diff; the request shows as
    // for any tool.
    expect(screen.queryByText(/"stage":/)).not.toBeInTheDocument();
    expect(screen.getByText("mcpServerId")).toBeVisible();
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
    return onToolApprovalResponse;
  };

  it("asks the person to approve a proposed file by pointing at its preview, printing no second diff, and opens no pull request before they do", () => {
    const onToolApprovalResponse = renderProposal(RULES_AFTER);
    // Both the preview's diff and the pending approval card open automatically
    // under their circles in order; the proposal carries no duplicate diff,
    // and its request shows as for any tool.
    expect(
      screen.getByRole("button", {
        name: "propose guardrails server rules change (approval required)",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByLabelText("Policy diff")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Arguments" }),
    ).not.toBeInTheDocument();
    // One request per card: the preview's and the proposal's.
    expect(screen.getAllByText("expectedCommit")).toHaveLength(2);
    expect(
      screen.getAllByText("Adds a note to the Helpdesk rules.").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("The change previewed above")).toBeVisible();
    expect(screen.getAllByText("mcp/helpdesk.toml")).toHaveLength(2);
    expect(
      screen.getByText(
        "Approving opens a pull request with the change previewed above on the policy repository. It merges by itself once its checks pass.",
      ),
    ).toBeVisible();
    // Collapsing the preview leaves only the proposal open, confirming the
    // proposal card itself renders no diff of its own.
    fireEvent.click(
      screen.getByRole("button", {
        name: "preview guardrails server rules change",
      }),
    );
    expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
    expect(screen.getByText("The change previewed above")).toBeVisible();
    expect(screen.getByText("mcp/helpdesk.toml")).toBeVisible();
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
    // The proposal opens automatically under its circle alongside the earlier
    // preview; collapsing the preview leaves only the unpreviewed proposal.
    expect(screen.getAllByLabelText("Policy diff")).toHaveLength(1);
    expect(screen.getByText(/# and one more line/)).toBeVisible();
    expect(
      screen.getByText("Review this tool call before it can continue."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: "preview guardrails server rules change",
      }),
    );
    expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
    expect(screen.getByText(/# and one more line/)).toBeVisible();
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
    ).toHaveAttribute("href", "/openappa/validation");
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
        "/openappa/validation/file?path=traces%2Fcheck.appa",
      );
    }
    rerender(show({ structuredContent: { ...publication, run: null } }));
    expect(screen.getByText("· saved ·")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View Validations" }),
    ).toHaveAttribute("href", "/openappa/validation");
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

  it("shows a denial notice as one call: the one the model tried, blocked, with its ruling", async () => {
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
                // As stored: the ruling, with the identity the notice ran as.
                output: {
                  _meta: {
                    archestraExecutedAs: {
                      kind: "platform",
                      callerUserId: "user-1",
                    },
                  },
                  content: "[appa] Blocked: this call cannot run yet.",
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
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["load skill (blocked)"]);

    fireEvent.click(
      screen.getByRole("button", { name: "load skill (blocked)" }),
    );

    // The card is the attempted call: its name, a Blocked state, and the
    // arguments the model sent.
    expect(screen.getByText("archestra__load_skill")).toBeVisible();
    expect(container).toHaveTextContent('"name": "appa-guide"');
    // The identity sits on the card's own header.
    expect(
      screen.getByText("archestra__load_skill").closest("button"),
    ).toHaveTextContent("Called as");

    // Below them is the notice call's result as the model got it, in the
    // standard result block under the Guardrails mark. The notice call is
    // not a second call on screen.
    // "Blocked" is the card's state and the label of the result's field.
    const [state, ruling] = screen.getAllByText("Blocked");
    expect(state.closest("button")).toHaveTextContent("archestra__load_skill");
    expect(ruling).toBeVisible();
    expect(
      ruling.parentElement?.querySelector("svg.lucide-open-appa"),
    ).not.toBeNull();
    expect(container).not.toHaveTextContent("get_remedy_plans");
    expect(container).not.toHaveTextContent("Completed");
    // The result is prose, so its block wraps to the card.
    expect(wrapsToTheCard(ruling)).toBe(true);

    // The ruling shows once. The notice's arguments repeat the attempt and
    // the ruling, so they are not listed again.
    expect(
      container.textContent?.split("[appa] Blocked: this call cannot run yet.")
        .length,
    ).toBe(2);
    expect(container).not.toHaveTextContent("call_id");
    expect(container).not.toHaveTextContent('"ruling"');
  });

  it("shows a get_remedy_plans call that carries no notice as an ordinary call", () => {
    const toolName = "archestra__get_remedy_plans";
    mockGetToolShortName.mockImplementation((name: string) =>
      name === toolName ? TOOL_GET_REMEDY_PLANS_SHORT_NAME : null,
    );
    vi.mocked(useSession).mockReturnValue({ data: undefined } as never);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "direct-1",
              toolName,
              part: {
                type: `tool-${toolName}`,
                state: "output-available",
                toolCallId: "call-direct",
                input: {},
                output: "No call is blocked.",
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("button", { name: "get remedy plans" }),
    ).toBeVisible();
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
    mockGetToolShortName.mockImplementation((name: string) =>
      name === remedyToolName ? TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME : null,
    );
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

  describe("a guarded call", () => {
    const ruling =
      '[appa] Blocked.\n  - archestra__execute_remedy_plan(offer_id: "0a0a0a0a0a0a0a0a", plan: "Share it")';
    const notice = {
      kind: "tool" as const,
      key: "notice-1",
      toolName: "archestra__get_remedy_plans",
      part: {
        type: "tool-archestra__get_remedy_plans",
        state: "output-available",
        toolCallId: "call-notice",
        input: {
          tool: "fs__read_file",
          arguments: { path: "/notes.md" },
          ruling,
          notice: { v: 1, call_id: "call-notice" },
        },
        output: ruling,
      } as never,
      toolResultPart: null,
      errorText: undefined,
    };
    const remedy = (part: Record<string, unknown>) => ({
      kind: "tool" as const,
      key: "remedy-1",
      toolName: "archestra__execute_remedy_plan",
      part: {
        type: "tool-archestra__execute_remedy_plan",
        toolCallId: "call-remedy",
        input: { offer_id: "0a0a0a0a0a0a0a0a", plan: "Share it" },
        ...part,
      } as never,
      toolResultPart: null,
      errorText:
        typeof part.errorText === "string" ? part.errorText : undefined,
    });
    const retry = {
      kind: "tool" as const,
      key: "retry-1",
      toolName: "fs__read_file",
      part: {
        type: "tool-fs__read_file",
        state: "output-available",
        toolCallId: "call-retry",
        input: { path: "/notes.md" },
        output: "notes",
      } as never,
      toolResultPart: null,
      errorText: undefined,
    };
    const row = (tools: Parameters<typeof CompactToolGroup>[0]["tools"]) => {
      mockGetToolShortName.mockImplementation((name: string) =>
        name.startsWith("archestra__") ? name.replace("archestra__", "") : null,
      );
      vi.mocked(useSession).mockReturnValue({ data: undefined } as never);
      return (
        <QueryClientProvider client={new QueryClient()}>
          <CompactToolGroup tools={tools} onToolApprovalResponse={vi.fn()} />
        </QueryClientProvider>
      );
    };

    it.each([
      {
        name: "still running",
        part: { state: "input-available", output: undefined },
        turnActive: true,
        circle: "read file (running)",
        status: "Running",
      },
      {
        name: "failed",
        part: {
          state: "output-error",
          output: undefined,
          errorText: "The notice could not be delivered",
        },
        errorText: "The notice could not be delivered",
        turnActive: false,
        circle: "read file (error)",
        status: "Error",
      },
      {
        name: "cut off when its turn ended",
        part: { state: "input-available", output: undefined },
        turnActive: false,
        circle: "read file (cancelled)",
        status: "Cancelled",
      },
    ])("names a notice that is $name after the call it blocked, without calling it blocked", ({
      part,
      errorText,
      turnActive,
      circle,
      status,
    }) => {
      mockGetToolShortName.mockImplementation((name: string) =>
        name.startsWith("archestra__") ? name.replace("archestra__", "") : null,
      );
      vi.mocked(useSession).mockReturnValue({ data: undefined } as never);
      const { container } = render(
        <QueryClientProvider client={new QueryClient()}>
          <CompactToolGroup
            turnActive={turnActive}
            tools={[
              {
                ...notice,
                part: { ...(notice.part as object), ...part } as never,
                errorText,
              },
            ]}
          />
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByRole("button", { name: circle }));
      // The card is the attempted call, in the notice's own state.
      const header = screen.getByText("fs__read_file").closest("button");
      expect(header).toHaveTextContent(status);
      expect(container).not.toHaveTextContent("Blocked");
      expect(container).not.toHaveTextContent("get_remedy_plans");
    });

    it("shows the blocked attempt, the remedy and the released call as three circles", () => {
      const { container } = render(
        row([
          notice,
          remedy({ state: "output-available", output: "[appa] Authorized." }),
          retry,
        ]),
      );

      expect(
        screen
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["read file (blocked)", "execute remedy plan", "read file"]);

      // The Guardrails runtime's own call carries its mark. Both calls to
      // the tool keep the tool's icon, the blocked one included.
      const marked = (name: string) =>
        screen
          .getByRole("button", { name })
          .querySelector("svg.lucide-open-appa") !== null;
      expect(marked("read file (blocked)")).toBe(false);
      expect(marked("execute remedy plan")).toBe(true);
      expect(marked("read file")).toBe(false);

      // The released call's card is its own request and result. Another
      // tool's result keeps its lines as the tool wrote them.
      fireEvent.click(screen.getByRole("button", { name: "read file" }));
      expect(container).toHaveTextContent('"path": "/notes.md"');
      expect(wrapsToTheCard(screen.getByText("Result"))).toBe(false);
      expect(screen.queryByText("Guardrails")).not.toBeInTheDocument();
    });

    it("opens the plan when a step already on screen starts waiting for approval", () => {
      const { rerender, container } = render(
        row([notice, remedy({ state: "input-available" })]),
      );
      expect(container).not.toHaveTextContent("Share it");

      rerender(
        row([
          notice,
          remedy({
            state: "approval-requested",
            approval: { id: "approval-1" },
          }),
        ]),
      );

      expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();
      expect(container).toHaveTextContent("Share it");
    });

    it("shows why a remedy failed, as the tool returned it", () => {
      render(
        row([
          notice,
          remedy({
            state: "output-error",
            errorText: "[appa] Not authorized.",
          }),
        ]),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "execute remedy plan (error)" }),
      );

      expect(screen.getByText("[appa] Not authorized.")).toBeVisible();
    });

    it("shows a settled remedy's request and result as the call sent and got them", () => {
      const { container } = render(
        row([
          remedy({
            state: "output-available",
            output: {
              content: [
                {
                  type: "text",
                  text: "[appa] Authorized. Call the fs__read_file tool again with exactly these arguments: {}",
                },
              ],
            },
          }),
        ]),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "execute remedy plan" }),
      );

      // The request is the call's own payload, like any tool's.
      expect(container).toHaveTextContent('"offer_id": "0a0a0a0a0a0a0a0a"');
      expect(container).toHaveTextContent('"plan": "Share it"');
      // The result is shown as the tool returned it, like any tool's.
      const request = screen.getByText("Request");
      const result = screen.getByText("Result");
      expect(
        request.compareDocumentPosition(result) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(container).toHaveTextContent(
        "[appa] Authorized. Call the fs__read_file tool again with exactly these arguments: {}",
      );
      // The runtime answers in prose, so the block wraps to the card.
      expect(wrapsToTheCard(result)).toBe(true);
      // The circle carries the Guardrails mark; the card does not repeat it.
      expect(
        request.closest("[data-state]")?.querySelector("svg.lucide-open-appa"),
      ).toBeNull();
    });
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
        turnActive
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

  it("auto-opens an approval-requested circle even when canExpandToolCalls is false and toggles on click", () => {
    const onToolApprovalResponse = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          canExpandToolCalls={false}
          onToolApprovalResponse={onToolApprovalResponse}
          tools={[
            {
              kind: "tool",
              key: "approval-1",
              toolName: "github__delete_branch",
              part: {
                type: "tool-github__delete_branch",
                state: "approval-requested",
                toolCallId: "call-approval",
                input: { branch: "stale" },
                approval: { id: "apr-1" },
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );

    const circle = screen.getByRole("button", {
      name: "delete branch (approval required)",
    });
    expect(circle).toHaveAttribute("aria-expanded", "true");
    expect(circle.querySelector(".bg-amber-500")).not.toBeNull();
    expect(screen.getByText(/Approval required/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();

    fireEvent.click(circle);
    expect(circle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Approval required/)).not.toBeInTheDocument();

    fireEvent.click(circle);
    expect(circle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onToolApprovalResponse).toHaveBeenCalledWith({
      id: "apr-1",
      approved: true,
    });
  });

  it("scopes policy auto-open across groups via autoOpenPolicyKey", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const previewTool = {
      kind: "tool" as const,
      key: "row-1-preview",
      toolName: "archestra__preview_guardrails_policy_change",
      part: {
        type: "tool-archestra__preview_guardrails_policy_change",
        state: "output-available",
        toolCallId: "p1",
        input: {
          expectedRevision: 3,
          edits: [{ oldText: "old", newText: "new" }],
        },
        output: {
          structuredContent: {
            stage: "preview",
            delivery: "revision",
            before: "old",
            after: "new",
          },
        },
      } as never,
      toolResultPart: null,
      errorText: undefined,
    };

    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[previewTool]}
          autoOpenPolicyKey="row-1-preview"
        />
      </QueryClientProvider>,
    );

    const circle = screen.getByRole("button", {
      name: "preview guardrails policy change",
    });
    expect(circle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Policy diff")).toBeVisible();

    // When a later row in the same message becomes the newest policy preview,
    // this earlier row collapses automatically.
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[previewTool]}
          autoOpenPolicyKey="row-2-preview"
        />
      </QueryClientProvider>,
    );
    expect(circle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
  });

  it("keeps a preview referenced by a pending proposal open alongside a newer preview even when canExpandToolCalls is false", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const previewA = previewEntry(RULES_AFTER, { diff: RULES_DIFF });
    const proposeA = proposeEntry(RULES_AFTER);
    const betaDiff =
      "--- a/mcp/billing.toml\n+++ b/mcp/billing.toml\n@@ -1,2 +1,3 @@\n [policy]\n version = 2\n+# second server\n";
    const previewB = {
      kind: "tool" as const,
      key: "preview-b",
      toolName: "archestra__preview_guardrails_server_rules_change",
      part: {
        type: "tool-archestra__preview_guardrails_server_rules_change",
        state: "output-available",
        toolCallId: "preview-b",
        input: {
          mcpServerId: "server-2",
          content: "[policy]\nversion = 2\n# second server\n",
          expectedCommit: "c2",
        },
        output: storedResult({
          valid: true,
          path: "mcp/billing.toml",
          mcpServer: { id: "server-2", name: "Billing" },
          diff: betaDiff,
        }),
      } as never,
      toolResultPart: null,
      errorText: undefined,
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <PreviewedChangesProvider
          value={collectPreviewedChanges(
            [
              {
                id: "m1",
                role: "assistant",
                parts: [previewA.part, proposeA.part, previewB.part],
              } as never,
            ],
            (name: string) => name.replace(/^archestra__/, "") as never,
          )}
        >
          <CompactToolGroup
            canExpandToolCalls={false}
            tools={[previewA, proposeA, previewB]}
            autoOpenPolicyKey="preview-b"
            onToolApprovalResponse={vi.fn()}
          />
        </PreviewedChangesProvider>
      </QueryClientProvider>,
    );

    expect(screen.getAllByLabelText("Policy diff")).toHaveLength(2);
    expect(screen.getByText("The change previewed above")).toBeVisible();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeVisible();
    expect(screen.getByText("mcp/billing.toml")).toBeVisible();
  });

  it("renders inline auth cards under the circle row while keeping the error circle clickable", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "auth-1",
              toolName: "github__get_me",
              part: {
                type: "tool-github__get_me",
                state: "output-error",
                toolCallId: "call-auth",
                input: {},
                errorText: "Authentication expired",
              } as never,
              toolResultPart: null,
              errorText: "Authentication expired",
            },
          ]}
          renderAuthCard={({ toolName }) => (
            <div data-testid="inline-auth-card">Re-authenticate {toolName}</div>
          )}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("inline-auth-card")).toHaveTextContent(
      "Re-authenticate github__get_me",
    );
    const circle = screen.getByRole("button", { name: "get me (error)" });
    expect(circle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(circle);
    expect(circle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Authentication expired")).toBeVisible();
  });

  it("shows the request of a call that takes no arguments, like any other call", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "no-args",
              toolName: "github__get_me",
              part: {
                type: "tool-github__get_me",
                state: "output-available",
                toolCallId: "call-no-args",
                input: {},
                output: { content: "octocat" },
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "get me" }));
    const request = screen.getByText("Request");
    expect(request).toBeVisible();
    expect(
      request.compareDocumentPosition(screen.getByText("Result")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each([
    { turnActive: true, name: "wait then reply (running)", pulses: true },
    { turnActive: false, name: "wait then reply (cancelled)", pulses: false },
  ])("reads a call without a result as $name (turn active: $turnActive)", ({
    turnActive,
    name,
    pulses,
  }) => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          turnActive={turnActive}
          tools={[
            {
              kind: "tool",
              key: "slow",
              toolName: "fixtures__wait_then_reply",
              part: {
                type: "tool-fixtures__wait_then_reply",
                state: "input-available",
                toolCallId: "call-slow",
                input: { seconds: 60 },
              } as never,
              toolResultPart: null,
              errorText: undefined,
            },
          ]}
        />
      </QueryClientProvider>,
    );

    // Nothing runs once the turn has ended, so the circle must not keep
    // pulsing as if the call were still on its way.
    const circle = screen.getByRole("button", { name });
    const dot = circle.querySelector("span.absolute");
    expect(dot?.className.includes("animate-pulse")).toBe(pulses);
    fireEvent.click(circle);
    expect(
      screen.getByText(turnActive ? "Running" : "Cancelled"),
    ).toBeVisible();
  });

  it("keeps a waiting call queued after it became a background task, until it starts", () => {
    const entry = {
      kind: "tool" as const,
      key: "waits",
      toolName: "fixtures__waits",
      part: {
        type: "tool-fixtures__waits",
        state: "input-available",
        toolCallId: "waits",
        input: { seconds: 30 },
      } as never,
      toolResultPart: null,
      errorText: undefined,
    };
    // The task's clock covers the wait for a free place, so the task can be
    // "working" before the call has reached its server.
    const task = {
      taskId: "task-1",
      toolCallId: "waits",
      toolName: "fixtures__waits",
      status: "working" as const,
      startedAt: Date.now(),
    };
    const group = (queued: boolean) => (
      <QueryClientProvider client={new QueryClient()}>
        <McpTaskProvider
          value={{
            byToolCallId: new Map([["waits", task]]),
            cancel: () => {},
            cancelRequestedTaskIds: new Set(),
            queuedToolCallIds: new Set(queued ? ["waits"] : []),
          }}
        >
          <CompactToolGroup turnActive tools={[entry]} />
        </McpTaskProvider>
      </QueryClientProvider>
    );

    const { rerender } = render(group(true));
    expect(
      screen.getByRole("button", { name: "waits (queued)" }),
    ).toBeInTheDocument();

    rerender(group(false));
    expect(
      screen.getByRole("button", {
        name: "waits (running in the background)",
      }),
    ).toBeInTheDocument();
  });

  it.each([
    [
      "a result the tool marked as an error",
      {
        state: "output-available",
        output: { content: "Error: disk is full", isError: true },
      },
    ],
    [
      "a call that threw",
      { state: "output-error", errorText: "Error: disk is full" },
    ],
  ])("shows the error of %s once on its card", (_case, outcome) => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "failed",
              toolName: "fixtures__fail_with_error",
              part: {
                type: "tool-fixtures__fail_with_error",
                toolCallId: "call-failed",
                input: { message: "disk is full" },
                ...outcome,
              } as never,
              toolResultPart: null,
              errorText: "Error: disk is full",
            },
          ]}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "fail with error (error)" }),
    );
    // It used to appear twice: in a red box, and again as the Error section.
    expect(screen.getAllByText("Error: disk is full")).toHaveLength(1);
  });

  it("reads a call that waits for its turn on its server as queued, not running", () => {
    const call = (id: string) => ({
      kind: "tool" as const,
      key: id,
      toolName: `fixtures__${id}`,
      part: {
        type: `tool-fixtures__${id}`,
        state: "input-available",
        toolCallId: id,
        input: { seconds: 5 },
      } as never,
      toolResultPart: null,
      errorText: undefined,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <McpTaskProvider
          value={{
            byToolCallId: new Map(),
            cancel: () => {},
            cancelRequestedTaskIds: new Set(),
            queuedToolCallIds: new Set(["waits"]),
          }}
        >
          <CompactToolGroup turnActive tools={[call("runs"), call("waits")]} />
        </McpTaskProvider>
      </QueryClientProvider>,
    );

    const running = screen.getByRole("button", { name: "runs (running)" });
    const queued = screen.getByRole("button", { name: "waits (queued)" });
    expect(running.querySelector("span.absolute")?.className).toContain(
      "animate-pulse",
    );
    // A waiting call does not pulse: nothing is happening to it yet.
    expect(queued.querySelector("span.absolute")?.className).not.toContain(
      "animate-pulse",
    );
    fireEvent.click(queued);
    expect(screen.getByText("Queued")).toBeVisible();
  });
});

/**
 * Whether the code block of the section a label heads wraps its lines. The
 * block wraps on its `pre` before the highlighter loads and on the `code`
 * inside it afterwards.
 */
function wrapsToTheCard(sectionLabel: HTMLElement): boolean {
  const section = sectionLabel.parentElement?.parentElement;
  return [section?.querySelector("pre"), section?.querySelector("pre code")]
    .filter((el): el is HTMLElement => el instanceof HTMLElement)
    .some((el) => el.style.whiteSpace === "pre-wrap");
}
