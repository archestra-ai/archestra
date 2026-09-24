import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type CoverageEntity,
  useAllCoverageToolsForCatalogs,
  useCoverageEntitiesForTools,
} from "@/lib/openappa-coverage.query";
import type { PickedTool } from "./setup-rule-flow";
import {
  draftRule,
  EnableStep,
  type RuleDraft,
  RuleStep,
  ToolsStep,
  type useSetupServers,
} from "./setup-steps";

vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/openappa-coverage.query", async (importOriginal) => ({
  ...(await importOriginal()),
  useAllCoverageToolsForCatalogs: vi.fn(),
  useCoverageEntitiesForTools: vi.fn(),
}));

type Setup = ReturnType<typeof useSetupServers>;

function server(name: string, toolCount: number): CoverageEntity {
  return {
    id: crypto.randomUUID(),
    name,
    type: "mcp_server",
    scope: "org",
    icon: null,
    toolCount,
    governedCount: 0,
    fallbackCount: toolCount,
    builtInCount: 0,
    autoMode: false,
  };
}

function setup(servers: CoverageEntity[]): Setup {
  const ready = servers.filter((s) => s.toolCount > 0);
  return {
    query: { isPending: false, isError: false },
    builtIn: { isPending: false, isError: false },
    servers,
    ready,
    builtInCount: 134,
    catalogs: [],
  } as unknown as Setup;
}

beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("Archestra");
});

describe("ToolsStep", () => {
  test("with only built-in tools, suggests a server without blocking", () => {
    render(<ToolsStep setup={setup([server("idle", 0)])} />);
    expect(
      screen.getByRole("region", { name: "Built into Archestra" }),
    ).toHaveTextContent("134 tools");
    const servers = screen.getByRole("region", { name: "Your MCP servers" });
    expect(servers).toHaveTextContent("You only have built-in tools.");
    expect(servers).toHaveTextContent("No tools synced");
    expect(
      screen.getByRole("link", { name: "Open MCP Registry" }),
    ).toHaveAttribute("href", "/mcp/registry");
  });

  test("with a server that has tools, lists it without the notice", () => {
    render(<ToolsStep setup={setup([server("GitHub", 19)])} />);
    const servers = screen.getByRole("region", { name: "Your MCP servers" });
    expect(servers).toHaveTextContent("1 with tools");
    expect(servers).toHaveTextContent("GitHub");
    expect(servers).not.toHaveTextContent("You only have built-in tools.");
  });
});

function picked(name: string, rule: PickedTool["rule"] = null): PickedTool {
  return {
    toolId: crypto.randomUUID(),
    fullName: `github__${name}`,
    name,
    server: "GitHub",
    catalogId: "github",
    rule,
  };
}

function agent(name: string): CoverageEntity {
  return { ...server(name, 2), type: "agent" };
}

describe("EnableStep", () => {
  test("lists the targets that reach the rule's tools, both tools first", () => {
    const source = picked("get_issue");
    const guarded = picked("create_issue");
    vi.mocked(useCoverageEntitiesForTools).mockReturnValue({
      targets: [
        { entity: agent("Reader"), toolIds: [source.toolId] },
        {
          entity: agent("Triage"),
          toolIds: [source.toolId, guarded.toolId],
        },
      ],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <EnableStep
        draft={{ shape: "flow", source, guarded }}
        alreadyOn={false}
        policy={null}
        notice={null}
      />,
    );
    const targets = screen.getByRole("region", {
      name: "Where your rule applies",
    });
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Triage");
    expect(rows[0]).toHaveTextContent("get_issue, create_issue");
    expect(rows[1]).toHaveTextContent("Reader");
    expect(rows[1]).toHaveTextContent("get_issue");
    expect(rows[1]).not.toHaveTextContent("create_issue");
    expect(targets).not.toHaveTextContent("No agent or MCP gateway");
  });

  test("warns when an earlier rule decides a tool, and when a battery rule is replaced", () => {
    vi.mocked(useCoverageEntitiesForTools).mockReturnValue({
      targets: [],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <EnableStep
        draft={{
          shape: "flow",
          source: picked("get_issue", { source: "battery" }),
          guarded: picked("create_issue", { source: "root" }),
        }}
        alreadyOn
        policy={null}
        notice={null}
      />,
    );
    expect(
      screen.getByText(/Your policy already has a rule for/),
    ).toHaveTextContent("create_issue");
    expect(
      screen.getByText(/This rule replaces a battery rule for/),
    ).toHaveTextContent("get_issue");
    expect(
      screen.getByRole("region", { name: "Where your rule applies" }),
    ).toHaveTextContent("No agent or MCP gateway can call these tools yet.");
  });
});

describe("RuleStep", () => {
  test("changing to one tool and back cannot turn a source into its own guarded tool", async () => {
    const user = userEvent.setup();
    const source = picked("get_issue");
    const guarded = picked("create_issue");
    vi.mocked(useAllCoverageToolsForCatalogs).mockReturnValue({
      tools: [
        {
          toolId: source.toolId,
          catalogId: source.catalogId,
          catalogName: source.server,
          fullName: source.fullName,
          name: source.name,
          readOnly: true,
          rule: null,
        },
      ],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAllCoverageToolsForCatalogs>);

    function DraftEditor() {
      const [draft, setDraft] = useState<RuleDraft>({
        shape: "flow",
        source,
        guarded,
      });
      const rule = draftRule(draft);
      return (
        <>
          <RuleStep
            catalogs={[{ id: "github", name: "GitHub" }]}
            draft={draft}
            policy=""
            onChange={setDraft}
            errors={[]}
          />
          <output data-testid="completed-rule">
            {rule ? `${rule.source ?? ""} -> ${rule.guarded}` : "Incomplete"}
          </output>
        </>
      );
    }

    render(<DraftEditor />);
    await user.click(
      screen.getByRole("radio", { name: /^Ask before using a toolExample:/ }),
    );
    await user.click(
      screen.getByRole("combobox", {
        name: "Tool that needs approval: create_issue. Change",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Also list tools that only read" }),
    );
    await user.click(screen.getByRole("option", { name: /^get_issue/ }));
    await user.click(
      screen.getByRole("radio", {
        name: /Ask before acting on outside content/,
      }),
    );

    expect(
      screen.getByRole("combobox", { name: "Tool that reads: pick a tool" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("completed-rule")).toHaveTextContent(
      "Incomplete",
    );
  });

  test.each([
    "flow",
    "audience",
  ] as const)("rejects an already conflicting %s draft by full name", (shape) => {
    expect(
      draftRule({
        shape,
        source: picked("get_issue"),
        guarded: picked("get_issue"),
      }),
    ).toBeNull();
  });
});
