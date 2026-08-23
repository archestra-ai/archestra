import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolPolicyBulkActionsBar } from "./tool-policy-bulk-actions";

const autoConfigureMutate = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { warning: toastWarning, success: toastSuccess, error: vi.fn() },
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useAutoConfigurePolicies: () => ({
    mutateAsync: autoConfigureMutate,
    isPending: false,
  }),
}));

vi.mock("@/lib/policy.query", () => ({
  useBulkCallPolicyMutation: () => ({ mutateAsync: vi.fn() }),
  useBulkResultPolicyMutation: () => ({ mutateAsync: vi.fn() }),
  useToolInvocationPolicies: () => ({ data: { byProfileToolId: {} } }),
  useToolResultPolicies: () => ({ data: { byProfileToolId: {} } }),
}));

vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/roles/with-permissions", () => ({
  WithPermissions: ({
    children,
  }: {
    children: (args: { hasPermission: boolean }) => React.ReactNode;
  }) => children({ hasPermission: true }),
}));

function renderBar(selectedToolIds: string[]) {
  return render(
    <ToolPolicyBulkActionsBar
      selectedToolIds={selectedToolIds}
      onClear={vi.fn()}
    />,
  );
}

async function clickConfigure() {
  await userEvent.click(
    screen.getByRole("button", { name: /configure with subagent/i }),
  );
}

describe("ToolPolicyBulkActionsBar — Configure with Subagent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells the user why the tools failed, not just how many", async () => {
    // The shape this actually fails in: one cause takes down every tool.
    autoConfigureMutate.mockResolvedValue({
      results: [
        { toolId: "a", success: false, error: "LLM API key not configured" },
        { toolId: "b", success: false, error: "LLM API key not configured" },
      ],
    });

    renderBar(["a", "b"]);
    await clickConfigure();

    expect(toastWarning).toHaveBeenCalledWith(
      expect.stringContaining("failed 2"),
      expect.objectContaining({ description: "LLM API key not configured" }),
    );
  });

  it("lists distinct reasons for a mixed batch, capped", async () => {
    autoConfigureMutate.mockResolvedValue({
      results: [
        { toolId: "a", success: true },
        { toolId: "b", success: false, error: "Tool not found" },
        {
          toolId: "c",
          success: false,
          error: "Auto-configure timed out (>20s)",
        },
        { toolId: "d", success: false, error: "Rate limited" },
      ],
    });

    renderBar(["a", "b", "c", "d"]);
    await clickConfigure();

    const [message, options] = toastWarning.mock.calls.at(-1) as [
      string,
      { description?: string },
    ];
    expect(message).toContain("configured for 1 tool(s), failed 3");
    expect(options.description).toBe(
      "Tool not found · Auto-configure timed out (>20s) (+1 more)",
    );
  });

  it("stays a plain success toast when nothing failed", async () => {
    autoConfigureMutate.mockResolvedValue({
      results: [{ toolId: "a", success: true }],
    });

    renderBar(["a"]);
    await clickConfigure();

    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("configured for 1 tool(s)"),
    );
    expect(toastWarning).not.toHaveBeenCalled();
  });
});
