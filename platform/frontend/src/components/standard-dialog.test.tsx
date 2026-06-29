import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { StandardDialog, StandardFormDialog } from "./standard-dialog";

describe("StandardDialog", () => {
  it("renders body and footer using the shared shell", () => {
    render(
      <StandardDialog
        open
        onOpenChange={vi.fn()}
        title="Install Server"
        description="Shared shell"
        footer={<Button type="button">Close</Button>}
      >
        <div>Dialog body content</div>
      </StandardDialog>,
    );
    const body = document.body.querySelector('[data-slot="dialog-body"]');
    const footer = document.body.querySelector('[data-slot="dialog-footer"]');

    expect(screen.getByText("Install Server")).toBeInTheDocument();
    expect(screen.getByText("Dialog body content")).toBeInTheDocument();
    expect(body).toContainElement(screen.getByText("Dialog body content"));
    expect(footer).toContainElement(
      screen.getAllByRole("button", { name: "Close" })[0],
    );
  });

  it("submits through the shared form shell", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(
      <StandardFormDialog
        open
        onOpenChange={vi.fn()}
        title="Request Install"
        description="Shared form shell"
        onSubmit={onSubmit}
        footer={<Button type="submit">Submit</Button>}
      >
        <label htmlFor="request-reason">Reason</label>
        <input id="request-reason" />
      </StandardFormDialog>,
    );

    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
