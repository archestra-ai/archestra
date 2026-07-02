import {
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";

const mockIsToolName = vi.fn();
const mockGetToolShortName = vi.fn();

vi.mock("@/lib/mcp/archestra-mcp-server", () => ({
  useArchestraMcpIdentity: () => ({
    isToolName: mockIsToolName,
    getToolShortName: mockGetToolShortName,
  }),
}));

vi.mock("@/lib/auth/auth.query");

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
    // Default: no tool is treated as `load_skill`, so CompactCircle stays on
    // the default code path. Tests that exercise the SkillPill branch can
    // override per-call.
    mockGetToolShortName.mockReturnValue(null);
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as never);
  });

  it("renders a Skill pill for a load_skill activation (no path)", () => {
    mockGetToolShortName.mockReturnValue(TOOL_LOAD_SKILL_SHORT_NAME);

    render(
      <CompactToolGroup tools={[loadSkillEntry({ name: "Build App" })]} />,
    );

    expect(screen.getByText("Skill:")).toBeInTheDocument();
    expect(screen.getByText("Build App")).toBeInTheDocument();
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
