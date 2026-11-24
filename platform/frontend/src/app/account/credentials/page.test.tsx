import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCredentialsPage } from "@/app/_parts/use-credentials-page";
import AccountLayout from "@/app/account/layout";
import { useHasPermissions } from "@/lib/auth/auth.query";
import AccountCredentialsPage from "./page";

vi.mock("next/navigation");
vi.mock("@/app/_parts/use-credentials-page", () => ({
  useCredentialsPage: vi.fn(),
}));
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
// The shared table has its own tests; here it only matters whether it renders.
vi.mock("@/components/settings/runtime-credentials-section", () => ({
  RuntimeCredentialsSection: () => <div>Credentials table</div>,
}));

const replace = vi.fn();

function setUp(params: {
  canReadCredentials: boolean;
  /** The reader's one Credentials page; Settings for admins and editors. */
  credentialsPage?: "/settings/credentials" | "/account/credentials";
}) {
  vi.mocked(useCredentialsPage).mockReturnValue({
    href: params.credentialsPage ?? "/account/credentials",
  });
  vi.mocked(useHasPermissions).mockReturnValue({
    data: params.canReadCredentials,
  } as ReturnType<typeof useHasPermissions>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ replace } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(usePathname).mockReturnValue("/account/credentials");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
});

describe("Personal Settings → Credentials", () => {
  it("lists credentials for a reader with credential:read", () => {
    setUp({ canReadCredentials: true });
    render(<AccountCredentialsPage />);

    expect(screen.getByText("Credentials table")).toBeVisible();
  });

  it("sends a reader without credential:read back to Account and drops the tab", () => {
    setUp({ canReadCredentials: false });
    render(<AccountCredentialsPage />);
    expect(replace).toHaveBeenCalledWith("/account");

    render(
      <QueryClientProvider client={new QueryClient()}>
        <AccountLayout>
          <div />
        </AccountLayout>
      </QueryClientProvider>,
    );
    expect(
      screen.getAllByRole("link", { name: "API Keys" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryAllByRole("link", { name: "Credentials" })).toEqual([]);
  });

  it("sends a reader who can open Settings → Credentials there, keeping the query, and drops the tab", () => {
    setUp({
      canReadCredentials: true,
      credentialsPage: "/settings/credentials",
    });
    window.history.replaceState(
      null,
      "",
      "/account/credentials?github=connected",
    );
    render(<AccountCredentialsPage />);
    expect(replace).toHaveBeenCalledWith(
      "/settings/credentials?github=connected",
    );
    expect(screen.queryByText("Credentials table")).not.toBeInTheDocument();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <AccountLayout>
          <div />
        </AccountLayout>
      </QueryClientProvider>,
    );
    expect(screen.queryAllByRole("link", { name: "Credentials" })).toEqual([]);
  });

  it("keeps the tab for a reader whose Credentials page is Personal Settings", () => {
    setUp({ canReadCredentials: true });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AccountLayout>
          <AccountCredentialsPage />
        </AccountLayout>
      </QueryClientProvider>,
    );
    expect(
      screen.getAllByRole("link", { name: "Credentials" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Credentials table")).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });
});
