import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpRegistryServerDetailPage } from "./page.client";

const mockUseMcpRegistryServer = vi.fn();

vi.mock("@/lib/mcp/external-mcp-catalog.query", () => ({
  useMcpRegistryServer: (name: string | null) => mockUseMcpRegistryServer(name),
}));

vi.mock("./readme-markdown", () => ({
  ReadmeMarkdown: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

describe("McpRegistryServerDetailPage", () => {
  it("renders server details with tools, configuration, and sidebar sections", () => {
    mockUseMcpRegistryServer.mockReturnValue({
      isPending: false,
      data: {
        name: "mongodb-js__mongodb-mcp-server",
        display_name: "MongoDB MCP Server",
        description: "Interact with MongoDB databases.",
        category: "Databases",
        programming_language: "TypeScript",
        license: "Apache-2.0",
        quality_score: 87.4,
        keywords: ["mongodb", "atlas"],
        server: {
          type: "local",
          command: "npx",
          args: ["-y", "mongodb-mcp-server"],
        },
        tools: [{ name: "find", description: "Query documents" }],
        user_config: {
          connection_string: {
            type: "string",
            required: true,
            sensitive: true,
            description: "MongoDB connection string",
          },
        },
        github_info: {
          url: "https://github.com/mongodb-js/mongodb-mcp-server",
          stars: 1200,
          contributors: 30,
          issues: 5,
          releases: true,
        },
        readme: "# MongoDB MCP Server readme",
      },
    });

    render(
      <McpRegistryServerDetailPage name="mongodb-js__mongodb-mcp-server" />,
    );

    expect(mockUseMcpRegistryServer).toHaveBeenCalledWith(
      "mongodb-js__mongodb-mcp-server",
    );
    expect(screen.getByText("MongoDB MCP Server")).toBeInTheDocument();
    expect(
      screen.getByText("mongodb-js__mongodb-mcp-server"),
    ).toBeInTheDocument();
    expect(screen.getByText("Quality 87")).toBeInTheDocument();
    // Tools section
    expect(screen.getByText("find")).toBeInTheDocument();
    expect(screen.getByText("Query documents")).toBeInTheDocument();
    // Configuration options
    expect(screen.getByText("connection_string")).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByText("Sensitive")).toBeInTheDocument();
    // Sidebar server config
    expect(screen.getByText("npx")).toBeInTheDocument();
    expect(screen.getByText("-y mongodb-mcp-server")).toBeInTheDocument();
    // README
    expect(screen.getByText("# MongoDB MCP Server readme")).toBeInTheDocument();
    // Back link
    expect(
      screen.getByRole("link", { name: /back to mcp registry/i }),
    ).toHaveAttribute("href", "/mcp/registry/beta");
  });

  it("shows a not-found state when the server is not in the catalog", () => {
    mockUseMcpRegistryServer.mockReturnValue({
      isPending: false,
      data: null,
    });

    render(<McpRegistryServerDetailPage name="unknown-server" />);

    expect(screen.getByText("Server not found")).toBeInTheDocument();
    expect(screen.getByText(/unknown-server/)).toBeInTheDocument();
  });
});
