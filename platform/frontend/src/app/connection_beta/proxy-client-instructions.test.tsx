import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_CLIENTS } from "./clients";
import { ProxyClientInstructions } from "./proxy-client-instructions";

const { provisionMock, hasPermissionsMock } = vi.hoisted(() => ({
  provisionMock: vi.fn(),
  hasPermissionsMock: vi.fn(),
}));

vi.mock("@/lib/connection-setup.query", () => ({
  useCreateConnectionVirtualKey: () => ({
    mutateAsync: provisionMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => hasPermissionsMock(),
}));

// The component reads the selected provider from the URL and writes selections
// back; a static search param + no-op updater is enough for these assertions.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("providerId=anthropic"),
  usePathname: () => "/connection_beta",
  useRouter: () => ({ replace: vi.fn() }),
}));

function genericClient() {
  const client = CONNECT_CLIENTS.find((c) => c.id === "generic");
  if (!client) throw new Error("Missing generic client fixture");
  return client;
}

function renderInstructions() {
  return render(
    <ProxyClientInstructions
      client={genericClient()}
      profileId="profile-123"
      profileName="Main Proxy"
      baseUrl="http://localhost:9000/v1"
    />,
  );
}

describe("ProxyClientInstructions — Any Client step 4", () => {
  beforeEach(() => {
    provisionMock.mockReset();
    hasPermissionsMock.mockReset();
    hasPermissionsMock.mockReturnValue({ data: true });
  });

  it("offers the model router toggle and switches the URL to /openai/", async () => {
    const user = userEvent.setup();
    renderInstructions();

    // Per-provider URL by default.
    expect(
      screen.getByText("http://localhost:9000/v1/anthropic/profile-123"),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText(/OpenAI-Compatible Model Router/i));

    // Router on: the unified openai endpoint replaces the per-provider URL.
    expect(
      screen.getByText("http://localhost:9000/v1/openai/profile-123"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("http://localhost:9000/v1/anthropic/profile-123"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("https://api.openai.com/v1/")).toBeInTheDocument();
  });

  it("auto-provisions a virtual key and shows its value", async () => {
    const user = userEvent.setup();
    provisionMock.mockResolvedValue({ value: "arch_secret", name: "My Key" });
    renderInstructions();

    await user.click(screen.getByRole("tab", { name: "Virtual key" }));
    await user.click(
      screen.getByRole("button", { name: /Generate virtual key/i }),
    );

    await waitFor(() =>
      expect(provisionMock).toHaveBeenCalledWith({ provider: "anthropic" }),
    );
    expect(await screen.findByText("arch_secret")).toBeInTheDocument();
  });

  it("disables the virtual-key option without llmVirtualKey:create", () => {
    hasPermissionsMock.mockReturnValue({ data: false });
    renderInstructions();

    expect(screen.getByRole("tab", { name: "Virtual key" })).toBeDisabled();
  });
});
