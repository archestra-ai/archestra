import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pushMock, createMutateMock, useAppTemplatesMock, useCreateAppMock } =
  vi.hoisted(() => ({
    pushMock: vi.fn(),
    createMutateMock: vi.fn(),
    useAppTemplatesMock: vi.fn(),
    useCreateAppMock: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/lib/app.query", () => ({
  useAppTemplates: useAppTemplatesMock,
  useCreateApp: useCreateAppMock,
}));

import { AppCreateDialog } from "./app-create-dialog";

const templates = [
  {
    id: "blank",
    name: "Blank",
    description: "Empty",
    html: "<html><body>BLANK</body></html>",
  },
  {
    id: "form",
    name: "Form",
    description: "With data store",
    html: "<html><body>FORM</body></html>",
  },
];

describe("AppCreateDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppTemplatesMock.mockReturnValue({ data: templates });
    createMutateMock.mockResolvedValue({ id: "app-123" });
    useCreateAppMock.mockReturnValue({
      mutateAsync: createMutateMock,
      isPending: false,
    });
  });

  it("seeds the chosen template's html and navigates to the new app", async () => {
    const user = userEvent.setup();
    render(<AppCreateDialog open onOpenChange={() => {}} />);

    await user.type(screen.getByLabelText("Name"), "My App");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateMock).toHaveBeenCalledTimes(1));
    // Default template is "blank" — its html is seeded into create_app, and the
    // template id is recorded as provenance.
    expect(createMutateMock).toHaveBeenCalledWith({
      name: "My App",
      description: undefined,
      templateId: "blank",
      html: "<html><body>BLANK</body></html>",
      scope: "personal",
    });
    expect(pushMock).toHaveBeenCalledWith("/apps/app-123");
  });
});
