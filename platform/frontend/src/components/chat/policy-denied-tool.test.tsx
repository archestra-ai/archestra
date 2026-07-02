import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { PolicyDeniedTool } from "./policy-denied-tool";

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/organization.query");

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
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
      typeof useHasPermissions
    >);
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        chatErrorSupportMessage:
          "Contact support@company.com and include the blocked tool details.",
      },
    } as unknown as ReturnType<typeof useOrganization>);

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
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
      typeof useHasPermissions
    >);
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        chatErrorSupportMessage: "Contact support@company.com",
      },
    } as unknown as ReturnType<typeof useOrganization>);

    render(<PolicyDeniedTool {...defaultProps} editable={true} />);

    expect(
      screen.getByRole("button", { name: /Edit policy/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Contact support@company\.com/i),
    ).not.toBeInTheDocument();
  });
});
