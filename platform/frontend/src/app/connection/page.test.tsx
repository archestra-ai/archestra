import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
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
      tools: true,
      skills: false,
      proxy: true,
      plugins: false,
    });
    mockOrganization({ data: { connectionShownClientIds: ["cursor"] } });
    render(<ConnectionPage />);
    expect(
      screen.getByText(
        /connect\.md\?client=cursor&exclude=skills,plugins and connect Cursor\./,
      ),
    ).toBeVisible();
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
        /connect\.md\?client=generic&gateway=team&setup=tools(&base=[^ ]+)? and connect /,
      ),
    ).toBeVisible();
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
