import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  AccountPageAction,
  AccountPageActionSlotContext,
} from "./account-page-action";

describe("AccountPageAction", () => {
  it("places a section action in the personal settings header", () => {
    render(<TestAccountShell />);

    const header = screen.getByTestId("personal-settings-actions");
    expect(header).toContainElement(
      screen.getByRole("button", { name: "Create API Key" }),
    );
  });
});

function TestAccountShell() {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  return (
    <>
      <div data-testid="personal-settings-actions" ref={setSlot} />
      <AccountPageActionSlotContext.Provider value={slot}>
        <AccountPageAction>
          <button type="button">Create API Key</button>
        </AccountPageAction>
      </AccountPageActionSlotContext.Provider>
    </>
  );
}
