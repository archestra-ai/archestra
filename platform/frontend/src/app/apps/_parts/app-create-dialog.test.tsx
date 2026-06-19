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
    createMutateMock.mockResolvedValue({ id: "app-123" });
    useCreateAppMock.mockReturnValue({
      mutateAsync: createMutateMock,
      isPending: false,
    });
  });

  it("creates the app without a templateId (backend seeds the default) and navigates", async () => {
    const user = userEvent.setup();
    render(<AppCreateDialog open onOpenChange={() => {}} />);

    await user.type(screen.getByLabelText("Name"), "My App");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateMock).toHaveBeenCalledTimes(1));
    expect(createMutateMock).toHaveBeenCalledWith({
      name: "My App",
      description: undefined,
      scope: "personal",
    });
    expect(pushMock).toHaveBeenCalledWith("/apps/app-123");
  });
});
