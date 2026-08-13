import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import { RegistryEmptyState } from "./registry-empty-state";

vi.mock("@/lib/auth/auth.query");
vi.mock("next/navigation");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RegistryEmptyState", () => {
  it("explains the empty state and routes to the catalog on click", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
      typeof useHasPermissions
    >);
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
    } as unknown as ReturnType<typeof useRouter>);

    render(<RegistryEmptyState />);

    expect(
      screen.getByText("No MCP servers installed yet"),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /add mcp server/i }),
    );
    expect(push).toHaveBeenCalledWith("/mcp/registry/new");
  });

  it("disables the button when the user lacks create permission", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useMissingPermissions).mockReturnValue({
      mcpRegistry: ["create"],
    } as ReturnType<typeof useMissingPermissions>);
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    render(<RegistryEmptyState />);

    expect(
      screen.getByRole("button", { name: /add mcp server/i }),
    ).toBeDisabled();
  });
});
