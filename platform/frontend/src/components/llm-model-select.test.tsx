import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LlmModelSearchableSelect } from "./llm-model-select";

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => (
    <img alt={alt} src={src} />
  ),
}));

describe("LlmModelSearchableSelect", () => {
  it("can render fit-content dropdown content with full option labels", async () => {
    const user = userEvent.setup();
    const modelName =
      "gemini-2.5-pro-preview-05-06-very-long-model-name-for-reranking";

    render(
      <LlmModelSearchableSelect
        value=""
        onValueChange={vi.fn()}
        options={[
          {
            value: "gemini-2.5-pro-preview-05-06",
            model: modelName,
            provider: "gemini",
          },
        ]}
        popoverContentClassName="w-max min-w-[var(--radix-popover-trigger-width)] max-w-[min(32rem,calc(100vw-2rem))]"
        truncateOptionLabels={false}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(
      screen
        .getByPlaceholderText("Search models...")
        .closest("[data-slot='popover-content']"),
    ).toHaveClass(
      "w-max",
      "min-w-[var(--radix-popover-trigger-width)]",
      "max-w-[min(32rem,calc(100vw-2rem))]",
    );
    expect(screen.getByText(modelName)).toHaveClass(
      "whitespace-normal",
      "break-words",
    );
    expect(screen.getByText(modelName)).not.toHaveClass("truncate");
  });
});
