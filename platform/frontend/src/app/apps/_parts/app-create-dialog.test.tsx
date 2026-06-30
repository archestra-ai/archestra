import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pushMock, createMutateMock, useCreateAppMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  createMutateMock: vi.fn(),
  useCreateAppMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/lib/app.query", () => ({
  useCreateApp: useCreateAppMock,
}));

import { AppCreateDialog } from "./app-create-dialog";

describe("AppCreateDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMutateMock.mockResolvedValue({
      id: "app-123",
      conversationId: "conv-456",
    });
    useCreateAppMock.mockReturnValue({
      mutateAsync: createMutateMock,
      isPending: false,
    });
  });

  it("creates the app with openInChat and opens the seeded conversation", async () => {
    const user = userEvent.setup();
    render(<AppCreateDialog open onOpenChange={() => {}} />);

    await user.type(screen.getByLabelText("Name"), "My App");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateMock).toHaveBeenCalledTimes(1));
    expect(createMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My App", openInChat: true }),
    );
    expect(pushMock).toHaveBeenCalledWith("/chat/conv-456");
  });

  it("falls back to the app's standalone page when no conversation was seeded", async () => {
    createMutateMock.mockResolvedValue({ id: "app-123" });
    const user = userEvent.setup();
    render(<AppCreateDialog open onOpenChange={() => {}} />);

    await user.type(screen.getByLabelText("Name"), "My App");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/a/app-123"));
  });
});
