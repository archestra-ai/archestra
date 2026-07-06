import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { EditPolicyDialog } from "./edit-policy-dialog";

const mockUseAllProfileTools = vi.fn();
const mockUseTool = vi.fn();

vi.mock("@/lib/agent-tools.query", () => ({
  useAllProfileTools: (...args: unknown[]) => mockUseAllProfileTools(...args),
}));

vi.mock("@/lib/tools/tool.query", () => ({
  useTool: (...args: unknown[]) => mockUseTool(...args),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/organization.query");

vi.mock("@/app/mcp/tool-guardrails/_parts/tool-call-policies", () => ({
  ToolCallPolicies: () => <div>Tool call policies</div>,
}));

vi.mock("@/app/mcp/tool-guardrails/_parts/tool-result-policies", () => ({
  ToolResultPolicies: () => <div>Tool result policies</div>,
}));

describe("EditPolicyDialog", () => {
  beforeEach(() => {
    mockUseTool.mockReturnValue({ data: undefined, isLoading: false });
  });

  it("shows the organization support message when the user cannot update tool policies", () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
      typeof useHasPermissions
    >);
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        chatErrorSupportMessage:
          "Contact support@company.com and include the blocked tool details.",
      },
    } as unknown as ReturnType<typeof useOrganization>);
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
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
      typeof useHasPermissions
    >);
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        chatErrorSupportMessage: null,
      },
    } as unknown as ReturnType<typeof useOrganization>);
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
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isLoading: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        chatErrorSupportMessage: "Contact support@company.com",
      },
    } as unknown as ReturnType<typeof useOrganization>);
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

  it("resolves the tool by id when it has no agent assignment", () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
      typeof useHasPermissions
    >);
    vi.mocked(useOrganization).mockReturnValue({
      data: {},
    } as unknown as ReturnType<typeof useOrganization>);
    // The assignment lookup finds nothing (All-mode tool has no agent_tools row).
    mockUseAllProfileTools.mockReturnValue({ data: { data: [] } });
    mockUseTool.mockReturnValue({
      data: { id: "tool-1", name: "workspace__export_data", parameters: {} },
      isLoading: false,
    });

    render(
      <EditPolicyDialog
        open={true}
        onOpenChange={() => {}}
        toolName="workspace__export_data"
        profileId="agent-1"
        toolId="tool-1"
      />,
    );

    expect(screen.getByText("Tool call policies")).toBeInTheDocument();
    expect(screen.getByText("Tool result policies")).toBeInTheDocument();
    expect(
      screen.queryByText("Tool not found or not assigned to this Agent."),
    ).not.toBeInTheDocument();
  });
});
