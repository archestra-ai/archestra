import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { GroupedNumberInput } from "./grouped-number-input";

/** Mirrors how the input is used: the caller stores the digits it emits. */
function ControlledInput({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <GroupedNumberInput
        aria-label="Context window"
        value={value}
        onChange={setValue}
      />
      <output>{value}</output>
    </>
  );
}

describe("GroupedNumberInput", () => {
  it("groups digits as they are typed", async () => {
    const user = userEvent.setup();
    render(<ControlledInput />);
    const input = screen.getByLabelText<HTMLInputElement>("Context window");

    await user.type(input, "128000");

    expect(input).toHaveValue("128,000");
  });

  it("emits digits only, so validators never see a separator", async () => {
    const user = userEvent.setup();
    render(<ControlledInput />);

    await user.type(screen.getByLabelText("Context window"), "128000");

    expect(screen.getByRole("status")).toHaveTextContent("128000");
  });

  it("keeps the caret with the digit just typed when editing mid-number", async () => {
    const user = userEvent.setup();
    render(<ControlledInput initial="128000" />);
    const input = screen.getByLabelText<HTMLInputElement>("Context window");

    // "128,000" -> put the caret after the "1" and type a digit. A naive
    // reformat drops the caret at the end, so the next keystroke lands in the
    // wrong place and the number comes out scrambled.
    input.setSelectionRange(1, 1);
    await user.type(input, "9", { initialSelectionStart: 1 });

    expect(input).toHaveValue("1,928,000");
    expect(input.selectionStart).toBe(3);
  });

  it("drops non-digits, so a pasted formatted number is accepted", async () => {
    const user = userEvent.setup();
    render(<ControlledInput />);
    const input = screen.getByLabelText<HTMLInputElement>("Context window");

    await user.click(input);
    await user.paste("128,000");

    expect(input).toHaveValue("128,000");
    expect(screen.getByRole("status")).toHaveTextContent("128000");
  });

  it("forwards a ref so the form library can focus the field", () => {
    const ref = vi.fn();
    render(<GroupedNumberInput ref={ref} value="" onChange={vi.fn()} />);

    expect(ref).toHaveBeenCalledWith(expect.any(HTMLInputElement));
  });
});
