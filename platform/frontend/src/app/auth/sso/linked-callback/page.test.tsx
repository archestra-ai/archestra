import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeLinkedIdentityProviderIntent } from "@/lib/auth/linked-idp";
import LinkedIdentityProviderCallbackPage from "./page";

vi.mock("next/navigation", () => ({
  useSearchParams: vi.fn(),
}));

vi.mock("@/components/app-logo", () => ({
  AppLogo: () => <div data-testid="app-logo" />,
}));

vi.mock("@/lib/auth/linked-idp", () => ({
  completeLinkedIdentityProviderIntent: vi.fn(),
}));

describe("LinkedIdentityProviderCallbackPage", () => {
  const replace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "location", {
      value: { origin: "https://app.example.com", replace },
      writable: true,
    });
    vi.mocked(useSearchParams).mockReturnValue({
      get: vi.fn((key: string) => {
        if (key === "intentId") return "intent-123";
        if (key === "redirectTo") return encodeURIComponent("/chat/fallback");
        return null;
      }),
    } as unknown as ReturnType<typeof useSearchParams>);
    vi.mocked(completeLinkedIdentityProviderIntent).mockResolvedValue({
      redirectTo: "/chat/conv-123",
    });
  });

  it("completes the link request and redirects to the original path", async () => {
    render(<LinkedIdentityProviderCallbackPage />);

    await waitFor(() => {
      expect(completeLinkedIdentityProviderIntent).toHaveBeenCalledWith(
        "intent-123",
      );
      expect(replace).toHaveBeenCalledWith("/chat/conv-123?user_prompt=retry");
    });
  });

  it("shows retry when completion fails", async () => {
    const user = userEvent.setup();
    vi.mocked(completeLinkedIdentityProviderIntent)
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce({ redirectTo: "/chat/conv-123" });

    render(<LinkedIdentityProviderCallbackPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Try Again" })).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Try Again" }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/chat/conv-123?user_prompt=retry");
    });
  });
});
