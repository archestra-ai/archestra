import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useSearchParams } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  useDefaultMcpGateway,
  useProfile,
  useProfiles,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useConfig } from "@/lib/config/config.query";
import { postConnected } from "@/lib/connect-signal";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import {
  useAllCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useOrganization } from "@/lib/organization.query";
import { usePlugins } from "@/lib/plugins/plugin.query";
import { saveConnectChoices } from "./connect-choices";
import ConnectionPage from "./page";

const connectionFlowMock = vi.fn((_props: unknown) => (
  <div data-testid="connection-flow">
    <input aria-label="Selected gateway" defaultValue="Default gateway" />
  </div>
));
const refetchOrganizationMock = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/clipboard");
vi.mock("@/lib/agent.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/guardrails-deployment.query");
vi.mock("@/lib/plugins/plugin.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugins/plugin.query")>()),
  usePlugins: vi.fn(),
}));
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/llm-proxy.query");
vi.mock("@/lib/mcp/internal-mcp-catalog.query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/mcp/internal-mcp-catalog.query")
  >()),
  useAllCatalogTools: vi.fn(),
  useInternalMcpCatalog: vi.fn(),
}));
vi.mock("@/lib/organization.query");
vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getSkills: vi.fn(async () => ({ data: null })),
    },
  };
});
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    children,
    actionButton,
    title,
  }: {
    children: ReactNode;
    actionButton?: ReactNode;
    title: ReactNode;
  }) => (
    <>
      <h1>{title}</h1>
      {actionButton}
      {children}
    </>
  ),
}));
vi.mock("./connect-command-panel", () => ({
  ConnectCommandPanel: (props: {
    variant?: string;
    exclude?: readonly string[];
  }) => (
    <div
      data-testid={props.variant === "download" ? "desktop-download" : "panel"}
      data-exclude={props.exclude?.join(",")}
    />
  ),
}));
vi.mock("./connection-flow", () => ({
  ConnectionFlow: (props: unknown) => connectionFlowMock(props),
}));

function render(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

function mockOrganization(overrides: Record<string, unknown>) {
  vi.mocked(useOrganization).mockReturnValue({
    data: {},
    isPending: false,
    isFetchedAfterMount: true,
    isFetching: false,
    isError: false,
    refetch: refetchOrganizationMock,
    ...overrides,
  } as unknown as ReturnType<typeof useOrganization>);
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(useAppName).mockReturnValue("Example Platform");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(
      "connectRequest=request&clientId=claude-code",
    ) as ReturnType<typeof useSearchParams>,
  );
  refetchOrganizationMock.mockResolvedValue({});
  vi.mocked(useDefaultMcpGateway).mockReturnValue({
    data: undefined,
  } as ReturnType<typeof useDefaultMcpGateway>);
  vi.mocked(useLlmProxy).mockReturnValue({
    data: undefined,
  } as ReturnType<typeof useLlmProxy>);
  vi.mocked(useProfile).mockReturnValue({
    data: undefined,
    isPending: false,
  } as ReturnType<typeof useProfile>);
  vi.mocked(useInternalMcpCatalog).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useInternalMcpCatalog>);
  vi.mocked(useAllCatalogTools).mockReturnValue({
    data: undefined,
  } as ReturnType<typeof useAllCatalogTools>);
  vi.mocked(useProfiles).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useProfiles>);
  vi.mocked(useConfig).mockReturnValue({
    data: undefined,
  } as ReturnType<typeof useConfig>);
  vi.mocked(usePlugins).mockReturnValue({
    data: undefined,
  } as ReturnType<typeof usePlugins>);
  vi.mocked(useGuardrailsDeployment).mockReturnValue({
    data: undefined,
  } as ReturnType<typeof useGuardrailsDeployment>);
});

describe("ConnectPage gateway footprint", () => {
  const api = setupServer();
  const previewUrl = "http://localhost:9000/api/agents/gw-1/mcp-tool-preview";

  beforeAll(() => api.listen({ onUnhandledRequest: "bypass" }));
  afterEach(() => api.resetHandlers());
  afterAll(() => api.close());

  function show(progressive = false) {
    archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
    window.localStorage.clear();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("clientId=claude-code") as ReturnType<
        typeof useSearchParams
      >,
    );
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
      typeof useHasPermissions
    >);
    vi.mocked(useProfile).mockReturnValue({
      data: {
        id: "gw-1",
        name: "Team gateway",
        slug: "team",
        accessAllTools: progressive,
        toolExposureMode: progressive ? "search_and_run_only" : "full",
        tools: ["read", "write", "hidden"].map((name) => ({
          name: `example__${name}`,
          catalogId: "catalog-1",
          description: name,
        })),
      },
      isPending: false,
    } as unknown as ReturnType<typeof useProfile>);
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [
        {
          id: "catalog-1",
          name: "Example server",
          serverType: "remote",
          toolCount: 3,
        },
      ],
    } as unknown as ReturnType<typeof useInternalMcpCatalog>);
    mockOrganization({
      data: {
        connectionDefaultMcpGatewayId: "gw-1",
        connectionShownClientIds: ["claude-code", "codex"],
      },
    });
    return render(<ConnectionPage />);
  }

  const listed = (tokens: number) => ({
    toolExposureMode: "full",
    tools: [
      {
        name: "example__read",
        catalogId: "catalog-1",
        description: "Read items",
        tokens,
      },
      {
        name: "example__write",
        catalogId: "catalog-1",
        description: "Write items",
        tokens,
      },
    ],
  });

  it("counts served tools instead of catalog rows and changes the estimate with the client", async () => {
    api.use(
      http.get(previewUrl, ({ request }) =>
        HttpResponse.json(
          listed(
            new URL(request.url).searchParams.get("client") === "claude-code"
              ? 1200
              : 550,
          ),
        ),
      ),
    );
    show();
    const summary = screen.getByRole("complementary", {
      name: "What Claude Code gets",
    });
    expect(await within(summary).findByText("2 tools")).toBeVisible();
    expect(within(summary).getByText("~2.4K tokens")).toBeVisible();
    expect(within(summary).queryByText("3 tools")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Codex$/ }));
    expect(await screen.findByText("~1.1K tokens")).toBeVisible();
  });

  it("uses the preview's loading mode even when the cached profile has the old mode", async () => {
    api.use(
      http.get(previewUrl, () =>
        HttpResponse.json({
          ...listed(1200),
          toolExposureMode: "search_and_run_only",
        }),
      ),
    );
    show();
    const summary = screen.getByRole("complementary", {
      name: "What Claude Code gets",
    });
    expect(
      await within(summary).findByText("2 tools loaded, more on demand"),
    ).toBeVisible();
    expect(within(summary).getByText("~2.4K tokens")).toBeVisible();
  });

  it("shows an empty gateway instead of retaining catalog counts", async () => {
    api.use(
      http.get(previewUrl, () =>
        HttpResponse.json({ toolExposureMode: "full", tools: [] }),
      ),
    );
    show();
    expect(await screen.findByText("0 tools")).toBeVisible();
    expect(screen.queryByText("3 tools")).toBeNull();
    expect(screen.queryByText("Example server")).toBeNull();
  });

  it("does not substitute catalog totals when the preview fails", async () => {
    api.use(
      http.get(previewUrl, () =>
        HttpResponse.json(
          { error: { message: "Unavailable" } },
          { status: 503 },
        ),
      ),
    );
    show();
    expect(await screen.findByText("Tool counts unavailable")).toBeVisible();
    expect(screen.queryByText("3 tools")).toBeNull();
  });
});

describe("ConnectPage saved agent order", () => {
  it("renders saved order in tiles, including agents previously in Other agents", async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    mockOrganization({
      data: {
        connectionClientOrder: ["n8n", "codex", "claude-code"],
        connectionDefaultClientId: "codex",
        connectionShownClientIds: ["claude-code", "n8n", "codex"],
      },
    });
    render(<ConnectionPage />);
    const names = screen
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());
    const tileNames = names.filter((name) =>
      ["n8n", "Codex", "Claude Code"].includes(name ?? ""),
    );
    expect(tileNames).toEqual(["n8n", "Codex", "Claude Code"]);
    expect(screen.getByRole("button", { name: /Codex$/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Other agents" }));
    await user.click(screen.getByRole("option", { name: /Generic client/ }));
    expect(
      screen.getByRole("button", { name: "Generic client, change agent" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps saved order in the overflow search when tiles do not fit", async () => {
    const width = vi
      .spyOn(Element.prototype, "clientWidth", "get")
      .mockReturnValue(320);
    try {
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as ReturnType<typeof useSearchParams>,
      );
      mockOrganization({
        data: {
          connectionClientOrder: [
            "n8n",
            "codex",
            "openclaw",
            "cursor",
            "claude-code",
          ],
          connectionShownClientIds: [
            "claude-code",
            "cursor",
            "codex",
            "n8n",
            "openclaw",
          ],
        },
      });
      render(<ConnectionPage />);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Other agents" }));
      expect(
        screen
          .getAllByRole("option")
          .map((option) => option.getAttribute("data-value")),
      ).toEqual(["openclaw", "cursor", "claude-code", "generic"]);
      await user.type(screen.getByPlaceholderText("Search agents"), "cl");
      expect(
        screen
          .getAllByRole("option")
          .map((option) => option.getAttribute("data-value")),
      ).toEqual(["openclaw", "claude-code", "generic"]);
    } finally {
      width.mockRestore();
    }
  });
});

describe("ConnectPage guardrails chip", () => {
  function renderPage(
    clientId: string,
    deployment: {
      active: boolean;
      unsupportedClientAction: "bypass" | "block";
      featureEnabled?: boolean;
    },
  ) {
    window.localStorage.clear();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useLlmProxy).mockReturnValue({
      data: { id: "proxy-1" },
    } as unknown as ReturnType<typeof useLlmProxy>);
    vi.mocked(useGuardrailsDeployment).mockReturnValue({
      data: {
        featureEnabled: true,
        ...deployment,
        enabled: deployment.active,
      },
    } as ReturnType<typeof useGuardrailsDeployment>);
    mockOrganization({
      data: {
        connectionShownClientIds: [clientId],
        connectionLlmProxyEnabled: true,
      },
    });
    render(<ConnectionPage />);
  }

  function setup(
    clientId: string,
    deployment: {
      active: boolean;
      unsupportedClientAction: "bypass" | "block";
    },
  ) {
    renderPage(clientId, deployment);
    // The chip is status only; its info button sits inside it.
    const chip = screen
      .getByRole("button", { name: "What the guardrails do" })
      .closest("[data-status-chip]");
    expect(chip).toHaveTextContent("Guardrails");
    expect(chip).not.toHaveTextContent("OpenAPPA");
    return chip as HTMLElement;
  }

  it("says guardrails are not enforced when enforcement is off", () => {
    expect(
      setup("claude-code", { active: false, unsupportedClientAction: "block" }),
    ).toHaveTextContent("Not enforced");
  });

  it("is enforced for an agent the guardrails recognize", () => {
    expect(
      setup("claude-code", { active: true, unsupportedClientAction: "block" }),
    ).toHaveTextContent("Enforced");
  });

  it("says guardrails are not enforced for an allowed unrecognized agent", () => {
    expect(
      setup("cursor", { active: true, unsupportedClientAction: "bypass" }),
    ).toHaveTextContent("Not enforced");
  });

  it("hides the chip while the guardrails beta is off", () => {
    renderPage("claude-code", {
      active: false,
      unsupportedClientAction: "block",
      featureEnabled: false,
    });
    expect(
      screen.queryByRole("button", { name: "What the guardrails do" }),
    ).toBeNull();
  });

  it("says an unrecognized agent is blocked", () => {
    expect(
      setup("cursor", { active: true, unsupportedClientAction: "block" }),
    ).toHaveTextContent("Blocked");
  });
});

describe("ConnectPage (no connect request)", () => {
  beforeEach(() => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
  });

  it.each([
    true,
    false,
    undefined,
  ])("shows the settings link only with read access (%s)", (allowed) => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: permissions.organizationSettings?.includes("read")
            ? allowed
            : false,
        }) as ReturnType<typeof useHasPermissions>,
    );
    mockOrganization({});
    render(<ConnectionPage />);
    const link = screen.queryByRole("link", { name: "Settings" });
    if (allowed) {
      expect(link).toHaveAttribute("href", "/settings/connection");
    } else {
      expect(link).not.toBeInTheDocument();
    }
  });

  it.each([
    true,
    false,
  ])("shows the Statistics link only to log admins (%s)", (allowed) => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: permissions.log?.includes("admin") ? allowed : false,
        }) as ReturnType<typeof useHasPermissions>,
    );
    mockOrganization({});
    render(<ConnectionPage />);
    const link = screen.queryByRole("link", { name: "Statistics" });
    if (allowed) {
      expect(link).toHaveAttribute("href", "/connections/logs");
    } else {
      expect(link).not.toBeInTheDocument();
    }
  });

  it("offers only the agents the admin shows", () => {
    mockOrganization({ data: { connectionShownClientIds: ["cursor"] } });
    render(<ConnectionPage />);
    expect(
      screen.getByRole("heading", {
        name: "Connect your agent to Example Platform",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Cursor/, pressed: true }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Claude Code/ })).toBeNull();
    expect(connectionFlowMock).not.toHaveBeenCalled();
  });

  it("carries what the user left out in the installer command", () => {
    window.localStorage.clear();
    saveConnectChoices("cursor", {
      tools: false,
      skills: false,
      proxy: true,
      plugins: false,
    });
    mockOrganization({ data: { connectionShownClientIds: ["cursor"] } });
    render(<ConnectionPage />);
    // Tools are always included, whatever was saved.
    expect(
      screen.getByText(/--client cursor --exclude skills,plugins$/),
    ).toBeVisible();
    expect(screen.getByText("Run the command in your terminal")).toBeVisible();
    // The installer is the only way in: no prompt to switch to.
    expect(screen.queryByRole("button", { name: "Prompt" })).toBeNull();
  });

  it("shows the LLM proxy as on for supported agents, not active when the admin turned it off", () => {
    window.localStorage.clear();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useLlmProxy).mockReturnValue({
      data: { id: "proxy-1" },
    } as unknown as ReturnType<typeof useLlmProxy>);
    mockOrganization({
      data: {
        connectionShownClientIds: ["claude-code", "hermes-agent"],
        connectionLlmProxyEnabled: true,
      },
    });
    const { unmount } = render(<ConnectionPage />);
    expect(screen.getByText("On")).toBeVisible();
    unmount();

    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("clientId=hermes-agent") as ReturnType<
        typeof useSearchParams
      >,
    );
    const other = render(<ConnectionPage />);
    expect(screen.getByText("On")).toBeVisible();
    other.unmount();

    mockOrganization({
      data: {
        connectionShownClientIds: ["claude-code", "hermes-agent"],
        connectionLlmProxyEnabled: false,
      },
    });
    render(<ConnectionPage />);
    expect(screen.getByText("Not active")).toBeVisible();
  });

  it("lets any agent leave the LLM proxy out", async () => {
    window.localStorage.clear();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useLlmProxy).mockReturnValue({
      data: { id: "proxy-1" },
    } as unknown as ReturnType<typeof useLlmProxy>);
    mockOrganization({
      data: {
        connectionShownClientIds: ["claude-code", "hermes-agent"],
        connectionLlmProxyEnabled: true,
      },
    });
    for (const id of ["claude-code", "hermes-agent"]) {
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(`clientId=${id}`) as ReturnType<
          typeof useSearchParams
        >,
      );
      const { unmount } = render(<ConnectionPage />);
      await userEvent.click(
        screen.getByRole("button", { name: /Choose what to include/ }),
      );
      await userEvent.click(screen.getByRole("switch", { name: /LLM proxy/ }));
      expect(screen.getByText("Off")).toBeVisible();
      // Other agents' prompt is covered by the generic prompt tests.
      if (id === "claude-code")
        expect(
          screen.getByText(/--client claude-code --exclude proxy$/),
        ).toBeVisible();
      unmount();
    }
  });

  it("gives other agents the generic prompt with the gateway to set up", () => {
    window.localStorage.clear();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useProfile).mockReturnValue({
      data: { id: "gw-1", name: "Team gateway", slug: "team", tools: [] },
      isPending: false,
    } as unknown as ReturnType<typeof useProfile>);
    mockOrganization({
      data: {
        connectionShownClientIds: ["hermes-agent"],
        connectionDefaultMcpGatewayId: "gw-1",
      },
    });
    render(<ConnectionPage />);
    expect(
      screen.getByText(
        /connect\.md\?client=generic&gateway=team&exclude=skills,proxy(&base=[^ ]+)? and connect Hermes Agent\./,
      ),
    ).toBeVisible();
  });

  it("sets the generic client up by hand", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("clientId=generic") as ReturnType<
        typeof useSearchParams
      >,
    );
    mockOrganization({});
    render(<ConnectionPage />);
    expect(screen.getByText("Follow the steps for your agent")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Prompt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });

  it("gives other agents the prompt only, even when linked to manual setup", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("clientId=hermes-agent&mode=manual") as ReturnType<
        typeof useSearchParams
      >,
    );
    mockOrganization({});
    render(<ConnectionPage />);
    expect(
      screen.getByText("Paste the prompt into Hermes Agent"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Manual setup" }),
    ).not.toBeInTheDocument();
  });

  it("opens Claude Desktop on its installer download when linked", async () => {
    window.localStorage.clear();
    saveConnectChoices("claude-desktop", {
      tools: true,
      skills: false,
      proxy: true,
      plugins: true,
    });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("clientId=claude-desktop") as ReturnType<
        typeof useSearchParams
      >,
    );
    mockOrganization({});
    render(<ConnectionPage />);
    expect(
      screen.getByRole("button", { name: /Claude Desktop/, pressed: true }),
    ).toBeVisible();
    expect(
      screen.getByText("Download the installer for Claude Desktop"),
    ).toBeVisible();
    expect(await screen.findByTestId("desktop-download")).toHaveAttribute(
      "data-exclude",
      "skills",
    );
  });

  it("re-reads the connection settings when the tab comes back", () => {
    mockOrganization({});
    render(<ConnectionPage />);
    refetchOrganizationMock.mockClear();
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refetchOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("holds the connect band while settings are re-read, but not the picker", () => {
    mockOrganization({ data: {}, isFetching: true });
    render(<ConnectionPage />);
    const band = screen.getByRole("region", { name: "Connect" });
    expect(band).toHaveAttribute("inert");
    const tile = screen.getByRole("button", { name: /Cursor/ });
    expect(tile.closest("[inert]")).toBeNull();
  });

  it("waits for the organization settings before offering agents", () => {
    mockOrganization({ data: undefined, isPending: true });
    render(<ConnectionPage />);
    expect(
      screen.queryByRole("heading", {
        name: "Connect your agent to Example Platform",
      }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Cursor/ })).toBeNull();
  });
});

describe("ConnectionPage (connect request approval)", () => {
  it("keeps connection settings off the approval page", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "connectRequest=request&clientId=cursor",
      ) as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: {},
      isFetchedAfterMount: true,
      isFetching: false,
      isError: false,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);

    render(<ConnectionPage />);

    expect(
      screen.getByRole("heading", {
        name: "Connect Cursor to Example Platform",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  it("opens setup directly for the requested client", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "connectRequest=request&clientId=codex",
      ) as ReturnType<typeof useSearchParams>,
    );
    mockOrganization({});
    render(<ConnectionPage />);
    expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();
    expect(connectionFlowMock).toHaveBeenCalled();
  });

  it("fails closed while a persisted enabled value is being revalidated", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        connectionSkillsEnabled: true,
        connectionLlmProxyEnabled: true,
        connectionPluginsEnabled: true,
      },
      isFetchedAfterMount: false,
      isFetching: true,
      isError: false,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);

    render(<ConnectionPage />);

    expect(useOrganization).toHaveBeenCalledWith(true, { fresh: true });
    expect(useLlmProxy).toHaveBeenCalledWith({ enabled: false });
    expect(connectionFlowMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("status", { name: "Checking connection settings" }),
    ).toBeInTheDocument();
  });

  it("keeps the flow visible during revalidation without dropping selections", () => {
    const query = {
      data: {
        connectionSkillsEnabled: true,
        connectionLlmProxyEnabled: true,
        connectionPluginsEnabled: true,
      },
      isFetchedAfterMount: true,
      isFetching: false,
      isError: false,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>;
    vi.mocked(useOrganization).mockReturnValue(query);
    const { rerender } = render(<ConnectionPage />);
    fireEvent.change(screen.getByLabelText("Selected gateway"), {
      target: { value: "Chosen gateway" },
    });

    vi.mocked(useOrganization).mockReturnValue({ ...query, isFetching: true });
    rerender(<ConnectionPage />);
    expect(screen.getByTestId("connection-flow")).toBeVisible();
    expect(
      screen.queryByRole("status", { name: "Checking connection settings" }),
    ).toBeNull();
    expect(connectionFlowMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        skillsEnabled: true,
        llmProxyEnabled: true,
        pluginsEnabled: true,
      }),
    );

    vi.mocked(useOrganization).mockReturnValue(query);
    rerender(<ConnectionPage />);
    expect(screen.getByTestId("connection-flow")).toBeVisible();
    expect(screen.getByLabelText("Selected gateway")).toHaveValue(
      "Chosen gateway",
    );
  });

  it("offers retry instead of a partial setup when settings cannot be verified", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        connectionSkillsEnabled: true,
        connectionLlmProxyEnabled: true,
        connectionPluginsEnabled: true,
      },
      isFetchedAfterMount: true,
      isFetching: false,
      isError: true,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);
    render(<ConnectionPage />);
    expect(connectionFlowMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes organization settings when the Connect tab visibility changes", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
      isFetchedAfterMount: true,
      isFetching: false,
      isError: false,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);

    render(<ConnectionPage />);
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(refetchOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed for plugins while preserving a non-plugin Connect flow", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        connectionSkillsEnabled: true,
        connectionLlmProxyEnabled: true,
        connectionPluginsEnabled: false,
      },
      isFetchedAfterMount: true,
      isFetching: false,
      isError: false,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);

    render(<ConnectionPage />);

    expect(connectionFlowMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ pluginsEnabled: false }),
    );
  });
});

describe("ConnectPage guardrails for members", () => {
  it("reads the guardrails status without organization settings access", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    mockOrganization({ data: { connectionShownClientIds: ["claude-code"] } });
    render(<ConnectionPage />);
    expect(useGuardrailsDeployment).toHaveBeenCalledWith({ anyMember: true });
  });
});

describe("ConnectPage plugins", () => {
  const plugin = (
    id: string,
    clientType: string,
    supportedPlatforms: string[],
  ) => ({
    id,
    displayName: `Plugin ${id}`,
    description: null,
    clientType,
    supportedPlatforms,
    enabled: true,
    contentHash: "h",
    approvedContentHash: "h",
  });

  function setup(clientId: string) {
    window.localStorage.clear();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useConfig).mockReturnValue({
      data: { features: { plugins: true } },
    } as unknown as ReturnType<typeof useConfig>);
    vi.mocked(usePlugins).mockReturnValue({
      data: [
        plugin("a", "claude-code", ["posix", "windows"]),
        plugin("b", "claude-code", ["windows"]),
        plugin("c", "codex", ["posix"]),
      ],
    } as unknown as ReturnType<typeof usePlugins>);
    mockOrganization({
      data: {
        connectionShownClientIds: [clientId],
        connectionPluginsEnabled: true,
      },
    });
    render(<ConnectionPage />);
  }

  it("lists the agent's plugins for this computer's OS", () => {
    setup("claude-code");
    expect(screen.getByText("+1 plugin")).toBeVisible();
    expect(screen.getByText("Plugin a")).toBeVisible();
    expect(screen.queryByText("Plugin b")).toBeNull();
  });

  it("leaves plugins out of the command when switched off", async () => {
    setup("claude-code");
    await userEvent.click(
      screen.getByRole("button", { name: "Choose what to include" }),
    );
    await userEvent.click(screen.getByRole("switch", { name: /Plugins/ }));
    expect(screen.getByText("Plugins off")).toBeVisible();
    expect(
      screen.getByText(/--client claude-code --exclude plugins$/),
    ).toBeVisible();
  });

  it("shows no plugins for an agent without any", () => {
    setup("cursor");
    expect(screen.queryByText(/plugin/i)).toBeNull();
  });
});

describe("ConnectPage Amp", () => {
  it("offers Amp with the LLM proxy not supported", () => {
    window.localStorage.clear();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("clientId=amp") as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useLlmProxy).mockReturnValue({
      data: { id: "proxy-1" },
    } as unknown as ReturnType<typeof useLlmProxy>);
    vi.mocked(useGuardrailsDeployment).mockReturnValue({
      data: {
        active: true,
        enabled: true,
        featureEnabled: true,
        unsupportedClientAction: "block",
      },
    } as ReturnType<typeof useGuardrailsDeployment>);
    mockOrganization({
      data: {
        connectionShownClientIds: ["amp"],
        connectionLlmProxyEnabled: true,
      },
    });
    render(<ConnectionPage />);
    const chip = screen
      .getByRole("button", { name: "What the LLM proxy does" })
      .closest("[data-status-chip]");
    expect(chip).toHaveTextContent("Not supported");
    // The proxy never sees Amp, so the block setting can't apply to it.
    const guard = screen
      .getByRole("button", { name: "What the guardrails do" })
      .closest("[data-status-chip]");
    expect(guard).toHaveTextContent("Not enforced");
  });
});

describe("ConnectPage loading", () => {
  it("waits for the default gateway instead of rendering twice", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useDefaultMcpGateway).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as ReturnType<typeof useDefaultMcpGateway>);
    mockOrganization({ data: { connectionShownClientIds: ["claude-code"] } });
    render(<ConnectionPage />);
    expect(
      screen.queryByRole("heading", { name: /Connect your agent/ }),
    ).toBeNull();
  });
});

describe("ConnectPage after copying the command", () => {
  const welcome =
    "Read http://localhost:3000/welcome.md and show me what I can do with Example Platform.";

  beforeEach(() => {
    window.localStorage.clear();
  });

  function show(clientIds: string[], query = "") {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(query) as ReturnType<typeof useSearchParams>,
    );
    // A gateway, so other agents' prompt has something to set up.
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useProfile).mockReturnValue({
      data: { id: "gw-1", name: "Team gateway", slug: "team", tools: [] },
      isPending: false,
    } as unknown as ReturnType<typeof useProfile>);
    mockOrganization({
      data: {
        connectionShownClientIds: clientIds,
        connectionDefaultMcpGatewayId: "gw-1",
      },
    });
    render(<ConnectionPage />);
  }

  const copyCommand = () =>
    userEvent.click(screen.getByRole("button", { name: /^(Copy|Copied)$/ }));
  const status = () =>
    screen.queryByRole("region", { name: "Connection status" });
  const approveElsewhere = async () => {
    postConnected();
    await screen.findByText(/^Connected\./);
  };

  it("waits for approval once the command is copied, then offers the welcome prompt", async () => {
    show(["cursor"]);
    expect(status()).toBeNull();
    await copyCommand();
    expect(status()).toHaveTextContent(
      "Waiting for approvalThe command opens a browser page. Approve there and this card moves on by itself.",
    );

    await approveElsewhere();
    expect(status()).toHaveTextContent(
      "Connected. Next, ask Cursor what it can do now",
    );
    expect(status()).toHaveTextContent(
      "Once your terminal says setup is done, paste this into a new Cursor session.",
    );
    expect(screen.getByText(welcome)).toBeVisible();
    // The connect band steps back.
    expect(screen.getByRole("region", { name: "Connect" })).toHaveClass(
      "opacity-50",
    );
    // Copying the welcome prompt doesn't start waiting again.
    await userEvent.click(
      within(status() as HTMLElement).getByRole("button", {
        name: "Copy prompt",
      }),
    );
    expect(status()).toHaveTextContent("Connected.");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(status()).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show the starter prompt" }),
    ).toBeVisible();
  });

  it("starts waiting when the command text is copied by hand", () => {
    show(["cursor"]);
    fireEvent.copy(screen.getByText(/--client cursor$/));
    expect(status()).toHaveTextContent("Waiting for approval");
  });

  it("moves on with Done, and goes back to the link on Cancel", async () => {
    show(["cursor"]);
    await copyCommand();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(status()).toBeNull();

    await copyCommand();
    await userEvent.click(
      screen.getByRole("button", { name: "Done? Show the next step" }),
    );
    expect(status()).toHaveTextContent("Connected.");
  });

  it("stops waiting when the agent changes, but keeps a connection it saw", async () => {
    show(["cursor", "codex"]);
    await copyCommand();
    await userEvent.click(screen.getByRole("button", { name: /Codex/ }));
    expect(status()).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Cursor/ }));
    await copyCommand();
    await approveElsewhere();
    await userEvent.click(screen.getByRole("button", { name: /Codex/ }));
    expect(status()).toHaveTextContent(
      "Connected. Next, ask Cursor what it can do now",
    );
  });

  it("shows the starter prompt from the link", async () => {
    show(["generic"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Show the starter prompt" }),
    );
    const card = screen.getByRole("region", { name: "Starter prompt" });
    expect(card).toHaveTextContent(
      "Works once your agent is connected. If it isn't yet, it points you back to the Connect page.",
    );
    expect(within(card).getByText(welcome)).toBeVisible();
    await userEvent.click(within(card).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Starter prompt" })).toBeNull();
  });

  it("offers the starter prompt in manual setup, but not for n8n", () => {
    show(["generic"]);
    expect(
      screen.getByRole("button", { name: "Show the starter prompt" }),
    ).toBeVisible();
    cleanup();
    show(["n8n"]);
    expect(
      screen.queryByRole("button", { name: "Show the starter prompt" }),
    ).toBeNull();
  });
});
