import { archestraApiClient } from "@archestra/shared";
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
import { usePathname, useRouter, useSearchParams } from "next/navigation";

vi.mock("next/navigation");

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useConfig, useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganization } from "@/lib/organization.query";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectCommandPanel } from "./connect-command-panel";
import { ConnectionFlow } from "./connection-flow";

const {
  createSetupMock,
  allSkillsMock,
  pluginsMock,
  skillsMarketplaceVisibleMock,
} = vi.hoisted(() => ({
  createSetupMock: vi.fn(),
  allSkillsMock: vi.fn(),
  pluginsMock: vi.fn(),
  skillsMarketplaceVisibleMock: vi.fn(() => true),
}));

vi.mock("@/lib/connection-setup.query", () => ({
  useCreateConnectionSetup: () => ({
    mutateAsync: createSetupMock,
    isPending: false,
  }),
}));

vi.mock("./skills-marketplace-step", () => ({
  useAllSkills: (params?: { enabled?: boolean; forAgentId?: string | null }) =>
    allSkillsMock(params),
  // The marketplace step has its own test file; here it only matters whether
  // the panel renders it as a step.
  useSkillsMarketplaceVisible: () => skillsMarketplaceVisibleMock(),
  SkillsMarketplaceStep: () => <div data-testid="skills-marketplace-step" />,
}));

vi.mock("@/lib/plugins/plugin.query", () => ({
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
    llmProxyId: "p1",
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
  allSkillsMock.mockReturnValue({
    data: [
      { id: "s1", name: "warehouse-postgres", scope: "org", teams: [] },
      // A colleague's personal skill: the picker lists these for skill admins
      // and preselects them, so the row must name whose it is.
      {
        id: "s2",
        name: "billing-pipeline",
        scope: "personal",
        authorId: "user-2",
        authorName: "Dana",
        teams: [],
      },
    ],
  });
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
  it("switches between coding prompts and Desktop setup without preparing coding-client scripts", async () => {
    vi.mocked(useRouter).mockReturnValue({
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/connection");
    const server = setupServer(
      http.get("http://localhost:9000/api/agents/all", () =>
        HttpResponse.json([]),
      ),
    );
    server.listen({ onUnhandledRequest: "error" });
    archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = userEvent.setup();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectionFlow llmProxyId="p1" />
      </QueryClientProvider>,
    );
    try {
      expect(
        screen.getByRole("heading", { name: "Connect Claude Code" }),
      ).toBeVisible();
      for (const label of ["Cursor", "Codex", "Copilot CLI"]) {
        await user.click(
          screen.getByRole("button", {
            name: new RegExp(`${label} logo ${label}`),
          }),
        );
        expect(
          screen.getByRole("heading", { name: `Connect ${label}` }),
        ).toBeVisible();
        expect(
          screen.getByText(
            `Read ${window.location.origin}/connect.md and connect ${label}.`,
          ),
        ).toBeVisible();
      }
      expect(createSetupMock).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("button", {
          name: /Claude Desktop logo Claude Desktop/,
        }),
      );
      expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();
      expect(
        screen.getByRole("heading", { name: "Install the connection" }),
      ).toBeVisible();
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenCalledWith(
          expect.objectContaining({ clientId: "claude-desktop" }),
        ),
      );
      expect(screen.queryByText(/requires the Claude Code CLI/)).toBeNull();
      await user.click(
        screen.getByRole("button", { name: /Claude Code logo Claude Code/ }),
      );
      expect(screen.getByRole("button", { name: "Copy prompt" })).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Review the setup" }),
      ).toBeNull();
    } finally {
      view.unmount();
      queryClient.clear();
      server.close();
    }
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
    expect(screen.getByText(COMMAND)).not.toBeVisible();
    await userEvent.click(screen.getByText("Advanced: terminal setup"));
    expect(screen.getByText(COMMAND)).toBeVisible();
    expect(createKeyMock).not.toHaveBeenCalled();
  });

  it("regenerates Desktop setup when the platform or API-key authentication changes", async () => {
    const user = userEvent.setup();
    renderPanel({ client: findClient("claude-desktop") });
    await screen.findByText(COMMAND);
    await user.click(screen.getByTestId("connect-change-platform"));
    await user.click(screen.getByRole("tab", { name: "Windows" }));
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          platform: "windows",
          proxyAuth: "provider-key",
        }),
      ),
    );
    await user.click(screen.getByTestId("connect-change-proxy"));
    await user.click(screen.getByRole("tab", { name: "API key" }));
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clientId: "claude-desktop",
          platform: "windows",
          proxyAuth: "virtual-key",
          provider: "anthropic",
        }),
      ),
    );
    await user.click(screen.getByRole("tab", { name: "Claude subscription" }));
    await waitFor(() =>
      expect(createSetupMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ proxyAuth: "provider-key" }),
      ),
    );
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
      expect(screen.queryByText(COMMAND)).toBeNull();
      expect(screen.queryByTestId("connect-regenerate-command")).toBeNull();
      expect(screen.queryByTestId("connect-change-skills")).toBeNull();
      expect(
        screen.queryByRole("heading", { name: "Finish the OAuth flow" }),
      ).toBeNull();
      await user.click(screen.getByRole("button", { name: "Customize setup" }));
      await user.click(screen.getByTestId("connect-change-skills"));
      await user.click(
        screen.getByRole("checkbox", { name: "Install shared skills" }),
      );
      await waitFor(() =>
        expect(createSetupMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ skills: undefined }),
        ),
      );
      await user.click(
        screen.getByRole("button", { name: "Done customizing" }),
      );
      expect(
        screen.queryByRole("checkbox", { name: "Install shared skills" }),
      ).toBeNull();
      await user.click(
        screen.getByRole("checkbox", {
          name: "This code matches the code in my terminal.",
        }),
      );
      await user.click(
        screen.getByRole("button", { name: "Approve connection" }),
      );
      await screen.findByText(
        "Connection approved. Return to your terminal to finish setup.",
      );
      expect(decisions).toEqual([{ decision: "approve", setupId: "setup-1" }]);
    } finally {
      view.unmount();
      queryClient.clear();
      server.close();
      archestraApiClient.setConfig({ baseUrl: "" });
    }
  });

  it("regenerates the setup as proxy and skills availability changes without losing the gateway", async () => {
    const props = renderPanelProps();
    const { rerender } = render(<ConnectCommandPanel {...props} />);
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
    allSkillsMock.mockReturnValue({ data: [] });
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
    allSkillsMock.mockReturnValue({ data: [] });
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
    allSkillsMock.mockReturnValue({ data: [] });
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
    allSkillsMock.mockReturnValue({ data: [] });
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

    await new Promise((resolve) => setTimeout(resolve, 500));
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

  it("still generates non-plugin setup sections when config loading fails", async () => {
    vi.mocked(useConfig).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
    } as ReturnType<typeof useConfig>);
    renderPanel();

    await waitFor(() =>
      expect(createSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({ pluginIds: [] }),
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
    allSkillsMock.mockReturnValue({ data: [] });
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

  it("opens an inline add-provider-key dialog from the auth editor when no provider can mint a virtual key", async () => {
    // No configured provider key, but the user may create one
    // (hasPermissionsMock defaults to true for llmProviderApiKey:create).
    availableKeysMock.mockReturnValue({ data: [] });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("connect-change-proxy"));
    await user.click(screen.getByRole("tab", { name: "Virtual key" }));
    await user.click(screen.getByTestId("connect-auth-add-provider-key"));

    expect(screen.getByTestId("add-provider-key-dialog")).toBeInTheDocument();
  });

  it("gates step 3 and hides the OAuth step when virtual-key auth has no backing key", async () => {
    availableKeysMock.mockReturnValue({ data: [] });
    const user = userEvent.setup();
    renderPanel();

    // Passthrough by default → a runnable command, plus the OAuth step.
    await screen.findByText(COMMAND);
    expect(
      screen.getByRole("heading", { name: "Finish the OAuth flow" }),
    ).toBeInTheDocument();

    // Switch the proxy auth to a virtual key that nothing can back.
    await user.click(screen.getByTestId("connect-change-proxy"));
    await user.click(screen.getByRole("tab", { name: "Virtual key" }));

    // Step 3 gates on adding a key instead of shipping a command...
    const gateButton = await screen.findByTestId(
      "connect-gate-add-provider-key",
    );
    // Two supported providers (Anthropic, Bedrock) → the CTA stays generic.
    expect(gateButton).toHaveTextContent("Add a provider key");
    expect(screen.queryByText(COMMAND)).not.toBeInTheDocument();
    expect(screen.getByTestId("connect-command-status")).toHaveTextContent(
      "Add a provider key to generate the setup command",
    );
    // ...and the setup, now unproducible as configured, drops the OAuth step.
    expect(
      screen.queryByRole("heading", { name: "Finish the OAuth flow" }),
    ).not.toBeInTheDocument();
  });

  it("opens the add-provider-key dialog from the step-3 gate", async () => {
    availableKeysMock.mockReturnValue({ data: [] });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(COMMAND);

    await user.click(screen.getByTestId("connect-change-proxy"));
    await user.click(screen.getByRole("tab", { name: "Virtual key" }));
    await user.click(
      await screen.findByTestId("connect-gate-add-provider-key"),
    );

    expect(screen.getByTestId("add-provider-key-dialog")).toBeInTheDocument();
  });

  it("brands the step-3 gate CTA to the sole provider (Codex → OpenAI)", async () => {
    availableKeysMock.mockReturnValue({ data: [] });
    const user = userEvent.setup();
    renderPanel({ client: findClient("codex") });

    await screen.findByText(COMMAND);
    await user.click(screen.getByTestId("connect-change-proxy"));
    await user.click(screen.getByRole("tab", { name: "Virtual key" }));

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
    expect(allSkillsMock).toHaveBeenLastCalledWith(
      // objectContaining, so the deferral this list is fetched under stays an
      // implementation detail: what matters is that it is switched off.
      expect.objectContaining({ enabled: false }),
    );
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

  describe("Copilot CLI model choice", () => {
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

    it("offers the org's synced models for the provider as a dropdown", async () => {
      modelsByProviderMock.mockReturnValue({
        openai: [{ id: "gpt-5.5" }, { id: "o4-mini" }],
      });
      const user = userEvent.setup();
      renderPanel({ client: findClient("copilot-cli") });
      await screen.findByText(COMMAND);

      await user.click(screen.getByTestId("connect-change-model"));
      // a Select (not the free-text input) backs multi-option providers
      expect(screen.queryByPlaceholderText("Model id")).not.toBeInTheDocument();
      expect(screen.getByRole("combobox")).toBeInTheDocument();
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
            scope: "personal",
            apiKey: "gho_test",
          }),
        ),
      );
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

    it("keeps the auth toggle reachable after Virtual key falls back to GitHub Copilot", async () => {
      // With no configured keys, switching Copilot CLI to a virtual key collapses
      // the provider list to GitHub Copilot (the only per-user one). The toggle
      // must stay so the user isn't stranded in virtual-key mode.
      availableKeysMock.mockReturnValue({ data: [] });
      const user = userEvent.setup();
      renderPanel({ client: findClient("copilot-cli") });

      await screen.findByText(COMMAND);
      await user.click(screen.getByTestId("connect-change-proxy"));
      await user.click(screen.getByRole("tab", { name: "Virtual key" }));

      // We fell back to the GitHub Copilot connect gate...
      expect(
        await screen.findByRole("button", { name: /Sign in with GitHub/i }),
      ).toBeInTheDocument();
      // ...but both auth tabs are still there to switch back.
      expect(
        screen.getByRole("tab", { name: "Your provider key" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("tab", { name: "Virtual key" }),
      ).toBeInTheDocument();
    });

    it("switches back to passthrough off the per-user provider so the choice sticks", async () => {
      availableKeysMock.mockReturnValue({ data: [] });
      const onProviderSelect = vi.fn();
      const user = userEvent.setup();
      renderPanel({ client: findClient("copilot-cli"), onProviderSelect });

      await screen.findByText(COMMAND);
      await user.click(screen.getByTestId("connect-change-proxy"));
      await user.click(screen.getByRole("tab", { name: "Virtual key" }));
      await screen.findByRole("button", { name: /Sign in with GitHub/i });

      // Clicking back to passthrough moves off GitHub Copilot (which forces
      // virtual-key) to the first passthrough-capable provider.
      await user.click(screen.getByRole("tab", { name: "Your provider key" }));
      expect(onProviderSelect).toHaveBeenCalledWith("openai");
    });
  });
});
