import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stable, mutable stand-in for the router's search params so a test can flip
// them (e.g. simulate the deep-link param being stripped) between renders.
const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => nav.search,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/mcp/registry",
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query");
vi.mock("@/lib/mcp/mcp-server.query");
vi.mock("@/lib/auth/oauth.query");
vi.mock("@/lib/mcp/enterprise-managed-install-auth", () => ({
  useEnterpriseManagedInstallConnectUrl: () => async () => null,
  getPendingEnterpriseManagedInstall: () => null,
  setPendingEnterpriseManagedInstall: vi.fn(),
  clearPendingEnterpriseManagedInstall: vi.fn(),
}));
vi.mock("@/lib/websocket/websocket", () => ({ default: { send: vi.fn() } }));

// The install dialogs are stubbed to a single testid so the test asserts the
// hook's open/re-open/clear behavior, not each dialog's internals. Every
// variant collapses to the same "install-dialog" marker plus a dismiss button
// wired to the close/cancel handler.
type StubDialogProps = {
  open?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
  onCancel?: () => void;
  onOpenChange?: (open: boolean) => void;
};
function StubDialog({
  open,
  isOpen,
  onClose,
  onCancel,
  onOpenChange,
}: StubDialogProps) {
  if (!(open || isOpen)) return null;
  const dismiss = onCancel ?? onClose ?? (() => onOpenChange?.(false));
  return (
    <div data-testid="install-dialog">
      <button
        type="button"
        data-testid="install-dialog-dismiss"
        onClick={dismiss}
      >
        dismiss
      </button>
    </div>
  );
}
vi.mock("@/components/oauth-confirmation-dialog", () => ({
  OAuthConfirmationDialog: (props: StubDialogProps) => (
    <StubDialog {...props} />
  ),
}));
vi.mock("./remote-server-install-dialog", () => ({
  RemoteServerInstallDialog: (props: StubDialogProps) => (
    <StubDialog {...props} />
  ),
}));
vi.mock("./no-auth-install-dialog", () => ({
  NoAuthInstallDialog: (props: StubDialogProps) => <StubDialog {...props} />,
}));
vi.mock("./local-server-install-dialog", () => ({
  LocalServerInstallDialog: (props: StubDialogProps) => (
    <StubDialog {...props} />
  ),
}));

import { useInitiateOAuth } from "@/lib/auth/oauth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useInstallMcpServer, useMcpServers } from "@/lib/mcp/mcp-server.query";
import {
  clearPendingInstall,
  setPendingInstall,
} from "@/lib/mcp/pending-install";
import type { CatalogItem } from "./mcp-server-card";
import { useCatalogInstall } from "./use-catalog-install";

const CATALOG_ID = "cat-oauth-1";

// A remote server with an OAuth config and no user config — installRemote takes
// the OAuth-dialog branch, so the deep link opens a dialog we can observe.
const oauthItem = {
  id: CATALOG_ID,
  name: "deeplink-server",
  serverType: "remote",
  oauthConfig: { name: "deeplink-server" },
  userConfig: {},
} as unknown as CatalogItem;

// Mirrors how InternalMCPCatalog drives the deep link: fire the consume-params
// handler on mount. The durable re-open lives inside the hook itself.
function Harness() {
  const install = useCatalogInstall();
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once on mount, like the registry effect
  useEffect(() => {
    install.installFromSearchParams();
  }, []);
  return <>{install.dialogs}</>;
}

function renderHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("useCatalogInstall — deep-link install", () => {
  beforeEach(() => {
    sessionStorage.clear();
    nav.search = new URLSearchParams();
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [oauthItem],
    } as unknown as ReturnType<typeof useInternalMcpCatalog>);
    vi.mocked(useMcpServers).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useMcpServers>);
    vi.mocked(useInstallMcpServer).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useInstallMcpServer>);
    vi.mocked(useInitiateOAuth).mockReturnValue({
      mutateAsync: vi.fn(),
    } as unknown as ReturnType<typeof useInitiateOAuth>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens the install dialog when ?install={catalogId} is present", async () => {
    nav.search = new URLSearchParams(`install=${CATALOG_ID}`);

    renderHarness();

    expect(await screen.findByTestId("install-dialog")).toBeInTheDocument();
  });

  // The regression guard: the deep link opened the dialog and the param was
  // stripped, then the dialog was torn down (a route re-render remounting the
  // registry, an OAuth/enterprise redirect return, etc.). A fresh mount — with
  // the param already gone — must re-open the dialog from the stashed intent
  // rather than strand the user on the bare registry.
  it("re-opens the dialog after a teardown while the connection is still missing", async () => {
    nav.search = new URLSearchParams(`install=${CATALOG_ID}`);
    const view = renderHarness();
    await screen.findByTestId("install-dialog");

    // The param is stripped after the deep link is consumed; simulate that plus
    // the teardown that lost the dialog in the bug.
    nav.search = new URLSearchParams();
    view.unmount();
    expect(screen.queryByTestId("install-dialog")).not.toBeInTheDocument();

    // Fresh mount: local dialog state is reset and the URL no longer carries the
    // param, so only the durable intent can bring the dialog back.
    renderHarness();
    expect(await screen.findByTestId("install-dialog")).toBeInTheDocument();
  });

  it("does not re-open after the user dismisses the dialog", async () => {
    const user = userEvent.setup();
    nav.search = new URLSearchParams(`install=${CATALOG_ID}`);
    const view = renderHarness();

    await user.click(await screen.findByTestId("install-dialog-dismiss"));

    // Dismiss dropped the intent; a later teardown/remount must not resurrect it.
    nav.search = new URLSearchParams();
    view.unmount();
    renderHarness();
    await Promise.resolve();
    expect(screen.queryByTestId("install-dialog")).not.toBeInTheDocument();
  });

  it("does not re-open when the caller already has a connection", async () => {
    // The deep link ran earlier (intent stashed), but a connection now exists.
    setPendingInstall({ catalogId: CATALOG_ID });
    vi.mocked(useMcpServers).mockReturnValue({
      data: [{ catalogId: CATALOG_ID }],
    } as unknown as ReturnType<typeof useMcpServers>);
    nav.search = new URLSearchParams();

    renderHarness();
    await Promise.resolve();

    expect(screen.queryByTestId("install-dialog")).not.toBeInTheDocument();
    clearPendingInstall();
  });
});
