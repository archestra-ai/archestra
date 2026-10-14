import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { TabbedDialogShell } from "./tabbed-dialog-shell";

afterEach(() => vi.unstubAllGlobals());

it("keeps secondary actions unambiguous and usable when the dialog changes between desktop and mobile", async () => {
  const media = new EventTarget();
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("innerWidth", 1200);
  const remove = vi.fn();
  const user = userEvent.setup();
  render(
    <TabbedDialogShell
      open
      onOpenChange={vi.fn()}
      title="Edit item"
      sidebarLabel="Item"
      sidebarDescription="Settings"
      sidebarIcon={null}
      activeSection="general"
      navItems={[{ id: "general", label: "General" }]}
      onActiveSectionChange={vi.fn()}
      onSubmit={vi.fn()}
      footer={<Button>Save</Button>}
      sidebarFooter={
        <Button type="button" data-testid="remove-item" onClick={remove}>
          Delete
        </Button>
      }
    >
      <p>Item settings</p>
    </TabbedDialogShell>,
  );
  expect(screen.getAllByTestId("remove-item")).toHaveLength(1);
  await user.click(screen.getByTestId("remove-item"));
  expect(remove).toHaveBeenCalledTimes(1);
  act(() => {
    vi.stubGlobal("innerWidth", 390);
    media.dispatchEvent(new Event("change"));
  });
  expect(screen.getAllByTestId("remove-item")).toHaveLength(1);
  await user.click(screen.getByTestId("remove-item"));
  expect(remove).toHaveBeenCalledTimes(2);
});
