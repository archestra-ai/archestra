import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlatformTokenManagerDialog } from "./platform-token-manager-dialog";

describe("PlatformTokenManagerDialog", () => {
  it("shows token details with relative timestamps and fetches the token value on demand", async () => {
    const fetchTokenValue = vi.fn().mockResolvedValue("arch_full_token_value");

    render(
      <PlatformTokenManagerDialog
        open
        onOpenChange={vi.fn()}
        token={{
          id: "token-1",
          name: "Test Token",
          tokenStart: "arch_preview",
          createdAt: "2026-05-01T00:00:00.000Z",
          lastUsedAt: null,
        }}
        title="Test Token"
        description="Token description"
        fetchTokenValue={fetchTokenValue}
        rotateToken={vi.fn()}
        isRotating={false}
      />,
    );

    expect(screen.getByText(/Created:/)).toBeInTheDocument();
    expect(screen.getByText(/Last used:/)).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.getByDisplayValue("arch_preview...")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Show token"));

    await waitFor(() => {
      expect(fetchTokenValue).toHaveBeenCalled();
    });
    expect(
      screen.getByDisplayValue("arch_full_token_value"),
    ).toBeInTheDocument();
  });
});
