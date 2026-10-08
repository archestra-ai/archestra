import {
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("shows the confirmed policy return action while tool details remain collapsed", () => {
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
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("shows combined policy previews only when the proposal changes the policy", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const client = new QueryClient();
    const proposal = {
      stage: "preview",
      delivery: "revision",
      policy: {
        before: '[policy]\nversion = 2\nname = "old"\n',
        after: '[policy]\nversion = 2\nname = "new"\n',
        changed: true,
      },
      counts: { passed: 1, failed: 1, cannotRun: 1 },
    };
    const show = (name: string, output: unknown) => (
      <QueryClientProvider client={client}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "preview",
              toolName: `archestra__${name}`,
              part: {
                type: `tool-archestra__${name}`,
                state: "output-available",
                toolCallId: "preview",
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
    const { rerender } = render(
      show("preview_openappa_validation_change", {
        structuredContent: proposal,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "preview openappa validation change",
      }),
    );
    expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
      '+name = "new"',
    );
    expect(screen.getByText("Proposed policy")).toBeInTheDocument();
    expect(
      screen.getByText("1 passed, 1 failed, 1 could not run."),
    ).toBeInTheDocument();
    rerender(
      show("preview_openappa_validation_change", {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...proposal,
              policy: { ...proposal.policy, changed: false },
            }),
          },
        ],
      }),
    );
    expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
    expect(screen.queryByText("Proposed policy")).not.toBeInTheDocument();
    rerender(show("unrelated_tool", { structuredContent: proposal }));
    expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
  });

  it("keeps saved validations and draft replay outcomes visible without claiming policy activation", () => {
    mockGetToolShortName.mockImplementation((name: string) =>
      name.replace(/^archestra__/, ""),
    );
    const client = new QueryClient();
    const publication = {
      delivery: "revision",
      revision: 2,
      version: "specs-v2",
      policyChanged: false,
      counts: { passed: 2, failed: 0, cannotRun: 0 },
    };
    const show = (output: unknown) => (
      <QueryClientProvider client={client}>
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: "publish",
              toolName: "archestra__publish_openappa_validation_change",
              part: {
                type: "tool-archestra__publish_openappa_validation_change",
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
    expect(
      screen.getByText("Draft replay: 2 passed, 0 failed, 0 could not run."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View Validations" }),
    ).toHaveAttribute("href", "/openappa/validation");
    expect(
      screen.getByRole("button", {
        name: "publish openappa validation change",
      }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Enforcement confirmed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved revision/)).not.toBeInTheDocument();
    const withFailures = {
      ...publication,
      counts: { passed: 1, failed: 1, cannotRun: 1 },
    };
    rerender(show({ content: JSON.stringify(withFailures) }));
    expect(
      screen.getByText("Draft replay: 1 passed, 1 failed, 1 could not run."),
    ).toBeInTheDocument();
    rerender(
      show({
        structuredContent: {
          ...withFailures,
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
    expect(
      screen.getByText(/Review and merge to apply these changes/),
    ).toHaveTextContent("1 failed, 1 could not run");
    expect(screen.queryByText("Saved validations")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "publish openappa validation change",
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
