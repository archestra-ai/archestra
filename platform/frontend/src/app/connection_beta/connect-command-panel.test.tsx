import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectCommandPanel } from "./connect-command-panel";

const { createSetupMock, fetchSkillsMock, hasPermissionsMock } = vi.hoisted(
  () => ({
    createSetupMock: vi.fn(),
    fetchSkillsMock: vi.fn(),
    hasPermissionsMock: vi.fn(),
  }),
);

vi.mock("@/lib/connection-setup.query", () => ({
  useCreateConnectionSetup: () => ({
    mutateAsync: createSetupMock,
    isPending: false,
  }),
}));

vi.mock("./skills-marketplace-step", () => ({
  fetchAllSkillIds: fetchSkillsMock,
  useTotalSkillCount: () => ({ data: 2 }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => hasPermissionsMock(),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => true,
}));

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

function findClient(id: string) {
  const client = CONNECT_CLIENTS.find((c) => c.id === id);
  if (!client) throw new Error(`Missing fixture client: ${id}`);
  return client;
}

const claudeClient = findClient("claude-code");

const COMMAND =
  "curl -fsSL 'http://localhost:9000/api/connection-setups/tok' | bash";

function renderPanel(
  overrides: Partial<Parameters<typeof ConnectCommandPanel>[0]> = {},
) {
  return render(
    <ConnectCommandPanel
      client={claudeClient}
      mcpGateways={[{ id: "g1", name: "My Gateway" }]}
      mcpGatewayId="g1"
      onMcpGatewaySelect={vi.fn()}
      llmProxies={[{ id: "p1", name: "My Proxy" }]}
      llmProxyId="p1"
      onLlmProxySelect={vi.fn()}
      urlProvider={null}
      onProviderSelect={vi.fn()}
      baseUrl="http://localhost:9000/v1"
      candidateBaseUrls={["http://localhost:9000/v1"]}
      baseUrlMetadata={null}
      onBaseUrlChange={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hasPermissionsMock.mockReturnValue({ data: true });
  availableKeysMock.mockReturnValue({
    data: [{ provider: "anthropic" }, { provider: "bedrock" }],
  });
  createKeyMock.mockResolvedValue({ id: "key-1" });
  fetchSkillsMock.mockResolvedValue(["s1", "s2"]);
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

  it("regenerates without skills after opting out in Options", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(COMMAND);

    await user.click(screen.getByTestId("connect-change-skills"));
    await user.click(screen.getByLabelText(/Install 2 shared skills/));

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ skills: undefined }),
      ),
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

  it("skips skills entirely for non-admin users", async () => {
    hasPermissionsMock.mockReturnValue({ data: false });
    renderPanel();

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({ skills: undefined }),
      ),
    );
    expect(fetchSkillsMock).not.toHaveBeenCalled();
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
