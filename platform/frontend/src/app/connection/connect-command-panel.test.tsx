import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectCommandPanel } from "./connect-command-panel";

const { createSetupMock, allSkillsMock } = vi.hoisted(() => ({
  createSetupMock: vi.fn(),
  allSkillsMock: vi.fn(),
}));

vi.mock("@/lib/connection-setup.query", () => ({
  useCreateConnectionSetup: () => ({
    mutateAsync: createSetupMock,
    isPending: false,
  }),
}));

vi.mock("./skills-marketplace-step", () => ({
  useAllSkills: (params?: { enabled?: boolean }) => allSkillsMock(params),
}));

// The per-gateway server list fetches its own data; its behavior is pinned in
// gateway-servers-summary.test.tsx, so the panel test only needs a stand-in.
vi.mock("./gateway-servers-summary", () => ({
  GatewayServersSummary: ({ gatewayId }: { gatewayId: string }) => (
    <div data-testid="gateway-servers-summary" data-gateway-id={gatewayId} />
  ),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/config/config.query");

vi.mock("@/lib/hooks/use-app-name");

const { availableKeysMock, createKeyMock } = vi.hoisted(() => ({
  availableKeysMock: vi.fn(),
  createKeyMock: vi.fn(),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => availableKeysMock(),
  useCreateLlmProviderApiKey: () => ({
    mutateAsync: createKeyMock,
    isPending: false,
  }),
}));

vi.mock("@/components/github-copilot-sign-in", () => ({
  GithubCopilotSignIn: ({ onToken }: { onToken: (token: string) => void }) => (
    <button type="button" onClick={() => onToken("gho_test")}>
      Sign in with GitHub
    </button>
  ),
}));

vi.mock("@/components/create-llm-provider-api-key-dialog", () => ({
  CreateLlmProviderApiKeyDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-provider-key-dialog" /> : null,
}));

function findClient(id: string) {
  const client = CONNECT_CLIENTS.find((c) => c.id === id);
  if (!client) throw new Error(`Missing fixture client: ${id}`);
  return client;
}

const claudeClient = findClient("claude-code");

const COMMAND =
  "curl -fsSL 'http://localhost:9000/api/connection-setups/tok' | bash";

function renderPanelProps(
  overrides: Partial<Parameters<typeof ConnectCommandPanel>[0]> = {},
): Parameters<typeof ConnectCommandPanel>[0] {
  return {
    client: claudeClient,
    mcpGateways: [{ id: "g1", name: "My Gateway", agentType: "mcp_gateway" }],
    mcpGatewayId: "g1",
    onMcpGatewaySelect: vi.fn(),
    llmProxies: [{ id: "p1", name: "My Proxy", agentType: "llm_proxy" }],
    llmProxyId: "p1",
    onLlmProxySelect: vi.fn(),
    urlProvider: null,
    onProviderSelect: vi.fn(),
    baseUrl: "http://localhost:9000/v1",
    candidateBaseUrls: ["http://localhost:9000/v1"],
    baseUrlMetadata: null,
    onBaseUrlChange: vi.fn(),
    ...overrides,
  };
}

function renderPanel(
  overrides: Partial<Parameters<typeof ConnectCommandPanel>[0]> = {},
) {
  return render(<ConnectCommandPanel {...renderPanelProps(overrides)} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  availableKeysMock.mockReturnValue({
    data: [{ provider: "anthropic" }, { provider: "bedrock" }],
  });
  createKeyMock.mockResolvedValue({ id: "key-1" });
  allSkillsMock.mockReturnValue({
    data: [
      { id: "s1", name: "warehouse-postgres" },
      { id: "s2", name: "billing-pipeline" },
    ],
  });
  createSetupMock.mockResolvedValue({
    id: "setup-1",
    command: COMMAND,
    expiresAt: new Date().toISOString(),
    tokenStart: "tok",
  });
});

describe("ConnectCommandPanel", () => {
  it("generates the command automatically with everything included by default", async () => {
    renderPanel();

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith({
        clientId: "claude-code",
        platform: "macos", // jsdom has no Windows UA → bash default
        baseUrl: "http://localhost:9000/v1",
        mcpGatewayId: "g1",
        llmProxyId: "p1",
        provider: "anthropic", // first supported provider auto-selected
        proxyAuth: "provider-key",
        skills: { skillIds: ["s1", "s2"], ttlDays: null }, // skills ride along by default
      }),
    );
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();

    // the summary reflects the defaults without any clicks
    expect(screen.getByText(/My Gateway/)).toBeInTheDocument();
    expect(screen.getByText(/My Proxy/)).toBeInTheDocument();
    expect(screen.getByText(/2 shared skills/)).toBeInTheDocument();
    // single endpoint: not worth naming
    expect(
      screen.queryByText("http://localhost:9000/v1"),
    ).not.toBeInTheDocument();
  });

  it("shows a separate endpoint line when more than one endpoint is configured", async () => {
    renderPanel({
      baseUrl: "https://eu.example.com/v1",
      candidateBaseUrls: [
        "https://eu.example.com/v1",
        "https://us.example.com/v1",
      ],
    });
    await screen.findByText(COMMAND);
    expect(
      screen.getByText(/Reach the gateway and proxy at/),
    ).toBeInTheDocument();
    expect(screen.getByText("https://eu.example.com/v1")).toBeInTheDocument();
  });

  it("shows the auto-detected platform in the review step", async () => {
    renderPanel();
    await screen.findByText(COMMAND);
    // jsdom reports no Windows UA, so detection falls back to the bash option.
    expect(screen.getByText(/Run on/)).toBeInTheDocument();
    expect(screen.getByText("macOS / Linux")).toBeInTheDocument();
    expect(screen.getByTestId("connect-change-platform")).toBeInTheDocument();
  });

  it("shows a Finish the OAuth flow step for Claude Code when a gateway is connected", async () => {
    renderPanel();
    await screen.findByText(COMMAND);

    expect(
      screen.getByRole("heading", { name: "Finish the OAuth flow" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Claude Code opens your browser/),
    ).toBeInTheDocument();
    // why: the gateway authorizes per user, so the script alone isn't enough
    expect(screen.getByText(/grants tool access per user/)).toBeInTheDocument();
    // copy-pasteable command plus the exact server name to pick from the list
    expect(screen.getByText("claude /mcp")).toBeInTheDocument();
    expect(screen.getByText("my_gateway")).toBeInTheDocument();
  });

  it("omits the OAuth step when only a proxy (no gateway) is connected", async () => {
    renderPanel({ mcpGateways: [], mcpGatewayId: null });
    await screen.findByText(COMMAND);

    expect(
      screen.queryByRole("heading", { name: "Finish the OAuth flow" }),
    ).not.toBeInTheDocument();
  });

  it("regenerates without skills after opting out in Options", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(COMMAND);

    await user.click(screen.getByTestId("connect-change-skills"));
    await user.click(screen.getByLabelText("Install shared skills"));

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ skills: undefined }),
      ),
    );
    expect(screen.getByText("Shared skills not installed")).toBeInTheDocument();
  });

  it("keeps the skills opt-out sticky when the skill list later grows", async () => {
    // The skills query refetches (refocus / cache invalidation). A new skill
    // appearing must not silently re-enable the bundle after an explicit
    // opt-out — the command stays skills-free.
    const user = userEvent.setup();
    const { rerender } = renderPanel();
    await screen.findByText(COMMAND);

    await user.click(screen.getByTestId("connect-change-skills"));
    await user.click(screen.getByLabelText("Install shared skills"));
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ skills: undefined }),
      ),
    );

    // a refetch surfaces a brand-new skill the admin never saw
    allSkillsMock.mockReturnValue({
      data: [
        { id: "s1", name: "warehouse-postgres" },
        { id: "s2", name: "billing-pipeline" },
        { id: "s3", name: "freshly-added" },
      ],
    });
    rerender(<ConnectCommandPanel {...renderPanelProps()} />);

    // still opted out — no skills ride along
    await waitFor(() => expect(createSetupMock).toHaveBeenCalled());
    expect(createSetupMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ skills: undefined }),
    );
    expect(screen.getByText("Shared skills not installed")).toBeInTheDocument();
  });

  it("names the skills it installs and regenerates when one is deselected", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(COMMAND);

    // the review line lists exactly what rides along
    expect(
      screen.getByText(/warehouse-postgres, billing-pipeline/),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("connect-change-skills"));
    await user.click(screen.getByLabelText("billing-pipeline"));

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          skills: { skillIds: ["s1"], ttlDays: null },
        }),
      ),
    );
    expect(screen.getByText(/1 of 2 shared skills/)).toBeInTheDocument();
  });

  it("truncates the skill names line past six skills", async () => {
    allSkillsMock.mockReturnValue({
      data: Array.from({ length: 8 }, (_, i) => ({
        id: `s${i}`,
        name: `skill-${i}`,
      })),
    });
    renderPanel();
    await screen.findByText(COMMAND);

    // first six named, remainder summarized
    expect(
      screen.getByText(
        /skill-0, skill-1, skill-2, skill-3, skill-4, skill-5 and 2 more/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/8 shared skills/)).toBeInTheDocument();
  });

  it("lists the MCP servers behind the selected gateway", async () => {
    renderPanel();
    await screen.findByText(COMMAND);

    expect(screen.getByTestId("gateway-servers-summary")).toHaveAttribute(
      "data-gateway-id",
      "g1",
    );
  });

  it("offers provider tabs for multi-provider clients", async () => {
    const onProviderSelect = vi.fn();
    renderPanel({ onProviderSelect });
    await screen.findByText(COMMAND);

    const bedrockTab = screen.getByRole("button", { name: "AWS Bedrock" });
    expect(screen.getByRole("button", { name: "Anthropic" })).toBeVisible();

    await userEvent.setup().click(bedrockTab);
    expect(onProviderSelect).toHaveBeenCalledWith("bedrock");
  });

  it("opens an inline add-provider-key dialog when no provider can mint a virtual key", async () => {
    // No configured provider key, but the user may create one
    // (hasPermissionsMock defaults to true for llmProviderApiKey:create).
    availableKeysMock.mockReturnValue({ data: [] });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("connect-change-proxy"));
    await user.click(screen.getByRole("tab", { name: "Virtual key" }));
    await user.click(
      screen.getByRole("button", { name: /add a provider key/i }),
    );

    expect(screen.getByTestId("add-provider-key-dialog")).toBeInTheDocument();
  });

  it("skips skills entirely for non-admin users", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    renderPanel();

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({ skills: undefined }),
      ),
    );
    // the skill list isn't even fetched for callers who can't share skills
    expect(allSkillsMock).toHaveBeenLastCalledWith({ enabled: false });
  });

  describe("per-user provider (GitHub Copilot)", () => {
    it("shows a connect gate instead of the command when the user has no Copilot key", async () => {
      availableKeysMock.mockReturnValue({ data: [] });
      renderPanel({
        client: findClient("copilot-cli"),
        urlProvider: "github-copilot",
      });

      expect(
        await screen.findByRole("button", { name: /Sign in with GitHub/i }),
      ).toBeInTheDocument();
      // No command is generated until the user connects their own account.
      expect(createSetupMock).not.toHaveBeenCalled();
    });

    it("creates a personal key when the user connects", async () => {
      availableKeysMock.mockReturnValue({ data: [] });
      const user = userEvent.setup();
      renderPanel({
        client: findClient("copilot-cli"),
        urlProvider: "github-copilot",
      });

      await user.click(
        await screen.findByRole("button", { name: /Sign in with GitHub/i }),
      );

      await waitFor(() =>
        expect(createKeyMock).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "github-copilot",
            scope: "personal",
            apiKey: "gho_test",
          }),
        ),
      );
    });

    it("generates the command normally once a Copilot key exists", async () => {
      availableKeysMock.mockReturnValue({
        data: [{ provider: "github-copilot" }],
      });
      renderPanel({
        client: findClient("copilot-cli"),
        urlProvider: "github-copilot",
      });

      await waitFor(() =>
        expect(createSetupMock).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "github-copilot",
            proxyAuth: "virtual-key",
          }),
        ),
      );
      expect(
        screen.queryByRole("button", { name: /Sign in with GitHub/i }),
      ).not.toBeInTheDocument();
    });
  });
});
