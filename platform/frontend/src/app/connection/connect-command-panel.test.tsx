import { archestraApiClient, type SupportedProvider } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

vi.mock("next/navigation");
vi.mock("sonner");

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import appConfig from "@/lib/config/config";
import { useConfig, useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganization } from "@/lib/organization.query";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectCommandPanel } from "./connect-command-panel";

const {
  createSetupMock,
  setupHookOptions,
  skillNamesMock,
  pluginsMock,
  skillsMarketplaceVisibleMock,
} = vi.hoisted(() => ({
  createSetupMock: vi.fn(),
  setupHookOptions: {} as { onRefused?: (message: string) => void },
  skillNamesMock: vi.fn(),
  pluginsMock: vi.fn(),
  skillsMarketplaceVisibleMock: vi.fn(() => true),
}));

vi.mock("@/lib/connection-setup.query", () => ({
  useCreateConnectionSetup: (options?: {
    onRefused?: (message: string) => void;
  }) => {
    setupHookOptions.onRefused = options?.onRefused;
    return { mutateAsync: createSetupMock, isPending: false };
  },
}));

vi.mock("@/lib/skills/skill.query", () => ({
  useSkillNames: (params: { enabled: boolean }) => skillNamesMock(params),
}));

/** What the names endpoint answers: at most the setup cap, plus the total. */
function skillNames(
  skills: { id: string; name: string }[],
  total = skills.length,
) {
  return { data: { data: skills, total }, isPending: false };
}

vi.mock("./skills-marketplace-step", () => ({
  // The marketplace step has its own test file; here it only matters whether
  // the panel renders it as a step.
  useSkillsMarketplaceVisible: () => skillsMarketplaceVisibleMock(),
  SkillsMarketplaceStep: () => <div data-testid="skills-marketplace-step" />,
}));

vi.mock("@/lib/plugins/plugin.query", async (importOriginal) => ({
  isDeliverablePlugin: (
    await importOriginal<typeof import("@/lib/plugins/plugin.query")>()
  ).isDeliverablePlugin,
  usePlugins: (enabled?: boolean) => pluginsMock(enabled),
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

const { availableKeysMock, createKeyMock, modelsByProviderMock } = vi.hoisted(
  () => ({
    availableKeysMock: vi.fn(),
    createKeyMock: vi.fn(),
    modelsByProviderMock: vi.fn(),
  }),
);

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({ data: [] }),
  useLlmModelsByProvider: () => ({
    modelsByProvider: modelsByProviderMock(),
  }),
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

// Stubbed so the gate's provider logo doesn't pull next/image into jsdom; the
// branded-CTA test asserts on the provider it's told to render.
vi.mock("@/components/provider-icon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => (
    <span data-testid="provider-icon" data-provider={provider} />
  ),
}));

function findClient(id: string) {
  const client = CONNECT_CLIENTS.find((c) => c.id === id);
  if (!client) throw new Error(`Missing fixture client: ${id}`);
  return client;
}

/** An admin's per-client key mapping (Settings → Connection). */
function mapClientProviderKeys(mapping: Record<string, SupportedProvider[]>) {
  vi.mocked(useOrganization).mockReturnValue({
    data: {
      connectionClientProviderKeys: Object.fromEntries(
        Object.entries(mapping).map(([clientId, providers]) => [
          clientId,
          providers.map((provider) => ({
            provider,
            providerApiKeyId: `${provider}-org-key`,
          })),
        ]),
      ),
    },
  } as unknown as ReturnType<typeof useOrganization>);
}

const claudeClient = findClient("claude-code");

const COMMAND =
  "curl -fsSL 'http://localhost:9000/api/connection-setups/tok' | bash";

let restoreTimer: () => void;

beforeEach(() => {
  // These tests cover command generation, not the 350 ms debounce interval.
  // Keep scheduling asynchronous while avoiding that real wait in every case.
  const nativeSetTimeout = globalThis.setTimeout;
  const timerSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((handler, timeout, ...args) =>
      nativeSetTimeout(handler, timeout === 350 ? 0 : timeout, ...args),
    );
  restoreTimer = () => timerSpy.mockRestore();
});

afterEach(() => restoreTimer());

function renderPanelProps(
  overrides: Partial<Parameters<typeof ConnectCommandPanel>[0]> = {},
): Parameters<typeof ConnectCommandPanel>[0] {
  return {
    client: claudeClient,
    mcpGateways: [{ id: "g1", name: "My Gateway", agentType: "mcp_gateway" }],
    mcpGatewayId: "g1",
    onMcpGatewaySelect: vi.fn(),
    llmProxyId: "p1",
    urlProvider: null,
    onProviderSelect: vi.fn(),
    baseUrl: "http://localhost:9000/v1",
    ...overrides,
  };
}

function renderPanel(
  overrides: Partial<Parameters<typeof ConnectCommandPanel>[0]> = {},
) {
  return render(<ConnectCommandPanel {...renderPanelProps(overrides)} />, {
    wrapper: queryWrapper(),
  });
}

/** The panel reads the approval request through React Query; rerenders keep the wrapper. */
function queryWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// Radix Select scrolls the focused option; jsdom has no layout engine.
Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.clearAllMocks();
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(useConfig).mockReturnValue({
    data: { features: { plugins: true } },
    isPending: false,
    isError: false,
  } as ReturnType<typeof useConfig>);
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
  availableKeysMock.mockReturnValue({
    data: [{ provider: "anthropic" }, { provider: "bedrock" }],
  });
  createKeyMock.mockResolvedValue({ id: "key-1" });
  modelsByProviderMock.mockReturnValue({});
  skillNamesMock.mockReturnValue(
    skillNames([
      { id: "s1", name: "warehouse-postgres" },
      { id: "s2", name: "billing-pipeline" },
    ]),
  );
  pluginsMock.mockImplementation((enabled: boolean | undefined) => ({
    data: enabled
      ? [
          {
            id: "b1",
            displayName: "OpenAPPA",
            clientType: "claude-code",
            enabled: true,
            contentHash: "hash-1",
            approvedContentHash: "hash-1",
            supportedPlatforms: ["posix"],
          },
        ]
      : undefined,
    isPending: false,
  }));
  createSetupMock.mockResolvedValue({
    id: "setup-1",
    command: COMMAND,
    expiresAt: new Date().toISOString(),
    tokenStart: "tok",
    plugins: [],
  });
});

vi.mock("@/lib/organization.query");

// The components under test resolve provider labels through
// useModelProviderCatalog() -> useOrganization(); no organization data means
// "no admin overrides", i.e. every provider visible under its built-in name.
beforeEach(() => {
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
});

describe("ConnectCommandPanel", () => {
  it("prepares the first setup at once, and a changed selection after the user stops changing it", async () => {
    // This test is about the debounce itself: use the real interval.
    restoreTimer();
    const gateways = [
      { id: "g1", name: "My Gateway", agentType: "mcp_gateway" as const },
      { id: "g2", name: "Team Gateway", agentType: "mcp_gateway" as const },
    ];
    const view = renderPanel({ mcpGateways: gateways });

    // No debounce on the first preparation: its inputs are already complete.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(createSetupMock).toHaveBeenCalledTimes(1);

    view.rerender(
      <ConnectCommandPanel
        {...renderPanelProps({ mcpGateways: gateways, mcpGatewayId: "g2" })}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(createSetupMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ mcpGatewayId: "g2" }),
      ),
    );
    expect(createSetupMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a prepared approval when the page re-renders with the same setup", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("connectRequest=demo&platform=macos") as ReturnType<
        typeof useSearchParams
      >,
    );
    const view = renderPanel();
    await waitFor(() => expect(createSetupMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("approve-connection-progress")).toBeNull(),
    );

    // A permission read that lands later re-runs the preparation, but the
    // payload it would send is the same one.
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: "llmVirtualKey" in permissions ? false : true,
        }) as ReturnType<typeof useHasPermissions>,
    );
    view.rerender(<ConnectCommandPanel {...renderPanelProps()} />);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(createSetupMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("approve-connection-progress")).toBeNull();
  });

  it("waits for shared skills before generating an approvable setup", async () => {
    skillNamesMock.mockReturnValue({ data: undefined, isPending: true });
    const view = renderPanel({ client: findClient("cursor") });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createSetupMock).not.toHaveBeenCalled();

    skillNamesMock.mockReturnValue(
      skillNames([{ id: "shared-skill", name: "Shared skill" }]),
    );
    view.rerender(
      <ConnectCommandPanel
        {...renderPanelProps({ client: findClient("cursor") })}
      />,
    );
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({
          skills: { skillIds: ["shared-skill"], ttlDays: null },
        }),
      ),
    );
  });

  it("offers Desktop subscription installation without a configured API key", async () => {
    availableKeysMock.mockReturnValue({ data: [] });
    createSetupMock.mockResolvedValue({
      id: "desktop-setup",
      command: COMMAND,
      installerUrl: "https://proxy.example/desktop-installer",
      expiresAt: new Date().toISOString(),
      tokenStart: "tok",
      plugins: [],
    });
    renderPanel({ client: findClient("claude-desktop") });
    await waitFor(() => {
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "claude-desktop",
          platform: "macos",
          provider: "anthropic",
          proxyAuth: "provider-key",
          model: "claude-haiku-4-5-20251001",
        }),
      );
    });
    expect(
      await screen.findByRole("link", { name: "Download installer" }),
    ).toHaveAttribute("href", "https://proxy.example/desktop-installer");
    expect(
      screen.queryByRole("link", { name: "the LLM Proxy" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Review the setup" }),
    ).toBeNull();
    expect(screen.queryByText("your Claude subscription")).toBeNull();
    expect(screen.getByText(COMMAND)).not.toBeVisible();
    await userEvent.click(screen.getByText(/Advanced: terminal setup/));
    expect(screen.getByText(COMMAND)).toBeVisible();
    // The Desktop panel sits on a card, so the command must bring its own
    // terminal surface; without one it inherited the card and was unreadable.
    expect(screen.getByText(COMMAND).closest(".bg-terminal")).not.toBeNull();
    expect(createKeyMock).not.toHaveBeenCalled();
  });

  it("prepares a command after switching from download mode without remounting", async () => {
    const view = renderPanel({ variant: "download" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createSetupMock).not.toHaveBeenCalled();
    view.rerender(
      <ConnectCommandPanel {...renderPanelProps({ variant: "full" })} />,
    );
    await waitFor(() => expect(createSetupMock).toHaveBeenCalled());
    expect(await screen.findByText(COMMAND)).toBeVisible();
  });

  it("keeps the gateway in Desktop downloads while honoring optional exclusions", async () => {
    availableKeysMock.mockReturnValue({ data: [] });
    createSetupMock.mockResolvedValue({
      id: "desktop-setup",
      command: COMMAND,
      installerUrl: "https://proxy.example/desktop-installer",
      expiresAt: new Date().toISOString(),
      tokenStart: "tok",
      plugins: [],
    });
    renderPanel({
      client: findClient("claude-desktop"),
      variant: "download",
      exclude: ["tools", "skills", "proxy", "plugins"],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createSetupMock).not.toHaveBeenCalled();
    expect(skillNamesMock.mock.calls.every(([params]) => !params.enabled)).toBe(
      true,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Prepare installer" }),
    );
    const link = await screen.findByRole("link", {
      name: "Download installer",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://proxy.example/desktop-installer",
    );
    expect(createSetupMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "claude-desktop" }),
    );
    expect(createSetupMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mcpGatewayId: "g1",
        llmProxyId: undefined,
        skills: undefined,
        pluginIds: [],
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Customize setup" }),
    ).toBeNull();
  });

  it("can re-enable an omitted proxy and skills from Desktop customization", async () => {
    const user = userEvent.setup();
    renderPanel({
      client: findClient("claude-desktop"),
      exclude: ["proxy", "skills"],
    });
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mcpGatewayId: "g1",
          llmProxyId: undefined,
          skills: undefined,
        }),
      ),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "Route model requests through the LLM Proxy",
      }),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "Install shared skills",
      }),
    );
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mcpGatewayId: "g1",
          llmProxyId: "p1",
          skills: { skillIds: ["s1", "s2"], ttlDays: null },
        }),
      ),
    );
  });

  it("regenerates Desktop setup when the platform changes", async () => {
    const user = userEvent.setup();
    renderPanel({ client: findClient("claude-desktop") });
    await screen.findByText(COMMAND);
    await user.click(screen.getByRole("button", { name: "Customize setup" }));
    await user.click(screen.getByRole("tab", { name: "Windows" }));
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clientId: "claude-desktop",
          platform: "windows",
          proxyAuth: "provider-key",
        }),
      ),
    );
  });

  // Users don't choose how models authenticate: the client and the admin's
  // per-client key mapping decide it.
  it.each([
    {
      case: "an unmapped client keeps the user's own key",
      clientId: "claude-code",
      mapped: [],
      canAttribute: true,
      expected: { proxyAuth: "provider-key", provider: "anthropic" },
    },
    {
      case: "an admin-mapped client gets a virtual key",
      clientId: "claude-code",
      mapped: ["anthropic"],
      canAttribute: true,
      expected: { proxyAuth: "virtual-key", provider: "anthropic" },
    },
    {
      case: "an admin-mapped Desktop gets an API key instead of the subscription",
      clientId: "claude-desktop",
      mapped: ["anthropic"],
      canAttribute: true,
      expected: { proxyAuth: "virtual-key", provider: "anthropic" },
    },
    {
      case: "a user who cannot mint virtual keys keeps their own key",
      clientId: "claude-code",
      mapped: ["anthropic"],
      canAttribute: false,
      expected: { proxyAuth: "provider-key", provider: "anthropic" },
    },
    {
      case: "a mapping for another client does not apply",
      clientId: "claude-code",
      mapped: [],
      otherClientMapped: true,
      canAttribute: true,
      expected: { proxyAuth: "provider-key", provider: "anthropic" },
    },
  ] satisfies {
    case: string;
    clientId: string;
    mapped: SupportedProvider[];
    otherClientMapped?: boolean;
    canAttribute: boolean;
    expected: { proxyAuth: string; provider: string };
  }[])("derives proxy auth: $case", async ({
    clientId,
    mapped,
    otherClientMapped,
    canAttribute,
    expected,
  }) => {
    mapClientProviderKeys({
      [clientId]: mapped,
      ...(otherClientMapped ? { codex: ["openai"] } : {}),
    });
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: "llmVirtualKey" in permissions ? canAttribute : true,
        }) as ReturnType<typeof useHasPermissions>,
    );
    renderPanel({ client: findClient(clientId) });

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ clientId, llmProxyId: "p1", ...expected }),
      ),
    );
  });

  it.each([
    false,
    true,
  ])("keeps Desktop return guidance available with white-labeling=%s", async (whiteLabeling) => {
    const branding = vi
      .spyOn(appConfig.enterpriseFeatures, "fullWhiteLabeling", "get")
      .mockReturnValue(whiteLabeling);
    try {
      renderPanel({ client: findClient("claude-desktop") });
      await screen.findByText(COMMAND);
      const docsLink = screen.queryByRole("link", {
        name: /How to return to standard Claude Desktop/,
      });
      const inlineInstructions = screen.queryByText(
        /choose Anthropic sign-in on Desktop/,
      );
      if (whiteLabeling) {
        expect(docsLink).not.toBeInTheDocument();
        expect(inlineInstructions).toBeVisible();
        expect(
          screen.getByRole("link", { name: /Claude's setup instructions/ }),
        ).toHaveAttribute(
          "href",
          "https://claude.com/docs/third-party/claude-desktop/installation#single-machine-setup",
        );
      } else {
        expect(docsLink).toBeVisible();
        expect(inlineInstructions).not.toBeInTheDocument();
      }
    } finally {
      branding.mockRestore();
    }
  });

  it.each([
    { clientId: "claude-desktop", proxy: true, gateway: true },
    { clientId: "claude-desktop", proxy: false, gateway: true },
    { clientId: "claude-desktop", proxy: true, gateway: false },
    { clientId: "claude-desktop", proxy: false, gateway: false },
    { clientId: "claude-code", proxy: true, gateway: true },
  ])("shows only applicable Desktop guidance for $clientId (proxy=$proxy, gateway=$gateway)", async ({
    clientId,
    proxy,
    gateway,
  }) => {
    renderPanel({
      client: findClient(clientId),
      llmProxyId: proxy ? "p1" : null,
      mcpGatewayId: gateway ? "g1" : null,
      mcpGateways: gateway
        ? [{ id: "g1", name: "My Gateway", agentType: "mcp_gateway" }]
        : [],
    });
    await screen.findByText(COMMAND);

    const revertLink = screen.queryByRole("link", {
      name: /How to return to standard Claude Desktop/,
    });
    const importGuidance = screen.queryByText(/open Settings → Import/);
    if (clientId === "claude-desktop" && proxy) {
      expect(importGuidance).toBeVisible();
      expect(revertLink).toBeVisible();
      expect(revertLink).toHaveAttribute(
        "href",
        expect.stringContaining("integrations/claude-desktop#revert"),
      );
    } else {
      expect(revertLink).not.toBeInTheDocument();
      expect(importGuidance).not.toBeInTheDocument();
    }

    const gatewayStep = screen.queryByRole("heading", {
      name: "Enable your gateway in Claude Desktop",
    });
    if (clientId === "claude-desktop" && gateway) {
      expect(gatewayStep).toBeVisible();
      expect(screen.getByText("+ → Connectors")).toBeVisible();
    } else {
      expect(gatewayStep).not.toBeInTheDocument();
    }
  });

  it("keeps approval compact while customized choices reach the approved setup", async () => {
    const decisions: unknown[] = [];
    const server = setupServer(
      http.get("http://localhost:9000/api/client-connections/demo", () =>
        HttpResponse.json({
          clientId: "claude-code",
          platform: "macos",
          userCode: "ABCD-1234",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      ),
      http.post(
        "http://localhost:9000/api/client-connections/demo/decision",
        async ({ request }) => {
          decisions.push(await request.json());
          return HttpResponse.json({
            status: "approved",
            clientId: "claude-code",
            platform: "macos",
          });
        },
      ),
    );
    server.listen({ onUnhandledRequest: "error" });
    archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("connectRequest=demo&platform=macos") as ReturnType<
        typeof useSearchParams
      >,
    );
    const user = userEvent.setup();
    // The setup hook reports an API failure as null after surfacing its error.
    createSetupMock.mockResolvedValueOnce(null);
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectCommandPanel {...renderPanelProps()} />
      </QueryClientProvider>,
    );
    try {
      await screen.findByText("ABCD-1234");
      await user.click(
        await screen.findByRole("button", { name: "Retry setup" }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Retry setup" }),
        ).toBeNull(),
      );
      expect(
        screen.queryByRole("heading", { name: "Connect Claude Code" }),
      ).toBeNull();
      expect(screen.queryByText("for tools")).toBeNull();
      expect(screen.queryByText(COMMAND)).toBeNull();
      expect(screen.queryByTestId("connect-regenerate-command")).toBeNull();
      expect(screen.queryByTestId("connect-change-skills")).toBeNull();
      expect(
        screen.queryByRole("heading", { name: "Finish the OAuth flow" }),
      ).toBeNull();
      // Setup options start collapsed: the defaults need no review.
      expect(screen.queryByRole("switch", { name: "Skills" })).toBeNull();
      await user.click(screen.getByRole("button", { name: /Setup options/ }));
      // The gateway is required, so Tools has no off switch.
      expect(screen.getByText("My Gateway")).toBeVisible();
      expect(screen.queryByRole("switch", { name: "Tools" })).toBeNull();
      await user.click(screen.getByRole("switch", { name: "Skills" }));
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ mcpGatewayId: "g1", skills: undefined }),
        ),
      );
      await user.click(screen.getByRole("button", { name: /Setup options/ }));
      expect(screen.queryByRole("switch", { name: "Skills" })).toBeNull();
      await user.click(
        screen.getByRole("checkbox", {
          name: "This code matches the code in my terminal.",
        }),
      );
      await user.click(
        screen.getByRole("button", { name: "Approve connection" }),
      );
      await screen.findByRole("heading", {
        name: "Switch back to your terminal",
      });
      expect(decisions).toEqual([{ decision: "approve", setupId: "setup-1" }]);
      // A decided request has nothing left to customize.
      expect(
        screen.queryByRole("button", { name: /Setup options/ }),
      ).toBeNull();
    } finally {
      view.unmount();
      queryClient.clear();
      server.close();
      archestraApiClient.setConfig({ baseUrl: "" });
    }
  });

  it("lets approval re-enable omitted optional parts while keeping the gateway required", async () => {
    const server = setupServer(
      http.get("http://localhost:9000/api/client-connections/demo", () =>
        HttpResponse.json({
          clientId: "claude-code",
          platform: "macos",
          exclude: ["tools", "proxy", "skills", "plugins"],
          userCode: "ABCD-1234",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      ),
    );
    server.listen({ onUnhandledRequest: "error" });
    archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("connectRequest=demo&platform=macos") as ReturnType<
        typeof useSearchParams
      >,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = userEvent.setup();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectCommandPanel {...renderPanelProps()} />
      </QueryClientProvider>,
    );
    try {
      // Exclusions open the setup options so the user sees what was left out.
      // A legacy tools exclusion cannot drop the required gateway.
      expect(await screen.findByText("My Gateway")).toBeVisible();
      expect(screen.queryByRole("switch", { name: "Tools" })).toBeNull();
      const optionalLabels = ["Model routing", "Skills", "Plugins"];
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            mcpGatewayId: "g1",
            llmProxyId: undefined,
            skills: undefined,
            pluginIds: [],
          }),
        ),
      );
      for (const name of optionalLabels) {
        const toggle = screen.getByRole("switch", { name });
        expect(toggle).not.toBeChecked();
        expect(toggle).toBeEnabled();
        await user.click(toggle);
      }
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            mcpGatewayId: "g1",
            llmProxyId: "p1",
            skills: { skillIds: ["s1", "s2"], ttlDays: null },
            pluginIds: ["b1"],
          }),
        ),
      );
      // A refetch must not reapply the initial opt-outs over the user's edits.
      await queryClient.invalidateQueries();
      for (const name of optionalLabels) {
        expect(screen.getByRole("switch", { name })).toBeChecked();
      }
      for (const name of optionalLabels) {
        await user.click(screen.getByRole("switch", { name }));
      }
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            mcpGatewayId: "g1",
            llmProxyId: undefined,
            skills: undefined,
            pluginIds: [],
          }),
        ),
      );
    } finally {
      view.unmount();
      queryClient.clear();
      server.close();
      archestraApiClient.setConfig({ baseUrl: "" });
    }
  });

  it("regenerates the setup as proxy and skills availability changes without losing the gateway", async () => {
    const props = renderPanelProps();
    const { rerender } = render(<ConnectCommandPanel {...props} />, {
      wrapper: queryWrapper(),
    });
    await screen.findByText(COMMAND);

    for (const [proxyEnabled, skillsEnabled] of [
      [false, true],
      [true, false],
      [false, false],
      [true, true],
    ]) {
      createSetupMock.mockClear();
      rerender(
        <ConnectCommandPanel
          {...props}
          llmProxyId={proxyEnabled ? "p1" : null}
          skillsEnabled={skillsEnabled}
        />,
      );

      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            mcpGatewayId: "g1",
            llmProxyId: proxyEnabled ? "p1" : undefined,
            provider: proxyEnabled ? "anthropic" : undefined,
            skills: skillsEnabled
              ? { skillIds: ["s1", "s2"], ttlDays: null }
              : undefined,
          }),
        ),
      );
      expect(await screen.findByText(COMMAND)).toBeInTheDocument();
    }
  });

  it("generates MCP-only setup when a bookmarked provider needs credentials but the proxy is disabled", async () => {
    availableKeysMock.mockReturnValue({ data: [] });
    renderPanel({
      client: findClient("copilot-cli"),
      llmProxyId: null,
      urlProvider: "github-copilot",
      skillsEnabled: false,
    });

    expect(await screen.findByText(COMMAND)).toBeInTheDocument();
    expect(createSetupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpGatewayId: "g1",
        llmProxyId: undefined,
        provider: undefined,
        skills: undefined,
      }),
    );
    expect(screen.queryByText("Sign in with GitHub")).not.toBeInTheDocument();
  });

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
        pluginIds: ["b1"],
      }),
    );
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();

    // the summary reflects the defaults without any clicks
    expect(screen.getByText(/My Gateway/)).toBeInTheDocument();
    expect(screen.getByText(/LLM Proxy/)).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "SPAN" && el.textContent === "2 shared skills",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("1 plugin")).toBeInTheDocument();
    expect(screen.getByText("OpenAPPA")).toBeInTheDocument();
    // single endpoint: not worth naming
    expect(
      screen.queryByText("http://localhost:9000/v1"),
    ).not.toBeInTheDocument();
  });

  it("omits skills from the setup when connecting skills is disabled", async () => {
    renderPanel({ skillsEnabled: false });

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpGatewayId: "g1",
          provider: "anthropic",
        }),
      ),
    );
    expect(createSetupMock.mock.calls.at(-1)?.[0].skills).toBeUndefined();
    expect(
      screen.queryByTestId("connect-change-skills"),
    ).not.toBeInTheDocument();
  });

  it("keeps non-plugin setup functional without querying, reviewing, or sending plugins", async () => {
    renderPanel({ pluginsEnabled: false });

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpGatewayId: "g1",
          provider: "anthropic",
        }),
      ),
    );
    expect(pluginsMock).toHaveBeenCalledWith(false);
    expect(createSetupMock.mock.calls.at(-1)?.[0].pluginIds).toBeUndefined();
    expect(
      screen.queryByTestId("connect-change-plugins"),
    ).not.toBeInTheDocument();
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();
  });

  it("generates a plugin-only setup when no gateway, proxy, or skill exists", async () => {
    skillNamesMock.mockReturnValue(skillNames([]));
    renderPanel({
      mcpGateways: [],
      mcpGatewayId: null,
      llmProxyId: null,
    });

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith({
        clientId: "claude-code",
        platform: "macos",
        baseUrl: "http://localhost:9000/v1",
        mcpGatewayId: undefined,
        llmProxyId: undefined,
        provider: undefined,
        proxyAuth: undefined,
        model: undefined,
        skills: undefined,
        pluginIds: ["b1"],
      }),
    );
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "1 plugin" }).closest("li"),
    ).toHaveTextContent("Install 1 plugin");
    expect(screen.getByTestId("connect-change-plugins")).toBeVisible();
  });

  it("changes the exact plugin snapshot from the review row", async () => {
    const user = userEvent.setup();
    skillNamesMock.mockReturnValue(skillNames([]));
    pluginsMock.mockImplementation((enabled: boolean | undefined) => ({
      data: enabled
        ? [
            {
              id: "plugin-a",
              displayName: "Plugin A",
              clientType: "claude-code",
              enabled: true,
              contentHash: "hash-a",
              approvedContentHash: "hash-a",
              supportedPlatforms: ["posix"],
            },
            {
              id: "plugin-b",
              displayName: "Plugin B",
              clientType: "claude-code",
              enabled: true,
              contentHash: "hash-b",
              approvedContentHash: "hash-b",
              supportedPlatforms: ["posix"],
            },
          ]
        : undefined,
      isPending: false,
    }));
    renderPanel({
      mcpGateways: [],
      mcpGatewayId: null,
      llmProxyId: null,
    });

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ pluginIds: ["plugin-a", "plugin-b"] }),
      ),
    );
    await user.click(screen.getByTestId("connect-change-plugins"));
    await user.click(screen.getByRole("checkbox", { name: "Plugin B" }));

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ pluginIds: ["plugin-a"] }),
      ),
    );
    expect(screen.getByText("1 of 2 plugins")).toBeVisible();

    await user.click(
      screen.getByRole("checkbox", { name: "Install compatible plugins" }),
    );
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ pluginIds: ["plugin-a", "plugin-b"] }),
      ),
    );
    expect(screen.getByTestId("connect-command-status")).toHaveTextContent(
      "Setup command ready",
    );
  });

  it("preserves an explicit plugin selection when switching clients", async () => {
    const user = userEvent.setup();
    skillNamesMock.mockReturnValue(skillNames([]));
    pluginsMock.mockImplementation((enabled: boolean | undefined) => ({
      data: enabled
        ? [
            {
              id: "claude-a",
              displayName: "Claude A",
              clientType: "claude-code",
              enabled: true,
              contentHash: "hash-ca",
              approvedContentHash: "hash-ca",
              supportedPlatforms: ["posix", "windows"],
            },
            {
              id: "claude-b",
              displayName: "Claude B",
              clientType: "claude-code",
              enabled: true,
              contentHash: "hash-cb",
              approvedContentHash: "hash-cb",
              supportedPlatforms: ["posix", "windows"],
            },
            {
              id: "codex-a",
              displayName: "Codex A",
              clientType: "codex",
              enabled: true,
              contentHash: "hash-xa",
              approvedContentHash: "hash-xa",
              supportedPlatforms: ["posix", "windows"],
            },
          ]
        : undefined,
      isPending: false,
    }));
    const noOtherResources = {
      mcpGateways: [],
      mcpGatewayId: null,
      llmProxyId: null,
    };
    const { rerender } = renderPanel(noOtherResources);
    await screen.findByText(COMMAND);
    await user.click(screen.getByTestId("connect-change-plugins"));
    await user.click(screen.getByRole("checkbox", { name: "Claude A" }));
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ pluginIds: ["claude-b"] }),
      ),
    );

    rerender(
      <ConnectCommandPanel
        {...renderPanelProps({
          ...noOtherResources,
          client: findClient("codex"),
        })}
      />,
    );
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clientId: "codex",
          pluginIds: ["codex-a"],
        }),
      ),
    );

    rerender(
      <ConnectCommandPanel
        {...renderPanelProps({ ...noOtherResources, client: claudeClient })}
      />,
    );
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clientId: "claude-code",
          pluginIds: ["claude-b"],
        }),
      ),
    );
    expect(
      screen.getByRole("checkbox", { name: "Claude A" }),
    ).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Claude B" })).toBeChecked();
  });

  it("retains plugins hidden by the current platform when editing a selection", async () => {
    const user = userEvent.setup();
    skillNamesMock.mockReturnValue(skillNames([]));
    pluginsMock.mockImplementation((enabled: boolean | undefined) => ({
      data: enabled
        ? [
            {
              id: "posix-only",
              displayName: "POSIX Plugin",
              clientType: "claude-code",
              enabled: true,
              contentHash: "hash-posix",
              approvedContentHash: "hash-posix",
              supportedPlatforms: ["posix"],
            },
            {
              id: "windows-only",
              displayName: "Windows Plugin",
              clientType: "claude-code",
              enabled: true,
              contentHash: "hash-windows",
              approvedContentHash: "hash-windows",
              supportedPlatforms: ["windows"],
            },
            {
              id: "cross-platform",
              displayName: "Cross-platform Plugin",
              clientType: "claude-code",
              enabled: true,
              contentHash: "hash-cross",
              approvedContentHash: "hash-cross",
              supportedPlatforms: ["posix", "windows"],
            },
          ]
        : undefined,
      isPending: false,
    }));
    const platformSpy = vi
      .spyOn(window.navigator, "platform", "get")
      .mockReturnValue("Win32");
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    try {
      renderPanel({
        mcpGateways: [],
        mcpGatewayId: null,
        llmProxyId: null,
      });
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            platform: "windows",
            pluginIds: ["cross-platform", "windows-only"],
          }),
        ),
      );
      await user.click(screen.getByTestId("connect-change-plugins"));
      await user.click(
        screen.getByRole("checkbox", { name: "Windows Plugin" }),
      );
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ pluginIds: ["cross-platform"] }),
        ),
      );

      await user.click(screen.getByTestId("connect-change-platform"));
      expect(screen.getByTestId("connect-platform-select")).toBeInTheDocument();
      await user.click(screen.getByRole("tab", { name: /macOS \/ Linux/ }));

      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            platform: "macos",
            pluginIds: ["cross-platform", "posix-only"],
          }),
        ),
      );
    } finally {
      platformSpy.mockRestore();
      if (originalScrollIntoView) {
        Element.prototype.scrollIntoView = originalScrollIntoView;
      } else {
        // jsdom does not define it; remove the local Radix compatibility shim.
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("waits for plugin permissions before generating the command", async () => {
    vi.mocked(useHasPermissions).mockImplementation((permissions) => {
      const pluginCheck = "plugin" in permissions;
      return {
        data: !pluginCheck,
        isPending: pluginCheck,
      } as ReturnType<typeof useHasPermissions>;
    });
    const { rerender } = renderPanel();

    // The debounce runs at 0 ms here (see beforeEach), so a short wait is
    // already past the point where a premature generation would have fired.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createSetupMock).not.toHaveBeenCalled();

    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    rerender(<ConnectCommandPanel {...renderPanelProps()} />);

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({ pluginIds: ["b1"] }),
      ),
    );
  });

  it("generates plugin setup when config loading fails", async () => {
    vi.mocked(useConfig).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
    } as ReturnType<typeof useConfig>);
    renderPanel();

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({ pluginIds: ["b1"] }),
      ),
    );
    expect(await screen.findByText(COMMAND)).toBeInTheDocument();
  });

  it.each([
    ["codex", "Install 1 plugin", "After setup, open /hooks"],
    ["copilot-cli", "Install 1 plugin", null],
    ["cursor", "Install 1 plugin manually", null],
  ] as const)("reviews %s plugin installation", async (clientId, summaryCopy, detailCopy) => {
    pluginsMock.mockImplementation((enabled: boolean | undefined) => ({
      data: enabled
        ? [
            {
              id: "plugin-for-client",
              displayName: `${clientId} plugin`,
              clientType: clientId,
              enabled: true,
              contentHash: "hash-client",
              approvedContentHash: "hash-client",
              supportedPlatforms: ["posix", "windows"],
            },
          ]
        : undefined,
      isPending: false,
    }));
    renderPanel({ client: findClient(clientId) });

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clientId,
          pluginIds: ["plugin-for-client"],
        }),
      ),
    );
    expect(
      screen.getByRole("link", { name: "1 plugin" }).closest("li"),
    ).toHaveTextContent(summaryCopy);
    if (detailCopy) {
      expect(screen.getByText(new RegExp(detailCopy, "i"))).toBeInTheDocument();
    }
  });

  it("shows the auto-detected platform in the review step", async () => {
    renderPanel();
    await screen.findByText(COMMAND);
    // jsdom reports no Windows UA, so detection falls back to the bash option.
    expect(screen.getByText(/Run on/)).toBeInTheDocument();
    expect(screen.getByText("macOS / Linux")).toBeInTheDocument();
    expect(screen.getByTestId("connect-change-platform")).toBeInTheDocument();
  });

  it("shows that Windows setup excludes plugins", async () => {
    const platformSpy = vi
      .spyOn(window.navigator, "platform", "get")
      .mockReturnValue("Win32");
    try {
      renderPanel();
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            platform: "windows",
            pluginIds: [],
          }),
        ),
      );
      expect(
        screen.getByText(/No compatible plugins for Windows/),
      ).toBeVisible();
      expect(
        screen.getByText(/Not compatible with Windows: OpenAPPA/),
      ).toBeVisible();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("installs plugins explicitly marked Windows-compatible", async () => {
    pluginsMock.mockImplementation((enabled: boolean | undefined) => ({
      data: enabled
        ? [
            {
              id: "windows-hook",
              displayName: "Superpowers",
              clientType: "claude-code",
              enabled: true,
              contentHash: "windows-hash",
              approvedContentHash: "windows-hash",
              supportedPlatforms: ["posix", "windows"],
            },
          ]
        : undefined,
      isPending: false,
    }));
    skillNamesMock.mockReturnValue(skillNames([]));
    const platformSpy = vi
      .spyOn(window.navigator, "platform", "get")
      .mockReturnValue("Win32");
    try {
      renderPanel({
        mcpGateways: [],
        mcpGatewayId: null,
        llmProxyId: null,
      });
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            platform: "windows",
            pluginIds: ["windows-hook"],
          }),
        ),
      );
      expect(screen.getByText("Superpowers")).toBeVisible();
      expect(
        screen.getByRole("link", { name: "1 plugin" }).closest("li"),
      ).toHaveTextContent("Install 1 plugin");
    } finally {
      platformSpy.mockRestore();
    }
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

  it("names the seeded personal gateway after the deployment, not 'my_gateway'", async () => {
    // "My Gateway" is the name every member's gateway is seeded with, so
    // my_gateway in the client's server list tells the user nothing about
    // which platform serves it.
    renderPanel({
      mcpGateways: [
        {
          id: "g1",
          name: "My Gateway",
          agentType: "mcp_gateway",
          isPersonalGateway: true,
        },
      ],
    });
    await screen.findByText(COMMAND);

    expect(screen.getByText("archestra")).toBeInTheDocument();
    expect(screen.queryByText("my_gateway")).not.toBeInTheDocument();
  });

  it("names the seeded personal gateway after a white-label app name", async () => {
    vi.mocked(useAppName).mockReturnValue("Acme AI");
    renderPanel({
      mcpGateways: [
        {
          id: "g1",
          name: "My Gateway",
          agentType: "mcp_gateway",
          isPersonalGateway: true,
        },
      ],
    });
    await screen.findByText(COMMAND);

    expect(screen.getByText("acme_ai")).toBeInTheDocument();
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
    expect(
      screen.getByText(/Everything shared with you is installed/),
    ).toBeVisible();
    expect(
      screen.queryByText(/Only skills in the LLM Proxy's environment/),
    ).not.toBeInTheDocument();
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
    // appearing must not silently re-enable the plugin after an explicit
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
    skillNamesMock.mockReturnValue(
      skillNames([
        { id: "s1", name: "warehouse-postgres" },
        { id: "s2", name: "billing-pipeline" },
        { id: "s3", name: "freshly-added" },
      ]),
    );
    rerender(<ConnectCommandPanel {...renderPanelProps()} />);

    // still opted out — no skills ride along
    await waitFor(() => expect(createSetupMock).toHaveBeenCalled());
    expect(createSetupMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ skills: undefined }),
    );
    expect(screen.getByText("Shared skills not installed")).toBeInTheDocument();
  });

  it("names the skills it installs, and turning them off regenerates without them", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(COMMAND);

    // the review line lists exactly what rides along
    expect(
      screen.getByText(/warehouse-postgres, billing-pipeline/),
    ).toBeInTheDocument();

    // Skills are all-or-nothing here: the command registers the shared
    // marketplace URL, which always serves everything the caller may read, so
    // there is deliberately no per-skill choice to offer.
    await user.click(screen.getByTestId("connect-change-skills"));
    await user.click(
      screen.getByRole("checkbox", { name: /install shared skills/i }),
    );

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ skills: undefined }),
      ),
    );
    expect(screen.getByText(/Shared skills not installed/)).toBeInTheDocument();
  });

  it("truncates the skill names line past six skills", async () => {
    skillNamesMock.mockReturnValue(
      skillNames(
        Array.from({ length: 8 }, (_, i) => ({
          id: `s${i}`,
          name: `skill-${i}`,
        })),
      ),
    );
    renderPanel();
    await screen.findByText(COMMAND);

    // first six named, remainder summarized
    expect(
      screen.getByText(
        /skill-0, skill-1, skill-2, skill-3, skill-4, skill-5 and 2 more/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "SPAN" && el.textContent === "8 shared skills",
      ),
    ).toBeInTheDocument();
  });

  it("lists the MCP servers behind the selected gateway", async () => {
    renderPanel();
    await screen.findByText(COMMAND);

    expect(screen.getByTestId("gateway-servers-summary")).toHaveAttribute(
      "data-gateway-id",
      "g1",
    );
  });

  it("offers provider selection inside the proxy editor", async () => {
    const onProviderSelect = vi.fn();
    renderPanel({ onProviderSelect });
    await screen.findByText(COMMAND);

    const user = userEvent.setup();
    expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
    await user.click(screen.getByTestId("connect-change-proxy"));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Provider" }), {
      key: "ArrowDown",
    });
    expect(screen.getByRole("option", { name: "Anthropic" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "AWS Bedrock" }));
    expect(onProviderSelect).toHaveBeenCalledWith("bedrock");
  });

  it("opens an inline add-provider-key dialog from the proxy editor when no provider can mint a virtual key", async () => {
    // An admin mapped a key for Claude Code, but the user can resolve none, and
    // may create one (hasPermissionsMock defaults to true for
    // llmProviderApiKey:create).
    mapClientProviderKeys({ "claude-code": ["anthropic"] });
    availableKeysMock.mockReturnValue({ data: [] });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("connect-change-proxy"));
    await user.click(screen.getByTestId("connect-auth-add-provider-key"));

    expect(screen.getByTestId("add-provider-key-dialog")).toBeInTheDocument();
  });

  it("routes Cursor's models through the Model Router with one virtual key", async () => {
    availableKeysMock.mockReturnValue({
      data: [
        { provider: "anthropic", isPrimary: true },
        { provider: "openai", isPrimary: true },
      ],
    });
    renderPanel({ client: findClient("cursor") });
    await screen.findByText(COMMAND);

    expect(createSetupMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        clientId: "cursor",
        proxyAuth: "primary-providers",
        provider: undefined,
      }),
    );
    expect(
      screen.getByTestId("connect-change-proxy").closest("li"),
    ).toHaveTextContent(
      "Route Cursor's models (2 providers) through the Model Router using a virtual key",
    );
  });

  it("still connects Cursor's tools when no key can route its models", async () => {
    // The default keys are not primary, and no admin mapped any for Cursor.
    renderPanel({ client: findClient("cursor") });
    await screen.findByText(COMMAND);

    expect(createSetupMock).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ proxyAuth: expect.anything() }),
    );
    expect(
      screen.getByTestId("connect-change-proxy").closest("li"),
    ).toHaveTextContent("Cursor keeps its own models");
  });

  it("connects without model routing when an admin-mapped provider has no usable key", async () => {
    // An admin maps keys for Claude Code, so it needs a virtual key, but the
    // user can resolve no key to mint one from.
    mapClientProviderKeys({ "claude-code": ["anthropic", "bedrock"] });
    availableKeysMock.mockReturnValue({ data: [] });
    renderPanel();

    // Tools still connect: the setup goes ahead without the proxy...
    await screen.findByText(COMMAND);
    expect(createSetupMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mcpGatewayId: "g1",
        llmProxyId: undefined,
        provider: undefined,
        proxyAuth: undefined,
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Finish the OAuth flow" }),
    ).toBeInTheDocument();
    // ...and a notice explains why, with a way to add a key. Two supported
    // providers (Anthropic, Bedrock) → the CTA stays generic.
    expect(
      screen.getByText(/Setup connects without model routing until you add/),
    ).toBeVisible();
    expect(
      screen.getByTestId("connect-gate-add-provider-key"),
    ).toHaveTextContent("Add a provider key");
  });

  it.each([
    {
      case: "no usable primary key",
      keys: [
        { provider: "openai", isPrimary: true, requiresReauthentication: true },
        { provider: "anthropic", isPrimary: false },
      ],
      canAttribute: true,
    },
    {
      case: "no permission to mint virtual keys",
      keys: [{ provider: "anthropic", isPrimary: true }],
      canAttribute: false,
    },
  ])("still connects OpenCode's tools without model routing with $case", async ({
    keys,
    canAttribute,
  }) => {
    availableKeysMock.mockReturnValue({ data: keys });
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: "llmVirtualKey" in permissions ? canAttribute : true,
        }) as ReturnType<typeof useHasPermissions>,
    );
    renderPanel({ client: findClient("opencode") });

    await screen.findByText(COMMAND);
    expect(createSetupMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        clientId: "opencode",
        mcpGatewayId: "g1",
        llmProxyId: undefined,
        proxyAuth: undefined,
      }),
    );
    expect(
      screen.getByText(/OpenCode.* connects without model routing/),
    ).toBeVisible();
  });

  it("opens the add-provider-key dialog from the step-3 gate", async () => {
    mapClientProviderKeys({ "claude-code": ["anthropic"] });
    availableKeysMock.mockReturnValue({ data: [] });
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByTestId("connect-gate-add-provider-key"),
    );

    expect(screen.getByTestId("add-provider-key-dialog")).toBeInTheDocument();
  });

  it("brands the step-3 gate CTA to the sole provider (Codex → OpenAI)", async () => {
    mapClientProviderKeys({ codex: ["openai"] });
    availableKeysMock.mockReturnValue({ data: [] });
    renderPanel({ client: findClient("codex") });

    const gateButton = await screen.findByTestId(
      "connect-gate-add-provider-key",
    );
    // OpenAI-branded, not a generic "provider key".
    expect(gateButton).toHaveTextContent("Add an OpenAI key");
    expect(within(gateButton).getByTestId("provider-icon")).toHaveAttribute(
      "data-provider",
      "openai",
    );
  });

  it("skips skills entirely for callers who cannot read them", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    renderPanel();

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({ skills: undefined }),
      ),
    );
    // the skill list isn't even fetched for callers who can't install skills,
    // and the wizard grows no extra step: the script is the whole flow
    expect(skillNamesMock).toHaveBeenLastCalledWith({ enabled: false });
    expect(
      screen.queryByTestId("skills-marketplace-step"),
    ).not.toBeInTheDocument();
  });

  it("still offers the marketplace step when there is nothing to put in a command", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    renderPanel({
      mcpGateways: null,
      mcpGatewayId: null,
      llmProxyId: null,
    });

    expect(
      await screen.findByTestId("skills-marketplace-step"),
    ).toBeInTheDocument();
    expect(createSetupMock).not.toHaveBeenCalled();
  });

  it("drops the marketplace step when the script already installs the skills", async () => {
    renderPanel();

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({ skills: expect.anything() }),
      ),
    );
    expect(
      screen.queryByTestId("skills-marketplace-step"),
    ).not.toBeInTheDocument();
  });

  describe("script client model choice", () => {
    it("surfaces the model in the review step and sends it with the setup", async () => {
      renderPanel({ client: findClient("copilot-cli") });

      // first supported provider (OpenAI) → its default model is preselected
      expect(await screen.findByText("gpt-5.5")).toBeInTheDocument();
      expect(screen.getByTestId("connect-change-model")).toBeInTheDocument();
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenCalledWith(
          expect.objectContaining({
            clientId: "copilot-cli",
            model: "gpt-5.5",
          }),
        ),
      );
    });

    it("regenerates the command with an edited model", async () => {
      const user = userEvent.setup();
      renderPanel({ client: findClient("copilot-cli") });
      await screen.findByText(COMMAND);

      await user.click(screen.getByTestId("connect-change-model"));
      const input = screen.getByPlaceholderText("Model id");
      fireEvent.change(input, { target: { value: "o4-mini" } });

      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ model: "o4-mini" }),
        ),
      );
    });

    it("routes OpenCode through one virtual key for its primary providers, ignoring a bookmarked provider", async () => {
      availableKeysMock.mockReturnValue({
        data: [
          { provider: "anthropic", isPrimary: true },
          { provider: "bedrock", isPrimary: false },
        ],
      });
      renderPanel({ client: findClient("opencode"), urlProvider: "bedrock" });

      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            clientId: "opencode",
            llmProxyId: "p1",
            proxyAuth: "primary-providers",
            provider: undefined,
          }),
        ),
      );
      expect(
        screen.queryByRole("combobox", { name: "Provider" }),
      ).not.toBeInTheDocument();
    });

    it("backs OpenCode's virtual key only with usable primary credentials", async () => {
      availableKeysMock.mockReturnValue({
        data: [
          { provider: "anthropic", isPrimary: true },
          {
            provider: "openai",
            isPrimary: true,
            requiresReauthentication: true,
          },
          { provider: "vllm", isPrimary: true, baseUrl: "  " },
          // Its proxy adapter rejects tool calls, which OpenCode always sends.
          { provider: "microsoft-365-copilot", isPrimary: true },
        ],
      });
      renderPanel({ client: findClient("opencode") });
      await screen.findByText(COMMAND);

      expect(
        screen.getByTestId("connect-change-proxy").closest("li"),
      ).toHaveTextContent(
        "Route all primary model providers (1) through the LLM Proxy using a virtual key",
      );
    });

    it("filters synced models and regenerates setup with the keyboard selection", async () => {
      modelsByProviderMock.mockReturnValue({
        openai: [
          ...Array.from({ length: 100 }, (_, index) => ({
            id: `synced-model-${index}`,
          })),
          { id: "o4-mini" },
        ],
      });
      const user = userEvent.setup();
      renderPanel({ client: findClient("copilot-cli") });
      await screen.findByText(COMMAND);

      await user.click(screen.getByTestId("connect-change-model"));
      const picker = screen.getByRole("combobox", { name: "Model" });
      await user.click(picker);
      // Keep the default reachable even when it isn't in the synced catalog.
      expect(screen.getByRole("option", { name: "gpt-5.5" })).toBeVisible();
      const search = screen.getByPlaceholderText("Search models...");
      await user.type(search, "missing-model");
      expect(screen.getByText("No models found.")).toBeVisible();
      expect(screen.queryAllByRole("option")).toHaveLength(0);

      await user.clear(search);
      await user.type(search, "O4-MINI");
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(screen.getByRole("option", { name: "o4-mini" })).toBeVisible();
      await user.keyboard("{ArrowDown}{Enter}");

      expect(picker).toHaveTextContent("o4-mini");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ model: "o4-mini" }),
        ),
      );
    });

    it("shows no model row for clients without provider env wiring", async () => {
      renderPanel(); // claude-code
      await screen.findByText(COMMAND);
      expect(
        screen.queryByTestId("connect-change-model"),
      ).not.toBeInTheDocument();
    });
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
      expect(screen.getByTestId("connect-command-status")).toHaveTextContent(
        "Connect GitHub Copilot to generate the setup command",
      );
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
            apiKey: "gho_test",
          }),
        ),
      );
      // A key is the caller's own unless they ask to share it.
      expect(createKeyMock.mock.calls[0][0]).not.toHaveProperty("shared");
    });

    it("keeps provider selection available after picking GitHub Copilot", async () => {
      // Copilot forces virtual-key auth, but only while it is selected. It
      // must not overwrite the stored auth mode — that would filter every
      // keyless provider out of the tabs until the next page load.
      availableKeysMock.mockReturnValue({ data: [] });
      const copilotCli = findClient("copilot-cli");
      const { rerender } = renderPanel({ client: copilotCli });

      const user = userEvent.setup();
      await user.click(screen.getByTestId("connect-change-proxy"));
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Provider" }), {
        key: "ArrowDown",
      });
      expect(screen.getByRole("option", { name: "OpenAI" })).toBeVisible();
      await user.click(screen.getByRole("option", { name: "GitHub Copilot" }));

      // Picking Copilot lands in the URL provider prop.
      rerender(
        <ConnectCommandPanel
          {...renderPanelProps({
            client: copilotCli,
            urlProvider: "github-copilot",
          })}
        />,
      );
      await screen.findByRole("button", { name: /Sign in with GitHub/i });
      // The other providers stay offered so the user can switch back.
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Provider" }), {
        key: "ArrowDown",
      });
      expect(screen.getByRole("option", { name: "OpenAI" })).toBeVisible();
      await user.click(screen.getByRole("option", { name: "OpenAI" }));

      // Switching back generates a passthrough command again.
      rerender(
        <ConnectCommandPanel
          {...renderPanelProps({ client: copilotCli, urlProvider: "openai" })}
        />,
      );
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            provider: "openai",
            proxyAuth: "provider-key",
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

describe("a setup over a delivery limit on the approval page", () => {
  const PLUGIN_LIMIT_MESSAGE =
    "556 plugins are selected, but one setup can install at most 555. Choose 555 or fewer in Setup options, or turn plugins off.";

  it("explains too many plugins instead of sending a setup the backend refuses", async () => {
    pluginsMock.mockImplementation((enabled: boolean | undefined) => ({
      data: enabled ? manyPlugins(556) : undefined,
      isPending: false,
    }));
    const user = userEvent.setup();
    const { finish } = renderApproval();
    try {
      await screen.findByText("ABCD-1234");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        PLUGIN_LIMIT_MESSAGE,
      );
      expect(toast.error).toHaveBeenCalledWith(PLUGIN_LIMIT_MESSAGE, {
        id: "connect-setup-limit",
      });
      await confirmCode(user);
      expect(
        screen.getByRole("button", { name: "Approve connection" }),
      ).toBeDisabled();
      expect(await approveTooltip(user)).toHaveTextContent(
        PLUGIN_LIMIT_MESSAGE,
      );
      expect(createSetupMock).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: /Setup options/ }));
      await user.click(screen.getByRole("switch", { name: "Plugins" }));
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ pluginIds: [] }),
        ),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Approve connection" }),
        ).toBeEnabled(),
      );
      expect(screen.queryByText(PLUGIN_LIMIT_MESSAGE)).toBeNull();
    } finally {
      finish();
    }
  });

  it("explains too many shared skills and connects once skills are off", async () => {
    // The endpoint stops at the cap; the total says how many there are.
    skillNamesMock.mockReturnValue(
      skillNames(
        Array.from({ length: 1111 }, (_, index) => ({
          id: `skill-${index}`,
          name: `skill-${index}`,
        })),
        1112,
      ),
    );
    const message =
      "1,112 skills are shared with you, but one setup can include at most 1,111. Turn skills off in Setup options to connect without them.";
    const user = userEvent.setup();
    const { finish } = renderApproval();
    try {
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(toast.error).toHaveBeenCalledWith(message, {
        id: "connect-setup-limit",
      });
      expect(createSetupMock).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: /Setup options/ }));
      await user.click(screen.getByRole("switch", { name: "Skills" }));
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ skills: undefined, pluginIds: ["b1"] }),
        ),
      );
    } finally {
      finish();
    }
  });

  it("shows the backend's reason when it refuses the setup", async () => {
    createSetupMock.mockImplementationOnce(async () => {
      setupHookOptions.onRefused?.(
        "Plugin delivery is limited to 1110 MiB of plugin files",
      );
      return null;
    });
    const user = userEvent.setup();
    const { finish } = renderApproval();
    try {
      await screen.findByText("ABCD-1234");
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        "Could not prepare the setup: Plugin delivery is limited to 1110 MiB of plugin files.",
      );
      await confirmCode(user);
      expect(await approveTooltip(user)).toHaveTextContent(
        "Could not prepare the setup: Plugin delivery is limited to 1110 MiB of plugin files. Adjust Setup options, then select Retry setup.",
      );

      await user.click(
        within(alert).getByRole("button", { name: "Retry setup" }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Approve connection" }),
        ).toBeEnabled(),
      );
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      finish();
    }
  });

  function renderApproval() {
    const server = setupServer(
      http.get("http://localhost:9000/api/client-connections/demo", () =>
        HttpResponse.json({
          clientId: "claude-code",
          platform: "macos",
          userCode: "ABCD-1234",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      ),
    );
    server.listen({ onUnhandledRequest: "error" });
    archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("connectRequest=demo&platform=macos") as ReturnType<
        typeof useSearchParams
      >,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectCommandPanel {...renderPanelProps()} />
      </QueryClientProvider>,
    );
    return {
      finish: () => {
        view.unmount();
        queryClient.clear();
        server.close();
        archestraApiClient.setConfig({ baseUrl: "" });
      },
    };
  }

  async function confirmCode(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      screen.getByRole("checkbox", {
        name: "This code matches the code in my terminal.",
      }),
    );
  }

  async function approveTooltip(user: ReturnType<typeof userEvent.setup>) {
    const approve = screen.getByRole("button", { name: "Approve connection" });
    // A disabled button gets no pointer events; its wrapper carries the tooltip.
    await user.hover(approve.parentElement as HTMLElement);
    return screen.findByRole("tooltip");
  }

  function manyPlugins(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: `plugin-${index}`,
      displayName: `Plugin ${index}`,
      description: "",
      clientType: "claude-code",
      enabled: true,
      contentHash: `hash-${index}`,
      approvedContentHash: `hash-${index}`,
      supportedPlatforms: ["posix"],
    }));
  }
});
