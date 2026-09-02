import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateProjectFromConversation } from "@/lib/projects/projects.query";
import { CreateProjectFromChatDialog } from "./create-project-from-chat-dialog";

const mutateAsync = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/projects/projects.query");
vi.mock("@/components/standard-dialog", () => ({
  StandardFormDialog: ({
    open,
    title,
    children,
    footer,
    onSubmit,
  }: {
    open: boolean;
    title: string;
    children: React.ReactNode;
    footer: React.ReactNode;
    onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  }) =>
    open ? (
      <form onSubmit={onSubmit}>
        <h2>{title}</h2>
        {children}
        {footer}
      </form>
    ) : null,
}));
vi.mock("@/components/identity-fields", () => ({
  IdentityFields: ({ children }: { children: React.ReactNode }) => children,
}));

describe("CreateProjectFromChatDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsync.mockResolvedValue({ id: "project-id" });
    vi.mocked(useCreateProjectFromConversation).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateProjectFromConversation>);
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
  });

  it("creates the project with a label from Advanced", async () => {
    render(
      <CreateProjectFromChatDialog
        conversationId="conversation-id"
        defaultName="Chat project"
        open
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.change(screen.getByLabelText("Label key"), {
      target: { value: "stage" },
    });
    fireEvent.change(screen.getByLabelText("Label value"), {
      target: { value: "draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        conversationId: "conversation-id",
        name: "Chat project",
        description: null,
        icon: null,
        labels: [{ key: "stage", value: "draft" }],
      }),
    );
  });
});
