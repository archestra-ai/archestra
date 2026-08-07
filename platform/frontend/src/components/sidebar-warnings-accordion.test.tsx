import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  useDefaultCredentialsEnabled,
  useHasPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import { useDisableBasicAuth } from "@/lib/config/config.query";
import { useK8sCapabilities } from "@/lib/environment.query";
import { SidebarWarningsAccordion } from "./sidebar-warnings-accordion";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/environment.query", () => ({
  useK8sCapabilities: vi.fn(),
}));

type EnforcementStatus =
  | "verified-enforced"
  | "verified-not-enforced"
  | "unknown";

function setup({
  enforcementStatus,
  canUpdateEnvironment = true,
}: {
  enforcementStatus?: EnforcementStatus;
  canUpdateEnvironment?: boolean;
}) {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions: Record<string, unknown>) =>
      ({
        data: "environment" in permissions ? canUpdateEnvironment : false,
      }) as ReturnType<typeof useHasPermissions>,
  );
  // Kept off so the network policy warning is the only one under test.
  vi.mocked(useSession).mockReturnValue({
    data: { user: { email: "someone@example.org" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
    data: false,
    isLoading: false,
  } as ReturnType<typeof useDefaultCredentialsEnabled>);
  vi.mocked(useDisableBasicAuth).mockReturnValue(true);

  vi.mocked(useK8sCapabilities).mockReturnValue({
    data: enforcementStatus
      ? { networkPolicy: { enforcementStatus } }
      : undefined,
  } as ReturnType<typeof useK8sCapabilities>);

  return render(
    <SidebarProvider>
      <SidebarWarningsAccordion />
    </SidebarProvider>,
  );
}

describe("SidebarWarningsAccordion network policy warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom ships no matchMedia, which SidebarProvider needs to decide mobile.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })),
    );
  });

  it("warns when a probe measured the cluster as not enforcing", () => {
    setup({ enforcementStatus: "verified-not-enforced" });

    expect(screen.getByText("Network policy not enforced")).toBeVisible();
  });

  it("stays silent when a probe measured the cluster as enforcing", () => {
    setup({ enforcementStatus: "verified-enforced" });

    expect(screen.queryByText("Network policy not enforced")).toBeNull();
  });

  // Nothing tested the cluster, which is not evidence that egress rules are
  // inert — warning here would nag every deployment without a probe result.
  it("stays silent when enforcement was never measured", () => {
    setup({ enforcementStatus: "unknown" });

    expect(screen.queryByText("Network policy not enforced")).toBeNull();
  });

  it("stays silent while capabilities are still loading", () => {
    setup({});

    expect(screen.queryByText("Network policy not enforced")).toBeNull();
  });

  // This renders in the layout, so throwing on an unexpected payload blanks
  // every page rather than one component.
  it("survives a response without the network policy section", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { email: "someone@example.org" } },
    } as ReturnType<typeof useSession>);
    vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
      data: false,
      isLoading: false,
    } as ReturnType<typeof useDefaultCredentialsEnabled>);
    vi.mocked(useDisableBasicAuth).mockReturnValue(true);
    vi.mocked(useK8sCapabilities).mockReturnValue({
      data: { error: { message: "Unauthenticated" } },
    } as unknown as ReturnType<typeof useK8sCapabilities>);

    expect(() =>
      render(
        <SidebarProvider>
          <SidebarWarningsAccordion />
        </SidebarProvider>,
      ),
    ).not.toThrow();
    expect(screen.queryByText("Network policy not enforced")).toBeNull();
  });

  // Reading capabilities needs environment:update; without it the query is
  // disabled and returns nothing rather than 403-ing on every page.
  it("does not query capabilities without environment update permission", () => {
    setup({ canUpdateEnvironment: false });

    expect(vi.mocked(useK8sCapabilities)).toHaveBeenCalledWith(false);
  });

  it("links to the network egress policies docs in a new tab", () => {
    setup({ enforcementStatus: "verified-not-enforced" });

    const link = screen.getByRole("link", {
      name: /Network policy not enforced/,
    });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("platform-environments#network-egress-policies"),
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});
