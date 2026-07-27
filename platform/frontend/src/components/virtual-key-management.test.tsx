import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  useAllVirtualApiKeys,
  useDeleteVirtualApiKey,
  useFetchVirtualApiKeyValue,
} from "@/lib/virtual-api-keys.query";
import { VirtualKeyManagement } from "./virtual-key-management";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/virtual-api-keys.query", () => ({
  useAllVirtualApiKeys: vi.fn(),
  useDeleteVirtualApiKey: vi.fn(),
  useFetchVirtualApiKeyValue: vi.fn(),
}));
vi.mock("@/components/edit-virtual-key-dialog", () => ({
  EditVirtualKeyDialog: (props: { virtualKey: { name: string } | null }) =>
    props.virtualKey ? <div>editing:{props.virtualKey.name}</div> : null,
}));
vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: (props: { open: boolean; description: string }) =>
    props.open ? <div>{props.description}</div> : null,
}));

const key = {
  id: "key-1",
  name: "Selected key",
  tokenStart: "arch_test",
  authorId: "user-1",
  authorName: "Owner",
  keyType: "standard",
  providerApiKeys: [],
  teams: [],
  scope: "personal",
  expiresAt: null,
};

function result(offset = 0, total = 1) {
  const count = Math.min(20, total - offset);
  return {
    data:
      count > 0
        ? Array.from({ length: count }, (_, index) => ({
            ...key,
            id: `key-${offset + index}`,
            name: `Key ${offset + index + 1}`,
          }))
        : [],
    pagination: {
      currentPage: offset / 20 + 1,
      limit: 20,
      total,
      totalPages: Math.ceil(total / 20),
      hasNext: offset + 20 < total,
      hasPrev: offset > 0,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useAllVirtualApiKeys).mockReturnValue({
    data: result(),
    isPending: false,
    isLoadingError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useAllVirtualApiKeys>);
  vi.mocked(useDeleteVirtualApiKey).mockReturnValue({
    isPending: false,
    mutate: vi.fn(),
  } as unknown as ReturnType<typeof useDeleteVirtualApiKey>);
  vi.mocked(useFetchVirtualApiKeyValue).mockReturnValue({
    isPending: false,
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof useFetchVirtualApiKeyValue>);
});

describe("VirtualKeyManagement", () => {
  it("requests server pages of 20 and can navigate through every page", async () => {
    vi.mocked(useAllVirtualApiKeys).mockImplementation(
      (params) =>
        ({
          data: result(params?.offset ?? 0, 45),
          isPending: false,
          isLoadingError: false,
          refetch: vi.fn(),
        }) as unknown as ReturnType<typeof useAllVirtualApiKeys>,
    );
    const user = userEvent.setup();
    render(<VirtualKeyManagement keyType="standard" />);

    expect(useAllVirtualApiKeys).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 20, offset: 0 }),
    );
    expect(screen.getByText("1–20 of 45")).toBeInTheDocument();
    expect(screen.queryByText(/Client Credentials/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(useAllVirtualApiKeys).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 20, offset: 20 }),
    );
    expect(screen.getByText("21–40 of 45")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(useAllVirtualApiKeys).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 20, offset: 40 }),
    );
    expect(screen.getByText("41–45 of 45")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("renders query failure and retries it", async () => {
    const refetch = vi.fn();
    vi.mocked(useAllVirtualApiKeys).mockReturnValue({
      isPending: false,
      isLoadingError: true,
      refetch,
    } as unknown as ReturnType<typeof useAllVirtualApiKeys>);
    render(<VirtualKeyManagement keyType="standard" />);
    expect(screen.getByText("Couldn't load virtual keys")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("independently permission-gates update and delete", () => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permission) =>
        ({
          data:
            "llmVirtualKey" in permission &&
            (permission.llmVirtualKey?.includes("read") ||
              permission.llmVirtualKey?.includes("update")),
        }) as ReturnType<typeof useHasPermissions>,
    );
    render(<VirtualKeyManagement keyType="standard" />);
    expect(
      screen.getByRole("button", { name: "Edit Key 1" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete Key 1" }),
    ).not.toBeInTheDocument();
  });

  it("opens edit and delete dialogs for the selected row", async () => {
    const user = userEvent.setup();
    render(<VirtualKeyManagement keyType="standard" />);
    await user.click(screen.getByRole("button", { name: "Edit Key 1" }));
    expect(screen.getByText("editing:Key 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete Key 1" }));
    expect(screen.getByText(/delete "Key 1"/)).toBeInTheDocument();
  });

  it("explains how to configure a virtual key in the empty state", () => {
    vi.mocked(useAllVirtualApiKeys).mockReturnValue({
      data: result(0, 0),
      isPending: false,
      isLoadingError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAllVirtualApiKeys>);

    const { rerender } = render(<VirtualKeyManagement keyType="standard" />);
    expect(
      screen.getByText(
        "No virtual keys yet. Create one and choose its provider key mappings.",
      ),
    ).toBeInTheDocument();

    rerender(<VirtualKeyManagement keyType="passthrough" />);
    expect(screen.getByText("No passthrough keys yet.")).toBeInTheDocument();
  });
});
