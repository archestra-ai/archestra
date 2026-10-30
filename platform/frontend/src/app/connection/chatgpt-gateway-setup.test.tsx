import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ChatgptGatewaySetup } from "./chatgpt-gateway-setup";
import { CONNECT_CLIENTS } from "./clients";

vi.mock("@/lib/hooks/use-app-name");

const client = CONNECT_CLIENTS.find((candidate) => candidate.id === "chatgpt");
if (!client) throw new Error("ChatGPT client missing");
const props = {
  client,
  gateway: { id: "gateway-id", slug: "team-gateway", name: "Team gateway" },
  baseUrl: "https://gateway.example.test/v1",
};

beforeEach(() => vi.mocked(useAppName).mockReturnValue("Example Platform"));

it("copies the selected gateway without credentials and updates after a gateway change", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText");
  const { rerender } = render(<ChatgptGatewaySetup {...props} />);
  expect(
    screen.getByText(/Connect Example Platform's MCP tools/),
  ).toBeVisible();
  expect(screen.queryByRole("tab", { name: "Static token" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  expect(write).toHaveBeenLastCalledWith(
    "https://gateway.example.test/v1/mcp/team-gateway",
  );
  rerender(
    <ChatgptGatewaySetup
      {...props}
      gateway={{ id: "other-id", name: "Other gateway" }}
    />,
  );
  expect(screen.queryByText(/\/mcp\/team-gateway/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  expect(write).toHaveBeenLastCalledWith(
    "https://gateway.example.test/v1/mcp/other-id",
  );
  expect(write).toHaveBeenCalledTimes(3);
});

it("removes setup actions when the gateway becomes unavailable", () => {
  const { rerender } = render(<ChatgptGatewaySetup {...props} />);
  rerender(<ChatgptGatewaySetup {...props} gateway={null} />);
  expect(screen.getByText("No MCP gateway available")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Copy to clipboard" }),
  ).toBeNull();
  expect(
    screen.queryByRole("link", { name: "Open ChatGPT Plugins" }),
  ).toBeNull();
  expect(screen.queryByText(/\/mcp\/team-gateway/)).toBeNull();
});
