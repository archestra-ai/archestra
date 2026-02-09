import { render, screen } from "@testing-library/react";
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
});
