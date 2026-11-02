import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

it("shows a compact upload instruction without connection configuration", () => {
  render(<ChatgptGatewaySetup {...props} />, { wrapper });
  expect(
    screen.getByRole("button", { name: "Download ChatGPT plugin" }),
  ).toBeVisible();
  expect(screen.queryByRole("link", { name: "Open ChatGPT" })).toBeNull();
  expect(screen.queryByText("Upload plugin archive")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: "Connection options and model routing",
    }),
  ).toBeNull();
});

it("removes download actions when the gateway becomes unavailable", () => {
  const { rerender } = render(<ChatgptGatewaySetup {...props} />, { wrapper });
  rerender(<ChatgptGatewaySetup {...props} gateway={null} />);
  expect(screen.getByText("No MCP gateway available")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Download ChatGPT plugin" }),
  ).toBeNull();
  expect(screen.queryByRole("link", { name: "Open ChatGPT" })).toBeNull();
});
