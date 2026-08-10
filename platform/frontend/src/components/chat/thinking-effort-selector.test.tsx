import type { ThinkingEffortSetting } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LlmModel } from "@/lib/llm-models.query";
import { ThinkingEffortSelector } from "./thinking-effort-selector";

const mockUseLlmModels = vi.fn();
vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: (params?: unknown) => mockUseLlmModels(params),
}));

function setModels(models: Partial<LlmModel>[]) {
  mockUseLlmModels.mockReturnValue({ data: models });
}

const GEMINI_FLASH: Partial<LlmModel> = {
  dbId: "row-1",
  id: "gemini-3.6-flash",
  provider: "gemini",
};

function renderSelector(overrides: Record<string, unknown> = {}) {
  return render(
    <ThinkingEffortSelector
      selectedModel="row-1"
      value="low"
      onChange={vi.fn()}
      {...overrides}
    />,
  );
}

/** Mirrors the real call site, which feeds the picked value straight back in. */
function ControlledSelector() {
  const [value, setValue] = useState<ThinkingEffortSetting>("low");
  return (
    <ThinkingEffortSelector
      selectedModel="row-1"
      value={value}
      onChange={setValue}
    />
  );
}

const trigger = () => screen.getByRole("button", { name: /Reasoning depth/i });
const option = (name: string) =>
  screen.getByRole("menuitemradio", { name: new RegExp(`^${name}`) });

describe("ThinkingEffortSelector", () => {
  it("shows only the current depth until it is opened", async () => {
    const user = userEvent.setup();
    setModels([GEMINI_FLASH]);

    renderSelector({ value: "medium" });

    expect(trigger()).toHaveTextContent("Medium");
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();

    await user.click(trigger());

    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
    expect(option("Medium")).toBeChecked();
  });

  it("reports the depth the user picks and closes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    setModels([GEMINI_FLASH]);

    renderSelector({ onChange });
    await user.click(trigger());
    await user.click(option("High"));

    expect(onChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
  });

  it("shows the new depth on the trigger once picked", async () => {
    const user = userEvent.setup();
    setModels([GEMINI_FLASH]);

    render(<ControlledSelector />);
    expect(trigger()).toHaveTextContent("Low");

    await user.click(trigger());
    await user.click(option("Medium"));

    expect(trigger()).toHaveTextContent("Medium");
  });

  it("opens and picks from the keyboard alone", async () => {
    // The composer is reachable by keyboard, so the depth has to be too.
    const user = userEvent.setup();
    setModels([GEMINI_FLASH]);

    render(<ControlledSelector />);
    await user.tab();
    expect(trigger()).toHaveFocus();

    await user.keyboard("{Enter}");
    // The menu opens on its first item, Auto.
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(trigger()).toHaveTextContent("High");
  });

  it("leaves the depth alone when the menu is dismissed", async () => {
    const user = userEvent.setup();
    setModels([GEMINI_FLASH]);

    render(<ControlledSelector />);
    await user.click(trigger());
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent("Low");
  });

  it("describes what each depth does", async () => {
    // The labels alone don't say what changes; the menu is where that fits.
    const user = userEvent.setup();
    setModels([GEMINI_FLASH]);

    renderSelector();
    await user.click(trigger());

    expect(option("Low")).toHaveTextContent(
      "As little reasoning as the model allows",
    );
    expect(option("High")).toHaveTextContent(
      "Reason as deeply as the model can",
    );
  });

  it("appears on Pro too, which reasons at every level", async () => {
    // Pro cannot skip reasoning, but it does honor all three levels, so the
    // control means something there.
    const user = userEvent.setup();
    setModels([{ ...GEMINI_FLASH, id: "gemini-3.1-pro-preview" }]);

    renderSelector();
    await user.click(trigger());

    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
  });

  it("shows Auto when no depth has been chosen", async () => {
    // Every untouched chat is here, so this is the label most users see first.
    const user = userEvent.setup();
    setModels([GEMINI_FLASH]);

    renderSelector({ value: null });
    expect(trigger()).toHaveTextContent("Auto");

    await user.click(trigger());

    expect(option("Auto")).toBeChecked();
    expect(option("Auto")).toHaveTextContent(
      "Let the model reason as it normally would",
    );
  });

  it("reports auto as null, not as a level", async () => {
    // Auto has to reach the row as null; any string would be stored as a depth
    // and start overriding what the model does on its own.
    const user = userEvent.setup();
    const onChange = vi.fn();
    setModels([GEMINI_FLASH]);

    renderSelector({ value: "high", onChange });
    await user.click(trigger());
    await user.click(option("Auto"));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it.each([
    ["a Gemini generation without thinking levels", "gemini-2.5-flash"],
    ["a non-thinking family", "gemma-4-31b-it"],
  ])("renders nothing for %s", (_label, modelId) => {
    setModels([{ ...GEMINI_FLASH, id: modelId }]);

    const { container } = renderSelector();

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a non-Gemini provider", () => {
    // A provider whose model name happens to look Gemini-shaped must not
    // acquire the control through the id alone.
    setModels([{ ...GEMINI_FLASH, provider: "openrouter" }]);

    const { container } = renderSelector();

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the model list is still loading", () => {
    mockUseLlmModels.mockReturnValue({ data: undefined });

    const { container } = renderSelector();

    expect(container).toBeEmptyDOMElement();
  });
});
