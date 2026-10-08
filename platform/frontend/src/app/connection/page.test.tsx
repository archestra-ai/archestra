import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchParams } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDefaultMcpGateway,
  useProfile,
  useProfiles,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useConfig } from "@/lib/config/config.query";
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
vi.mock("@/lib/mcp/internal-mcp-catalog.query");
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

  it("carries what the user left out in the installer prompt", () => {
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
      screen.getByText(
        /connect\.md\?client=cursor&exclude=skills,plugins and connect Cursor\./,
      ),
    ).toBeVisible();
  });

  it("switches the LLM proxy on for supported agents, not active when the admin turned it off", () => {
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
    expect(screen.getByRole("switch", { name: "LLM proxy" })).toBeChecked();
    unmount();

    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("clientId=hermes-agent") as ReturnType<
        typeof useSearchParams
      >,
    );
    const other = render(<ConnectionPage />);
    expect(screen.getByRole("switch", { name: "LLM proxy" })).toBeChecked();
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
      const proxy = screen.getByRole("switch", { name: /LLM proxy/ });
      await userEvent.click(proxy);
      expect(proxy).not.toBeChecked();
      // Other agents' prompt is covered by the generic prompt tests.
      if (id === "claude-code")
        expect(
          screen.getByText(/connect\.md\?client=claude-code&exclude=proxy/),
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
        connectionShownClientIds: ["generic"],
        connectionDefaultMcpGatewayId: "gw-1",
      },
    });
    render(<ConnectionPage />);
    expect(
      screen.getByText(
        /connect\.md\?client=generic&gateway=team&exclude=skills,proxy(&base=[^ ]+)? and connect /,
      ),
    ).toBeVisible();
  });

  it("opens a linked agent on its manual setup", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("clientId=generic&mode=manual") as ReturnType<
        typeof useSearchParams
      >,
    );
    mockOrganization({});
    render(<ConnectionPage />);
    expect(
      screen.getByRole("button", { name: "Manual setup", pressed: true }),
    ).toBeVisible();
    expect(screen.getByText("Follow the steps for your agent")).toBeVisible();
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

  it("leaves plugins out of the prompt when switched off", async () => {
    setup("claude-code");
    await userEvent.click(screen.getByRole("switch", { name: /Plugins/ }));
    expect(screen.getByText("Plugins off")).toBeVisible();
    expect(
      screen.getByText(
        /connect\.md\?client=claude-code&exclude=plugins and connect Claude Code\./,
      ),
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
