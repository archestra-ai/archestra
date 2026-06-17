import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_CLIENTS } from "./clients";
import { ProxyClientInstructions } from "./proxy-client-instructions";

const { provisionMock, hasPermissionsMock, availableKeysMock } = vi.hoisted(
  () => ({
    provisionMock: vi.fn(),
    hasPermissionsMock: vi.fn(),
    availableKeysMock: vi.fn(),
  }),
);

vi.mock("@/lib/connection-setup.query", () => ({
  useCreateConnectionVirtualKey: () => ({
    mutateAsync: provisionMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => hasPermissionsMock(),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => availableKeysMock(),
}));

vi.mock("@/components/create-llm-provider-api-key-dialog", () => ({
  CreateLlmProviderApiKeyDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-provider-key-dialog" /> : null,
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
    availableKeysMock.mockReset();
    // the user has an anthropic provider key by default
    availableKeysMock.mockReturnValue({ data: [{ provider: "anthropic" }] });
  });

  it("offers the model router toggle and switches the URL to /model-router/", async () => {
    const user = userEvent.setup();
    renderInstructions();

    // Per-provider URL by default.
    expect(
      screen.getByText("http://localhost:9000/v1/anthropic/profile-123"),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText(/OpenAI-Compatible Model Router/i));

    // Router on: the unified model-router endpoint replaces the per-provider URL.
    expect(
      screen.getByText("http://localhost:9000/v1/model-router/profile-123"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("http://localhost:9000/v1/anthropic/profile-123"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("https://api.openai.com/v1/")).toBeInTheDocument();
  });

  it("auto-provisions a virtual key on tab select (no extra click)", async () => {
    const user = userEvent.setup();
    provisionMock.mockResolvedValue({ value: "arch_secret", name: "My Key" });
    renderInstructions();

    // selecting the tab provisions automatically — there is no generate button
    await user.click(screen.getByRole("tab", { name: "Virtual key" }));

    await waitFor(() =>
      expect(provisionMock).toHaveBeenCalledWith({ provider: "anthropic" }),
    );
    expect(
      screen.queryByRole("button", { name: /Generate virtual key/i }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("arch_secret")).toBeInTheDocument();
  });

  it("disables the virtual-key option without llmVirtualKey:create", () => {
    hasPermissionsMock.mockReturnValue({ data: false });
    renderInstructions();

    expect(screen.getByRole("tab", { name: "Virtual key" })).toBeDisabled();
  });

  it("disables the virtual-key option when the provider has no configured key", () => {
    // permission is fine, but there's no anthropic provider key to wrap
    availableKeysMock.mockReturnValue({ data: [] });
    renderInstructions();

    expect(screen.getByRole("tab", { name: "Virtual key" })).toBeDisabled();
    expect(provisionMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/needs a configured Anthropic provider key first/i),
    ).toBeInTheDocument();
  });

  it("opens an inline add-provider-key dialog from the no-key helper text", async () => {
    // permission to create a provider key (hasPermissionsMock defaults to true)
    // and no key configured for the selected provider.
    availableKeysMock.mockReturnValue({ data: [] });
    const user = userEvent.setup();
    renderInstructions();

    await user.click(screen.getByRole("button", { name: /add one/i }));

    expect(screen.getByTestId("add-provider-key-dialog")).toBeInTheDocument();
  });
});
