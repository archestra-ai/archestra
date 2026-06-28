import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hasPermissionsMock = vi.fn();

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => hasPermissionsMock(),
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

vi.mock("@/components/copyable-code", () => ({
  CopyableCode: ({
    children,
    value,
  }: {
    children: ReactNode;
    value: string;
  }) => (
    <div data-testid="copyable" data-value={value}>
      {children}
    </div>
  ),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { TestSetupStep } from "./test-setup-link";

describe("TestSetupStep", () => {
  beforeEach(() => {
    hasPermissionsMock.mockReset();
  });

  it("always shows the copyable sample message, regardless of logs access", () => {
    hasPermissionsMock.mockReturnValue({ data: false });
    render(<TestSetupStep />);
    expect(screen.getByTestId("connect-sample-message")).toBeInTheDocument();
  });

  it("hides the 'Test your setup' link for users without logs access", () => {
    hasPermissionsMock.mockReturnValue({ data: false });
    render(<TestSetupStep />);
    expect(screen.getByTestId("connect-sample-message")).toBeInTheDocument();
    expect(
      screen.queryByTestId("connect-test-setup-link"),
    ).not.toBeInTheDocument();
  });

  it("shows the 'Test your setup' link for users with logs access", () => {
    hasPermissionsMock.mockReturnValue({ data: true });
    render(<TestSetupStep />);
    expect(screen.getByTestId("connect-test-setup-link")).toBeInTheDocument();
  });
});
