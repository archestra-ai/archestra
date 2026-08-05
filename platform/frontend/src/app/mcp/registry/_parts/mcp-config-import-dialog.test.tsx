import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpConfigImportDialog } from "./mcp-config-import-dialog";

describe("McpConfigImportDialog", () => {
  it("reviews a pasted config before importing it", async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    render(<McpConfigImportDialog onImport={onImport} />);

    await user.click(screen.getByRole("button", { name: "Import JSON" }));
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "MCP server configuration JSON",
      }),
      {
        target: {
          value: JSON.stringify({
            mcpServers: {
              filesystem: {
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-filesystem"],
              },
            },
          }),
        },
      },
    );

    await user.click(
      screen.getByRole("button", { name: "Review Configuration" }),
    );
    expect(screen.getByText("Configuration Ready")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import Server" }));
    expect(onImport).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "filesystem",
        values: expect.objectContaining({
          serverType: "local",
          localConfig: expect.objectContaining({
            command: "npx",
            arguments: "-y\n@modelcontextprotocol/server-filesystem",
          }),
        }),
      }),
    );
  });

  it("shows a parse error without importing", async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    render(<McpConfigImportDialog onImport={onImport} />);

    await user.click(screen.getByRole("button", { name: "Import JSON" }));
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "MCP server configuration JSON",
      }),
      { target: { value: "{" } },
    );
    await user.click(
      screen.getByRole("button", { name: "Review Configuration" }),
    );

    expect(
      screen.getByText("Configuration Not Recognized"),
    ).toBeInTheDocument();
    expect(onImport).not.toHaveBeenCalled();
  });

  it("blocks local imports when the orchestrator is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <McpConfigImportDialog onImport={vi.fn()} localServersEnabled={false} />,
    );

    await user.click(screen.getByRole("button", { name: "Import JSON" }));
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "MCP server configuration JSON",
      }),
      {
        target: {
          value: JSON.stringify({
            mcpServers: { local: { command: "node", args: ["server.js"] } },
          }),
        },
      },
    );
    await user.click(
      screen.getByRole("button", { name: "Review Configuration" }),
    );

    expect(
      screen.getByText(/require the Kubernetes orchestrator/),
    ).toBeInTheDocument();
  });
});
