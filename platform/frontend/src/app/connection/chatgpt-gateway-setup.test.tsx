import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ChatgptGatewaySetup } from "./chatgpt-gateway-setup";

vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/auth/auth.query");
const props = {
  gateway: { id: "gateway-id", slug: "team-gateway", name: "Team gateway" },
  baseUrl: "https://gateway.example.test/v1",
};

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("Example Platform");
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
});

it("updates the packaged endpoint after changing gateways and keeps advanced copy collapsed", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<ChatgptGatewaySetup {...props} />, { wrapper });
  expect(
    screen.getByRole("button", { name: "Download ChatGPT plugin" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Gateway HTTPS URL")).toBeNull();
  await user.click(
    screen.getByRole("button", {
      name: "Connection options and model routing",
    }),
  );
  expect(screen.getByLabelText("Gateway HTTPS URL")).toHaveValue(
    "https://gateway.example.test/v1/mcp/team-gateway",
  );
  rerender(
    <ChatgptGatewaySetup
      {...props}
      gateway={{ id: "other-id", name: "Other gateway" }}
    />,
  );
  expect(screen.getByLabelText("Gateway HTTPS URL")).toHaveValue(
    "https://gateway.example.test/v1/mcp/other-id",
  );
});

it("removes download actions when the gateway becomes unavailable", () => {
  const { rerender } = render(<ChatgptGatewaySetup {...props} />, { wrapper });
  rerender(<ChatgptGatewaySetup {...props} gateway={null} />);
  expect(screen.getByText("No MCP gateway available")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Download ChatGPT plugin" }),
  ).toBeNull();
  expect(
    screen.queryByRole("link", { name: "Open ChatGPT Plugins" }),
  ).toBeNull();
});
