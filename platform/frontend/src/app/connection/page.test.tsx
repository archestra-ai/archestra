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
vi.mock("@/lib/plugins/plugin.query");
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
  function setup(
    clientId: string,
    deployment: {
      active: boolean;
      unsupportedClientAction: "bypass" | "block";
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
      data: { ...deployment, enabled: deployment.active, featureEnabled: true },
    } as ReturnType<typeof useGuardrailsDeployment>);
    mockOrganization({
      data: {
        connectionShownClientIds: [clientId],
        connectionLlmProxyEnabled: true,
      },
    });
    render(<ConnectionPage />);
    return screen.getByRole("button", { name: /guardrails/ });
  }

  it("says the guardrails are off when the deployment is off", () => {
    expect(
      setup("claude-code", { active: false, unsupportedClientAction: "block" }),
    ).toHaveTextContent("Off");
  });

  it("is active for an agent the guardrails support", () => {
    expect(
      setup("claude-code", { active: true, unsupportedClientAction: "block" }),
    ).toHaveTextContent("Active");
  });

  it("says an unsupported agent passes through unchecked", () => {
    expect(
      setup("cursor", { active: true, unsupportedClientAction: "bypass" }),
    ).toHaveTextContent("Passes through unchecked");
  });

  it("says an unsupported agent is blocked", () => {
    expect(
      setup("cursor", { active: true, unsupportedClientAction: "block" }),
    ).toHaveTextContent("Blocks this agent");
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
    const link = screen.queryByRole("link", { name: "Connection settings" });
    if (allowed) {
      expect(link).toHaveAttribute("href", "/settings/connection");
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
    // Tools and plugins are always included, whatever was saved.
    expect(
      screen.getByText(
        /connect\.md\?client=cursor&exclude=skills and connect Cursor\./,
      ),
    ).toBeVisible();
  });

  it("turns model routing off from the profile card", async () => {
    window.localStorage.clear();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useLlmProxy).mockReturnValue({
      data: { id: "proxy-1" },
    } as unknown as ReturnType<typeof useLlmProxy>);
    mockOrganization({
      data: {
        connectionShownClientIds: ["cursor"],
        connectionLlmProxyEnabled: true,
      },
    });
    render(<ConnectionPage />);

    await userEvent.click(
      screen.getByRole("switch", { name: "Model routing" }),
    );

    expect(
      screen.getByText(/connect\.md\?client=cursor&exclude=proxy/),
    ).toBeVisible();
    expect(screen.getByText("Off for this agent")).toBeVisible();
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
      screen.queryByRole("link", { name: "Connection settings" }),
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
