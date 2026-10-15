import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { TabbedDialogShell } from "./tabbed-dialog-shell";

afterEach(() => vi.unstubAllGlobals());

// JSDOM lacks the pointer and scrolling APIs used by Radix Select.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

it("keeps section navigation and its status indicator available in the mobile picker", async () => {
  vi.stubGlobal("matchMedia", () => new EventTarget());
  vi.stubGlobal("innerWidth", 390);
  const user = userEvent.setup();
  function MobileDialog() {
    const [section, setSection] = useState("general");
    return (
      <TabbedDialogShell
        open
        onOpenChange={vi.fn()}
        title="Edit item"
        sidebarLabel="Item"
        sidebarDescription="Settings"
        sidebarIcon={null}
        activeSection={section}
        navItems={[
          { id: "general", label: "General" },
          {
            id: "keys",
            label: "API keys",
            indicator: (
              <span role="img" aria-label="No API keys">
                !
              </span>
            ),
          },
        ]}
        onActiveSectionChange={setSection}
        onSubmit={vi.fn()}
        footer={<Button>Save</Button>}
      >
        <p>{section === "keys" ? "API key settings" : "General settings"}</p>
      </TabbedDialogShell>
    );
  }
  render(<MobileDialog />);
  const picker = screen.getByRole("combobox", { name: "Dialog section" });
  await user.click(picker);
  await user.click(screen.getByRole("option", { name: /^API keys/ }));
  expect(screen.getByText("API key settings")).toBeVisible();
  expect(picker).toHaveTextContent("API keys");
  expect(
    within(picker).getByRole("img", { name: "No API keys" }),
  ).toBeVisible();
  await user.click(picker);
  await user.click(screen.getByRole("option", { name: "General" }));
  expect(screen.getByText("General settings")).toBeVisible();
});

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
