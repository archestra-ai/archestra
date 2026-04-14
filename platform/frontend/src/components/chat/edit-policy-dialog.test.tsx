import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditPolicyDialog } from "./edit-policy-dialog";

const mockUseAllProfileTools = vi.fn();
const mockUseHasPermissions = vi.fn();
const mockUseOrganization = vi.fn();

vi.mock("@/lib/agent-tools.query", () => ({
  useAllProfileTools: (...args: unknown[]) => mockUseAllProfileTools(...args),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: (...args: unknown[]) => mockUseHasPermissions(...args),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganization: (...args: unknown[]) => mockUseOrganization(...args),
}));

vi.mock("@/app/mcp/tool-guardrails/_parts/tool-call-policies", () => ({
  ToolCallPolicies: () => <div>Tool call policies</div>,
}));

vi.mock("@/app/mcp/tool-guardrails/_parts/tool-result-policies", () => ({
  ToolResultPolicies: () => <div>Tool result policies</div>,
}));

describe("EditPolicyDialog", () => {
  it("shows the organization support message when the user cannot update tool policies", () => {
    mockUseHasPermissions.mockReturnValue({ data: false });
    mockUseOrganization.mockReturnValue({
      data: {
        chatErrorSupportMessage:
          "Contact support@company.com and include the blocked tool details.",
      },
    });
    mockUseAllProfileTools.mockReturnValue({ data: { data: [] } });

    render(
      <EditPolicyDialog
        open={true}
        onOpenChange={() => {}}
        toolName="internal-dev-test-server__print_archestra_test"
        profileId="agent-1"
      />,
    );

    expect(
      screen.getByText(
        "Contact support@company.com and include the blocked tool details.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Tool not found or not assigned to this Agent."),
    ).not.toBeInTheDocument();
  });

  it("shows a generic message when the user cannot update tool policies and no support message is configured", () => {
    mockUseHasPermissions.mockReturnValue({ data: false });
    mockUseOrganization.mockReturnValue({
      data: {
        chatErrorSupportMessage: null,
      },
    });
    mockUseAllProfileTools.mockReturnValue({ data: { data: [] } });

    render(
      <EditPolicyDialog
        open={true}
        onOpenChange={() => {}}
        toolName="internal-dev-test-server__print_archestra_test"
        profileId="agent-1"
      />,
    );

    expect(
      screen.getByText(
        "You do not have permission to edit tool guardrails. Contact your administrator or support team for help.",
      ),
    ).toBeInTheDocument();
  });

  it("shows a loading state while permission checks are still pending", () => {
    mockUseHasPermissions.mockReturnValue({ data: false, isLoading: true });
    mockUseOrganization.mockReturnValue({
      data: {
        chatErrorSupportMessage: "Contact support@company.com",
      },
    });
    mockUseAllProfileTools.mockReturnValue({ data: { data: [] } });

    render(
      <EditPolicyDialog
        open={true}
        onOpenChange={() => {}}
        toolName="internal-dev-test-server__print_archestra_test"
        profileId="agent-1"
      />,
    );

    expect(
      screen.queryByText("Tool not found or not assigned to this Agent."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Contact support@company.com"),
    ).not.toBeInTheDocument();
  });
});
