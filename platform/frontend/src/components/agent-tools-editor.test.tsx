import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ToolChecklist, type ToolChecklistProps } from "./agent-tools-editor";

// Mock ResizeObserver which is used by UI components
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Helper to create mock tools
function createMockTools(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `tool-${i + 1}`,
    name: `server__tool_${i + 1}`,
    description: `Description for tool ${i + 1}`,
    parameters: {},
    createdAt: new Date().toISOString(),
    group: null,
    assignedAgentCount: 0,
    assignedAgents: [],
  }));
}

function createMockTool(
  id: string,
  name: string,
  description: string,
): ToolChecklistProps["tools"][number] {
  return {
    id,
    name,
    description,
    parameters: {},
    createdAt: new Date().toISOString(),
    group: null,
    assignedAgentCount: 0,
    assignedAgents: [],
  };
}

// Wrapper component to handle state
function ToolChecklistWrapper({
  tools,
  initialSelectedIds = new Set(),
}: {
  tools: ToolChecklistProps["tools"];
  initialSelectedIds?: Set<string>;
}) {
  const [selectedToolIds, setSelectedToolIds] =
    useState<Set<string>>(initialSelectedIds);

  return (
    <ToolChecklist
      tools={tools}
      selectedToolIds={selectedToolIds}
      onSelectionChange={setSelectedToolIds}
    />
  );
}

describe("ToolChecklist", () => {
  describe("search bar visibility", () => {
    it("should not show search bar when there are 5 or fewer tools", () => {
      const tools = createMockTools(5);
      render(<ToolChecklistWrapper tools={tools} />);

      expect(
        screen.queryByPlaceholderText("Search tools..."),
      ).not.toBeInTheDocument();
    });

    it("should show search bar when there are more than 5 tools", () => {
      const tools = createMockTools(6);
      render(<ToolChecklistWrapper tools={tools} />);

      expect(
        screen.getByPlaceholderText("Search tools..."),
      ).toBeInTheDocument();
    });

    it("should show search bar when there are many tools", () => {
      const tools = createMockTools(20);
      render(<ToolChecklistWrapper tools={tools} />);

      expect(
        screen.getByPlaceholderText("Search tools..."),
      ).toBeInTheDocument();
    });
  });

  describe("search filtering", () => {
    it("should filter tools based on search query", async () => {
      const user = userEvent.setup();
      const tools = [
        ...createMockTools(5),
        createMockTool(
          "special-tool",
          "server__special_search_target",
          "A special tool to find",
        ),
      ];
      render(<ToolChecklistWrapper tools={tools} />);

      const searchInput = screen.getByPlaceholderText("Search tools...");
      await user.type(searchInput, "special");

      // The special tool should be visible
      expect(screen.getByText("special_search_target")).toBeInTheDocument();

      // Other tools should not be visible
      expect(screen.queryByText("tool_1")).not.toBeInTheDocument();
      expect(screen.queryByText("tool_2")).not.toBeInTheDocument();
    });

    it("should show 'No tools match your search' when no results", async () => {
      const user = userEvent.setup();
      const tools = createMockTools(6);
      render(<ToolChecklistWrapper tools={tools} />);

      const searchInput = screen.getByPlaceholderText("Search tools...");
      await user.type(searchInput, "nonexistent_xyz_123");

      expect(
        screen.getByText("No tools match your search"),
      ).toBeInTheDocument();
    });

    it("should be case insensitive when filtering", async () => {
      const user = userEvent.setup();
      const tools = [
        ...createMockTools(5),
        createMockTool(
          "uppercase-tool",
          "server__UPPERCASE_TOOL",
          "An uppercase tool",
        ),
      ];
      render(<ToolChecklistWrapper tools={tools} />);

      const searchInput = screen.getByPlaceholderText("Search tools...");
      await user.type(searchInput, "uppercase");

      expect(screen.getByText("UPPERCASE_TOOL")).toBeInTheDocument();
    });

    it("should filter tools by description", async () => {
      const user = userEvent.setup();
      const tools = [
        ...createMockTools(5),
        createMockTool(
          "description-match",
          "server__generic_tool",
          "This tool handles payment processing",
        ),
      ];
      render(<ToolChecklistWrapper tools={tools} />);

      const searchInput = screen.getByPlaceholderText("Search tools...");
      await user.type(searchInput, "payment");

      // The tool with "payment" in description should be visible
      expect(screen.getByText("generic_tool")).toBeInTheDocument();

      // Other tools should not be visible
      expect(screen.queryByText("tool_1")).not.toBeInTheDocument();
    });

    it("should match tools by either name or description", async () => {
      const user = userEvent.setup();
      const tools = [
        createMockTool(
          "name-match",
          "server__email_sender",
          "Sends emails to users",
        ),
        createMockTool(
          "description-match",
          "server__notification_tool",
          "Sends email notifications",
        ),
        ...createMockTools(4),
      ];
      render(<ToolChecklistWrapper tools={tools} />);

      const searchInput = screen.getByPlaceholderText("Search tools...");
      await user.type(searchInput, "email");

      // Both tools should be visible - one matches by name, one by description
      expect(screen.getByText("email_sender")).toBeInTheDocument();
      expect(screen.getByText("notification_tool")).toBeInTheDocument();

      // Other tools should not be visible
      expect(screen.queryByText("tool_1")).not.toBeInTheDocument();
    });

    it("should show all tools when search is cleared", async () => {
      const user = userEvent.setup();
      const tools = createMockTools(6);
      render(<ToolChecklistWrapper tools={tools} />);

      const searchInput = screen.getByPlaceholderText("Search tools...");
      await user.type(searchInput, "tool_1");

      // Only tool_1 should be visible
      expect(screen.getByText("tool_1")).toBeInTheDocument();
      expect(screen.queryByText("tool_2")).not.toBeInTheDocument();

      // Clear search
      await user.clear(searchInput);

      // All tools should be visible again
      expect(screen.getByText("tool_1")).toBeInTheDocument();
      expect(screen.getByText("tool_2")).toBeInTheDocument();
    });
  });

  describe("select all / deselect all with filtered results", () => {
    it("should only select filtered tools when using Select All during search", async () => {
      const user = userEvent.setup();
      const tools = [
        createMockTool("alpha-1", "server__alpha_one", "Alpha one"),
        createMockTool("alpha-2", "server__alpha_two", "Alpha two"),
        createMockTool("beta-1", "server__beta_one", "Beta one"),
        ...createMockTools(3), // Add more to show search bar
      ];

      render(<ToolChecklistWrapper tools={tools} />);

      // Search for "alpha" tools
      const searchInput = screen.getByPlaceholderText("Search tools...");
      await user.type(searchInput, "alpha");

      // Click Select All (use exact match to avoid matching "Deselect All")
      const selectAllButton = screen.getByRole("button", {
        name: "Select All",
      });
      await user.click(selectAllButton);

      // Clear search to see all tools
      await user.clear(searchInput);

      // Alpha tools should be selected
      const alphaOneCheckbox = screen.getByRole("checkbox", {
        name: /alpha_one/i,
      });
      const alphaTwoCheckbox = screen.getByRole("checkbox", {
        name: /alpha_two/i,
      });
      expect(alphaOneCheckbox).toBeChecked();
      expect(alphaTwoCheckbox).toBeChecked();

      // Beta tool should NOT be selected
      const betaOneCheckbox = screen.getByRole("checkbox", {
        name: /beta_one/i,
      });
      expect(betaOneCheckbox).not.toBeChecked();
    });

    it("should only deselect filtered tools when using Deselect All during search", async () => {
      const user = userEvent.setup();
      const tools = [
        createMockTool("alpha-1", "server__alpha_one", "Alpha one"),
        createMockTool("beta-1", "server__beta_one", "Beta one"),
        ...createMockTools(4), // Add more to show search bar
      ];

      render(
        <ToolChecklistWrapper
          tools={tools}
          initialSelectedIds={new Set(["alpha-1", "beta-1"])}
        />,
      );

      // Both should start selected
      expect(
        screen.getByRole("checkbox", { name: /alpha_one/i }),
      ).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /beta_one/i })).toBeChecked();

      // Search for "alpha" tools
      const searchInput = screen.getByPlaceholderText("Search tools...");
      await user.type(searchInput, "alpha");

      // Click Deselect All
      const deselectAllButton = screen.getByRole("button", {
        name: "Deselect All",
      });
      await user.click(deselectAllButton);

      // Clear search to see all tools
      await user.clear(searchInput);

      // Alpha tool should be deselected
      expect(
        screen.getByRole("checkbox", { name: /alpha_one/i }),
      ).not.toBeChecked();

      // Beta tool should still be selected
      expect(screen.getByRole("checkbox", { name: /beta_one/i })).toBeChecked();
    });
  });

  describe("selection count display", () => {
    it("should show correct selection count", () => {
      const tools = createMockTools(6);
      render(
        <ToolChecklistWrapper
          tools={tools}
          initialSelectedIds={new Set(["tool-1", "tool-2"])}
        />,
      );

      expect(screen.getByText("2 of 6 selected")).toBeInTheDocument();
    });

    it("should update selection count when tools are toggled", async () => {
      const user = userEvent.setup();
      const tools = createMockTools(6);
      render(<ToolChecklistWrapper tools={tools} />);

      expect(screen.getByText("0 of 6 selected")).toBeInTheDocument();

      // Click on the first tool
      const tool1Checkbox = screen.getByRole("checkbox", { name: /tool_1/i });
      await user.click(tool1Checkbox);

      expect(screen.getByText("1 of 6 selected")).toBeInTheDocument();
    });
  });

  describe("tool name formatting", () => {
    it("should display tool name without server prefix", () => {
      const tools = [
        createMockTool(
          "prefixed-tool",
          "my_server__my_actual_tool_name",
          "A tool with prefix",
        ),
        ...createMockTools(5),
      ];
      render(<ToolChecklistWrapper tools={tools} />);

      // Should show only the last part after __
      expect(screen.getByText("my_actual_tool_name")).toBeInTheDocument();
      // Should not show the full prefixed name
      expect(
        screen.queryByText("my_server__my_actual_tool_name"),
      ).not.toBeInTheDocument();
    });
  });

  describe("Select All and Deselect All", () => {
    it("should select all tools when clicking Select All", async () => {
      const user = userEvent.setup();
      const tools = createMockTools(4);
      render(<ToolChecklistWrapper tools={tools} />);

      expect(screen.getByText("0 of 4 selected")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Select All" }));

      expect(screen.getByText("4 of 4 selected")).toBeInTheDocument();
      for (const cb of screen.getAllByRole("checkbox")) {
        expect(cb).toBeChecked();
      }
    });

    it("should deselect all tools when clicking Deselect All", async () => {
      const user = userEvent.setup();
      const tools = createMockTools(4);
      render(
        <ToolChecklistWrapper
          tools={tools}
          initialSelectedIds={new Set(["tool-1", "tool-2", "tool-3", "tool-4"])}
        />,
      );

      expect(screen.getByText("4 of 4 selected")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Deselect All" }));

      expect(screen.getByText("0 of 4 selected")).toBeInTheDocument();
      for (const cb of screen.getAllByRole("checkbox")) {
        expect(cb).not.toBeChecked();
      }
    });

    it("should keep all tools visible after Deselect All empties selection", async () => {
      const user = userEvent.setup();
      const tools = createMockTools(4);
      render(
        <ToolChecklistWrapper
          tools={tools}
          initialSelectedIds={new Set(["tool-1", "tool-2"])}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Deselect All" }));

      // All tools should still be listed
      expect(screen.getByText("tool_1")).toBeInTheDocument();
      expect(screen.getByText("tool_2")).toBeInTheDocument();
      expect(screen.getByText("tool_3")).toBeInTheDocument();
      expect(screen.getByText("tool_4")).toBeInTheDocument();
    });
  });

  describe("tool sorting", () => {
    it("should sort selected tools before unselected tools", () => {
      const tools = createMockTools(4);
      render(
        <ToolChecklistWrapper
          tools={tools}
          initialSelectedIds={new Set(["tool-3"])}
        />,
      );

      const checkboxes = screen.getAllByRole("checkbox");
      // First checkbox should be the selected one (tool-3)
      expect(checkboxes[0]).toBeChecked();
      // Remaining should be unchecked
      for (let i = 1; i < checkboxes.length; i++) {
        expect(checkboxes[i]).not.toBeChecked();
      }
    });
  });

  describe("grouped built-in tools", () => {
    function createArchestraTool(
      id: string,
      shortName: string,
      group: string,
    ): ToolChecklistProps["tools"][number] {
      return {
        id,
        name: `archestra__${shortName}`,
        description: `Description for ${shortName}`,
        parameters: {},
        createdAt: new Date().toISOString(),
        group,
        assignedAgentCount: 0,
        assignedAgents: [],
      };
    }

    const groupedTools = () => [
      createArchestraTool("t-list-skills", "list_skills", "skills"),
      createArchestraTool("t-create-skill", "create_skill", "skills"),
      createArchestraTool("t-scaffold-app", "scaffold_app", "apps"),
      createArchestraTool("t-edit-app", "edit_app", "apps"),
      createArchestraTool("t-list-apps", "list_apps", "apps"),
      createArchestraTool("t-get-servers", "get_mcp_servers", "mcp_servers"),
    ];

    it("renders a section header per domain group", () => {
      render(<ToolChecklistWrapper tools={groupedTools()} />);

      expect(screen.getByText("Skills")).toBeInTheDocument();
      expect(screen.getByText("Apps")).toBeInTheDocument();
      expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    });

    it("collapses sections by default so tool rows are hidden", () => {
      render(<ToolChecklistWrapper tools={groupedTools()} />);

      expect(screen.queryByText("list_skills")).not.toBeInTheDocument();
      expect(screen.queryByText("scaffold_app")).not.toBeInTheDocument();
    });

    it("expands a section when its header is clicked", async () => {
      const user = userEvent.setup();
      render(<ToolChecklistWrapper tools={groupedTools()} />);

      // The header toggle's accessible name is "Skills0/2" (label + count);
      // anchor to the start so it doesn't also match the per-group
      // "Select all Skills tools" / "Clear Skills tools" buttons.
      await user.click(screen.getByRole("button", { name: /^Skills/ }));

      expect(screen.getByText("list_skills")).toBeInTheDocument();
      expect(screen.getByText("create_skill")).toBeInTheDocument();
      // Sibling section stays collapsed.
      expect(screen.queryByText("scaffold_app")).not.toBeInTheDocument();
    });

    it("selects only that group's tools via its per-group Select all", async () => {
      const user = userEvent.setup();
      render(<ToolChecklistWrapper tools={groupedTools()} />);

      // Skills header before selecting: 0 of 2.
      expect(screen.getByText("0/2")).toBeInTheDocument();

      const skillsSection = screen
        .getByText("Skills")
        .closest("div.rounded-md") as HTMLElement;
      await user.click(
        within(skillsSection).getByRole("button", {
          name: "Select all Skills tools",
        }),
      );

      // Only the two skill tools are now selected — global count reflects that,
      // the Skills header count fills, and Apps stays untouched.
      expect(screen.getByText("2 of 6 selected")).toBeInTheDocument();
      expect(within(skillsSection).getByText("2/2")).toBeInTheDocument();
      expect(screen.getByText("0/3")).toBeInTheDocument();
    });

    it("keeps sections while searching and hides non-matching groups", async () => {
      const user = userEvent.setup();
      render(<ToolChecklistWrapper tools={groupedTools()} />);

      await user.type(screen.getByPlaceholderText("Search tools..."), "skill");

      // Skills section stays and auto-expands to show its match.
      expect(screen.getByText("Skills")).toBeInTheDocument();
      expect(screen.getByText("list_skills")).toBeInTheDocument();
      // Non-matching groups drop out entirely.
      expect(screen.queryByText("Apps")).not.toBeInTheDocument();
      expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();
    });

    it("falls back to a flat list when no tool carries a group", () => {
      render(<ToolChecklistWrapper tools={createMockTools(4)} />);

      // Flat list shows rows immediately with no group headers.
      expect(screen.getByText("tool_1")).toBeInTheDocument();
      expect(screen.queryByText("Skills")).not.toBeInTheDocument();
    });

    it("routes an unrecognized group into the Other section (never dropped)", async () => {
      const user = userEvent.setup();
      const tools = [
        createArchestraTool("t-list-skills", "list_skills", "skills"),
        // A group id this build doesn't know (e.g. server version skew).
        createArchestraTool("t-future", "future_tool", "brand_new_group"),
      ];
      render(<ToolChecklistWrapper tools={tools} />);

      // The unknown-group tool is bucketed under "Other", not silently lost,
      // and its header count reflects it (body and count keyed identically).
      const otherSection = screen
        .getByText("Other")
        .closest("div.rounded-md") as HTMLElement;
      expect(within(otherSection).getByText("0/1")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /^Other/ }));
      expect(screen.getByText("future_tool")).toBeInTheDocument();
    });
  });
});
