import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { ConnectConfigPanel } from "./connect-config-panel";

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/connection-setup.query", () => ({
  useCreateConnectionPassthroughKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useCreateConnectionVirtualKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({ data: [] }),
}));

vi.mock("@/components/create-llm-provider-api-key-dialog", () => ({
  CreateLlmProviderApiKeyDialog: () => null,
}));

const proxy = {
  id: "proxy-1",
  name: "Prod Proxy",
  agentType: "llm_proxy" as const,
};

function renderPanel() {
  return render(
    <ConnectConfigPanel
      mcpGateways={null}
      mcpGatewayId={null}
      onMcpGatewaySelect={() => {}}
      gatewaySlug={null}
      llmProxies={[proxy]}
      llmProxyId={proxy.id}
      onLlmProxySelect={() => {}}
      baseUrl="http://localhost:9000/v1"
      candidateBaseUrls={["http://localhost:9000/v1"]}
      baseUrlMetadata={null}
      onBaseUrlChange={() => {}}
    />,
  );
}

describe("ConnectConfigPanel — Claude Desktop subscription note", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Short-circuit the download step's provisioning; the subscription note
    // opens the download step but sits outside the provisioning flow, so it
    // renders regardless.
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
  });

  it("notes that the proxy can't reuse a Claude subscription and points to Claude Code", () => {
    renderPanel();

    expect(
      screen.getByText(/reuse a Claude Pro or Max subscription/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/connect Claude Code in passthrough mode/),
    ).toBeInTheDocument();
  });
});
