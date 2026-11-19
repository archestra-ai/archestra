import { DocsPage, getDocsUrl } from "@archestra/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDefaultCredentialsEnabled } from "@/lib/auth/auth.query";
import { usePublicIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { usePublicEnterpriseCoreActive } from "@/lib/config/config.query";
import { SignInNotice } from "./sign-in-notice";

const mockConfig = vi.hoisted(() => ({
  enterpriseFeatures: { fullWhiteLabeling: false },
}));

vi.mock("@/lib/config/config", () => ({ default: mockConfig }));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useDefaultCredentialsEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/identity-provider-read.query", () => ({
  usePublicIdentityProviders: vi.fn(),
}));

vi.mock("@/lib/config/config.query", () => ({
  usePublicEnterpriseCoreActive: vi.fn(),
}));

const CREDENTIALS_DOCS = getDocsUrl(
  DocsPage.PlatformDeploymentConfiguration,
  "authentication",
);
const SSO_DOCS = getDocsUrl(DocsPage.PlatformEnterpriseManagedAuth);

describe("SignInNotice", () => {
  beforeEach(() => {
    mockConfig.enterpriseFeatures.fullWhiteLabeling = false;
    vi.mocked(usePublicEnterpriseCoreActive).mockReturnValue(true);
    mockDefaultCredentials(true);
    mockIdentityProviders([]);
  });

  it("shows the default credentials and both ways forward when no identity provider is set up", () => {
    render(<SignInNotice />);

    const notice = screen.getByRole("note");
    expect(notice).toHaveTextContent("Default Credentials");
    expect(notice).toHaveTextContent("admin@example.com");
    expect(screen.getByRole("link", { name: /change them/ })).toHaveAttribute(
      "href",
      CREDENTIALS_DOCS,
    );
    expect(screen.getByRole("link", { name: /set up SSO/ })).toHaveAttribute(
      "href",
      SSO_DOCS,
    );
  });

  it("confirms a copy without adding text that would push the sentence along", async () => {
    render(<SignInNotice />);
    const notice = screen.getByRole("note");
    const textBefore = notice.textContent;

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /Copy/ })[0]);
    });

    expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();
    expect(notice.textContent?.replace("Copied!", "Copy to clipboard")).toBe(
      textBefore,
    );
  });

  it("drops the SSO wording once an identity provider is set up", () => {
    mockIdentityProviders([{ id: "okta", providerId: "okta" }]);

    render(<SignInNotice />);

    const notice = screen.getByRole("note");
    expect(notice).toHaveTextContent("Default Credentials");
    expect(notice).not.toHaveTextContent(/SSO/);
    expect(
      screen.getByRole("link", { name: /Check the documentation/ }),
    ).toHaveAttribute("href", CREDENTIALS_DOCS);
  });

  it("keeps the same box for SSO alone once the default credentials are changed", () => {
    mockDefaultCredentials(false);

    render(<SignInNotice />);

    const notice = screen.getByRole("note");
    expect(notice).toHaveTextContent("Single Sign-On");
    expect(notice).not.toHaveTextContent("admin@example.com");
    expect(
      screen.getByRole("link", { name: /Check the documentation/ }),
    ).toHaveAttribute("href", SSO_DOCS);
  });

  it("offers SSO when the Enterprise core is off, where no provider can exist", () => {
    mockDefaultCredentials(false);
    vi.mocked(usePublicEnterpriseCoreActive).mockReturnValue(false);
    mockIdentityProviders(undefined);

    render(<SignInNotice />);

    expect(screen.getByRole("note")).toHaveTextContent("Single Sign-On");
  });

  it("renders nothing with changed credentials and an identity provider", () => {
    mockDefaultCredentials(false);
    mockIdentityProviders([{ id: "okta", providerId: "okta" }]);

    render(<SignInNotice />);

    expect(screen.queryByRole("note")).toBeNull();
  });

  it("waits for the providers instead of changing its wording when they answer", () => {
    mockIdentityProviders(undefined);

    render(<SignInNotice />);

    expect(screen.queryByRole("note")).toBeNull();
  });

  it("still says what to do when white-labeling hides the docs links", () => {
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;

    render(<SignInNotice />);

    expect(screen.queryByRole("link")).toBeNull();
    const notice = screen.getByRole("note");
    expect(notice).toHaveTextContent(
      "Set the admin credential environment variables to change them.",
    );
    expect(notice).toHaveTextContent(
      "Admins can set up SSO in Settings → Identity Providers.",
    );
  });
});

function mockDefaultCredentials(enabled: boolean) {
  vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
    data: enabled,
    isPending: false,
  } as unknown as ReturnType<typeof useDefaultCredentialsEnabled>);
}

/** `undefined` leaves the query pending (or disabled, without Enterprise). */
function mockIdentityProviders(
  providers: Array<{ id: string; providerId: string }> | undefined,
) {
  vi.mocked(usePublicIdentityProviders).mockReturnValue({
    data: providers,
    isSuccess: providers !== undefined,
    isPending: providers === undefined,
  } as unknown as ReturnType<typeof usePublicIdentityProviders>);
}
