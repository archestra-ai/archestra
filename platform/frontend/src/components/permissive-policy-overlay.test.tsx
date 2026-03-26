import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseFeature = vi.fn();
const mockUseHasPermissions = vi.fn();

vi.mock("@/lib/config/config.query", () => ({
  useFeature: (...args: unknown[]) => mockUseFeature(...args),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: (...args: unknown[]) => mockUseHasPermissions(...args),
}));

import { PermissivePolicyOverlay } from "./permissive-policy-overlay";

describe("PermissivePolicyOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFeature.mockReturnValue("restrictive");
    mockUseHasPermissions.mockReturnValue({ data: false });
  });

  it("renders children without the warning overlay for read-only users", () => {
    mockUseFeature.mockReturnValue("permissive");
    mockUseHasPermissions.mockReturnValue({ data: false });

    render(
      <PermissivePolicyOverlay>
        <div>Assigned tools</div>
      </PermissivePolicyOverlay>,
    );

    expect(screen.getByText("Assigned tools")).toBeInTheDocument();
    expect(
      screen.queryByText("Agentic Security Will Be Configured Here"),
    ).not.toBeInTheDocument();
  });

  it("shows the warning overlay for users who can update agent settings", () => {
    mockUseFeature.mockReturnValue("permissive");
    mockUseHasPermissions.mockReturnValue({ data: true });

    render(
      <PermissivePolicyOverlay>
        <div>Assigned tools</div>
      </PermissivePolicyOverlay>,
    );

    expect(
      screen.getByText("Agentic Security Will Be Configured Here"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Agent Settings" }),
    ).toHaveAttribute("href", "/settings/agents");
  });
});
