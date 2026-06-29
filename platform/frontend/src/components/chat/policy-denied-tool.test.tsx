import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyDeniedTool } from "./policy-denied-tool";

const mockUseHasPermissions = vi.fn();
const mockUseOrganization = vi.fn();

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: (...args: unknown[]) => mockUseHasPermissions(...args),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganization: (...args: unknown[]) => mockUseOrganization(...args),
}));

vi.mock("./edit-policy-dialog", () => ({
  EditPolicyDialog: () => <div>Edit policy dialog</div>,
}));

describe("PolicyDeniedTool", () => {
  const defaultProps = {
    policyDenied: {
      toolCallId: "call-1",
      type: "tool-internal-dev-test-server__print_archestra_test",
      state: "output-denied",
      errorText: JSON.stringify({
        reason: "context contains sensitive data",
      }),
      input: {},
    },
    profileId: "agent-1",
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the inline support message and hides the edit action when the user cannot update policies", () => {
    mockUseHasPermissions.mockReturnValue({ data: false });
    mockUseOrganization.mockReturnValue({
      data: {
        chatErrorSupportMessage:
          "Contact support@company.com and include the blocked tool details.",
      },
    });

    render(<PolicyDeniedTool {...defaultProps} editable={true} />);

    expect(
      screen.getByText(
        /Contact support@company\.com and include the blocked tool details\./i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Edit policy/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the edit action when the user can update policies", () => {
    mockUseHasPermissions.mockReturnValue({ data: true });
    mockUseOrganization.mockReturnValue({
      data: {
        chatErrorSupportMessage: "Contact support@company.com",
      },
    });

    render(<PolicyDeniedTool {...defaultProps} editable={true} />);

    expect(
      screen.getByRole("button", { name: /Edit policy/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Contact support@company\.com/i),
    ).not.toBeInTheDocument();
  });
});
