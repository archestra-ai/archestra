import { DocsPage, getDocsUrl } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePublicIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { usePublicEnterpriseCoreActive } from "@/lib/config/config.query";
import { SsoSetupNote } from "./sso-setup-note";

vi.mock("@/lib/auth/identity-provider-read.query", () => ({
  usePublicIdentityProviders: vi.fn(),
}));

vi.mock("@/lib/config/config.query", () => ({
  usePublicEnterpriseCoreActive: vi.fn(),
}));

describe("SsoSetupNote", () => {
  beforeEach(() => {
    vi.mocked(usePublicIdentityProviders).mockReturnValue({
      data: undefined,
      isSuccess: false,
    } as unknown as ReturnType<typeof usePublicIdentityProviders>);
  });

  it("points to the SSO setup docs when the Enterprise core is off", () => {
    vi.mocked(usePublicEnterpriseCoreActive).mockReturnValue(false);

    render(<SsoSetupNote />);

    expect(screen.getByText("Single sign-on")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Set up SSO/ })).toHaveAttribute(
      "href",
      getDocsUrl(DocsPage.PlatformEnterpriseManagedAuth),
    );
  });

  it("shows when the Enterprise core is on but no provider is configured", () => {
    vi.mocked(usePublicEnterpriseCoreActive).mockReturnValue(true);
    mockProviders([]);

    render(<SsoSetupNote />);

    expect(screen.getByText("Single sign-on")).toBeInTheDocument();
  });

  it("hides once an identity provider is configured", () => {
    vi.mocked(usePublicEnterpriseCoreActive).mockReturnValue(true);
    mockProviders([{ id: "okta", providerId: "okta" }]);

    render(<SsoSetupNote />);

    expect(screen.queryByText("Single sign-on")).not.toBeInTheDocument();
  });

  it("stays hidden while the providers are still loading", () => {
    vi.mocked(usePublicEnterpriseCoreActive).mockReturnValue(true);

    render(<SsoSetupNote />);

    expect(screen.queryByText("Single sign-on")).not.toBeInTheDocument();
  });

  it("stays hidden while the public config is still loading", () => {
    vi.mocked(usePublicEnterpriseCoreActive).mockReturnValue(undefined);

    render(<SsoSetupNote />);

    expect(screen.queryByText("Single sign-on")).not.toBeInTheDocument();
  });
});

function mockProviders(providers: Array<{ id: string; providerId: string }>) {
  vi.mocked(usePublicIdentityProviders).mockReturnValue({
    data: providers,
    isSuccess: true,
  } as unknown as ReturnType<typeof usePublicIdentityProviders>);
}
