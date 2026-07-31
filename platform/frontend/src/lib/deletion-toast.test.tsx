import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("next/navigation");

import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { useDeletionToast } from "./deletion-toast";

type ToastOptions = {
  description?: string;
  action?: { label: string; onClick: () => void };
  cancel?: { label: string; onClick: () => void };
};

function setup(options: {
  retentionDays?: number;
  autoPurgeEnabled?: boolean;
  canViewDeletedItems?: boolean;
}) {
  vi.mocked(useOrganization).mockReturnValue({
    data: {
      softDeleteRetentionDays: options.retentionDays ?? 30,
      softDeleteAutoPurgeEnabled: options.autoPurgeEnabled ?? true,
    },
  } as ReturnType<typeof useOrganization>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: options.canViewDeletedItems ?? true,
  } as ReturnType<typeof useHasPermissions>);
}

function lastToastOptions(): ToastOptions {
  const call = vi.mocked(toast.success).mock.calls.at(-1);
  return (call?.[1] ?? {}) as ToastOptions;
}

describe("useDeletionToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells the user how long the item is kept", () => {
    setup({ retentionDays: 14 });
    const { result } = renderHook(() => useDeletionToast());

    result.current({ message: "Skill deleted" });

    expect(toast.success).toHaveBeenCalledWith(
      "Skill deleted",
      expect.anything(),
    );
    expect(lastToastOptions().description).toBe("Kept for 14 days.");
  });

  it("uses the singular for a one-day window", () => {
    setup({ retentionDays: 1 });
    const { result } = renderHook(() => useDeletionToast());

    result.current({ message: "Skill deleted" });

    expect(lastToastOptions().description).toBe("Kept for 1 day.");
  });

  it("does not promise a deadline when auto-purge is off", () => {
    // Promising "kept for 30 days" while nothing reclaims on a schedule would be
    // wrong in the one direction that matters to a user hunting for old work.
    setup({ retentionDays: 30, autoPurgeEnabled: false });
    const { result } = renderHook(() => useDeletionToast());

    result.current({ message: "Skill deleted" });

    expect(lastToastOptions().description).toBe(
      "Kept until someone deletes it permanently.",
    );
  });

  it("offers Undo only when the caller supplies one", () => {
    setup({});
    const { result } = renderHook(() => useDeletionToast());
    const undo = vi.fn();

    result.current({ message: "Project deleted", undo });
    expect(lastToastOptions().action).toMatchObject({ label: "Undo" });
    lastToastOptions().action?.onClick();
    expect(undo).toHaveBeenCalledOnce();

    // Omitted for someone who cannot restore the thing — an Undo that 403s is
    // worse than no Undo at all.
    result.current({ message: "Project deleted" });
    expect(lastToastOptions().action).toBeUndefined();
  });

  it("hides the Deleted Items link from users who cannot open the page", () => {
    setup({ canViewDeletedItems: false });
    const { result } = renderHook(() => useDeletionToast());

    result.current({ message: "App deleted" });

    expect(lastToastOptions().cancel).toBeUndefined();
  });

  it("points users who can open the page at Deleted Items", () => {
    setup({ canViewDeletedItems: true });
    const { result } = renderHook(() => useDeletionToast());

    result.current({ message: "App deleted" });

    expect(lastToastOptions().cancel).toMatchObject({
      label: "View deleted items",
    });
  });
});
