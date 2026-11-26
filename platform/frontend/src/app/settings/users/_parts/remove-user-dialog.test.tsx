import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@/lib/member.query";
import { RemoveUserDialog } from "./remove-user-dialog";

vi.mock("sonner");
vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "admin-1", name: "Admin" } } }),
}));
vi.mock("@/lib/organization.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organization.query")>()),
  useOrganization: () => ({ data: undefined }),
}));
vi.mock("@/lib/member-options.query", () => ({
  useMemberOptionsReferences: () => ({ data: [] }),
}));
vi.mock("@archestra/shared/api-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared/api-sdk")>()),
  bulkDeleteMembers: vi.fn(),
  getMemberOwnedResources: vi.fn(),
}));

const bulkDeleteMembers = vi.mocked(archestraApiSdk.bulkDeleteMembers);
const getMemberOwnedResources = vi.mocked(
  archestraApiSdk.getMemberOwnedResources,
);

const member = {
  id: "member-1",
  userId: "user-1",
  name: "Synthetic Member",
  email: "member@example.com",
} as Member;

function removalResult(
  failed: { kind: "member"; id: string; error: string }[],
) {
  return {
    data: {
      succeeded: failed.length ? [] : [{ kind: "member", id: member.id }],
      failed,
    },
    error: undefined,
  } as unknown as Awaited<ReturnType<typeof archestraApiSdk.bulkDeleteMembers>>;
}

function renderDialog(onOpenChange: (open: boolean) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RemoveUserDialog member={member} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

describe("RemoveUserDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMemberOwnedResources.mockResolvedValue({
      data: { shared: [], personal: [] },
      error: undefined,
    } as unknown as Awaited<
      ReturnType<typeof archestraApiSdk.getMemberOwnedResources>
    >);
  });

  it("keeps a failed removal open and retryable, and closes after a later success", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const onOpenChange = vi.fn();
    bulkDeleteMembers
      .mockResolvedValueOnce(
        removalResult([
          { kind: "member", id: member.id, error: "No longer a member" },
        ]),
      )
      .mockResolvedValueOnce(removalResult([]));
    renderDialog(onOpenChange);

    const remove = await screen.findByRole("button", { name: "Remove user" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed to remove member", {
        description: "No longer a member",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove user" })).toBeEnabled(),
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove user" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(bulkDeleteMembers).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith("Member removed");

    window.removeEventListener("unhandledrejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
