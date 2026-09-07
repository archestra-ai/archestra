import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseSession, mockUseDefaultCredentialsEnabled } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockUseDefaultCredentialsEnabled: vi.fn(),
}));

const mockConfig = {
  enterpriseFeatures: {
    fullWhiteLabeling: false,
  },
};

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/lib/config/config", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop in mockConfig
          ? mockConfig[prop as keyof typeof mockConfig]
          : undefined,
    },
  ),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => mockUseSession(),
  useDefaultCredentialsEnabled: () => mockUseDefaultCredentialsEnabled(),
}));

import { DefaultCredentialsWarning } from "./default-credentials-warning";

describe("DefaultCredentialsWarning", () => {
  beforeEach(() => {
    mockConfig.enterpriseFeatures.fullWhiteLabeling = false;
    mockUseSession.mockReturnValue({ data: null });
    mockUseDefaultCredentialsEnabled.mockReturnValue({
      data: true,
      isLoading: false,
    });
  });

  it("tells an operator how to change the credentials", () => {
    render(<DefaultCredentialsWarning alwaysShow />);

    expect(screen.getByRole("link", { name: /Set ENV/ })).toBeInTheDocument();
    // The link carries an sr-only "(opens in new tab)", so the visible phrase
    // is split across nodes rather than contiguous.
    expect(screen.getByRole("alert")).toHaveTextContent(/Set ENV.*to change/);
  });

  it("still says what to do when white-labeling hides the docs link", () => {
    // The instruction used to live entirely in the link — "Set ENV" was the
    // verb — so hiding it left the warning reading "to change" and nothing
    // else. Whatever replaces the link has to carry the instruction itself.
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;

    render(<DefaultCredentialsWarning alwaysShow />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Set the admin credential environment variables to change",
    );
  });

  it("points a signed-in admin at their account page instead of the docs", () => {
    // No docs link and a session to act on: the account page is the whole
    // instruction, so it must not arrive as a dangling "or Change".
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;
    mockUseSession.mockReturnValue({
      data: { user: { email: "admin@example.com" } },
    });

    render(<DefaultCredentialsWarning />);

    const link = screen.getByRole("link", { name: "Change password" });
    expect(link).toHaveAttribute("href", "/account?highlight=change-password");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/\bor\s*$/);
  });

  it("keeps the slim badge readable without its link", () => {
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;
    mockUseSession.mockReturnValue({
      data: { user: { email: "admin@example.com" } },
    });

    const { container } = render(<DefaultCredentialsWarning slim />);

    // The separator existed only to introduce the link, so it goes with it.
    expect(container).toHaveTextContent("Default credentials in use");
    expect(container).not.toHaveTextContent("-");
  });
});
