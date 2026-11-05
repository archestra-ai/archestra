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

it("shows a compact upload instruction without connection configuration", () => {
  render(<ChatgptGatewaySetup {...props} />, { wrapper });
  expect(
    screen.getByRole("button", { name: "Download ChatGPT plugin" }),
  ).toBeVisible();
  expect(screen.queryByRole("link", { name: "Open ChatGPT" })).toBeNull();
  expect(screen.getByText("Upload plugin archive")).toBeVisible();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: "Connection options and model routing",
    }),
  ).toBeNull();
});

it("downloads again with one click and resets status for a different gateway", async () => {
  const createUrl = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:test-plugin");
  const revokeUrl = vi
    .spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => {});
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    const { rerender } = render(<ChatgptGatewaySetup {...props} />, {
      wrapper,
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Download ChatGPT plugin" }),
    );
    await screen.findByRole("button", { name: "Download plugin again" });
    expect(click).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Download plugin again" }),
    );
    await screen.findByRole("button", { name: "Download plugin again" });
    expect(click).toHaveBeenCalledTimes(2);
    rerender(
      <ChatgptGatewaySetup
        {...props}
        gateway={{ id: "other", name: "Other gateway" }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Download ChatGPT plugin" }),
    ).toBeVisible();
  } finally {
    createUrl.mockRestore();
    revokeUrl.mockRestore();
    click.mockRestore();
  }
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
