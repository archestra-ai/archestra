import {
  OPENROUTER_AUTO_MODEL_ID,
  OPENROUTER_FREE_MODEL_ID,
} from "@archestra/shared";
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

  it("renders a Free badge for zero-cost models", async () => {
    const user = userEvent.setup();
    render(
      <LlmModelSearchableSelect
        value=""
        onValueChange={vi.fn()}
        options={[
          {
            value: "free-1",
            model: "free-model",
            provider: "openrouter",
            isFree: true,
          },
          { value: "paid-1", model: "paid-model", provider: "openai" },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByText("Free")).toBeInTheDocument();
  });

  it("filters to free models when 'Free only' is enabled", async () => {
    const user = userEvent.setup();
    render(
      <LlmModelSearchableSelect
        value=""
        onValueChange={vi.fn()}
        freeFilterable
        options={[
          {
            value: "free-1",
            model: "free-model",
            provider: "openrouter",
            isFree: true,
          },
          { value: "paid-1", model: "paid-model", provider: "openai" },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByText("paid-model")).toBeInTheDocument();
    expect(screen.getByText("free-model")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.click(screen.getByLabelText("Free models only"));
    await user.click(screen.getByRole("combobox"));

    expect(screen.queryByText("paid-model")).not.toBeInTheDocument();
    expect(screen.getByText("free-model")).toBeInTheDocument();
  });

  it("renders the unified Free badge for the OpenRouter free router", async () => {
    const user = userEvent.setup();
    render(
      <LlmModelSearchableSelect
        value=""
        onValueChange={vi.fn()}
        options={[
          {
            value: OPENROUTER_FREE_MODEL_ID,
            model: OPENROUTER_FREE_MODEL_ID,
            provider: "openrouter",
            isFree: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByText("Free")).toBeInTheDocument();
  });

  it("renders a Latest badge for OpenRouter ~latest aliases", async () => {
    const user = userEvent.setup();
    render(
      <LlmModelSearchableSelect
        value=""
        onValueChange={vi.fn()}
        options={[
          {
            value: "alias",
            model: "~anthropic/claude-sonnet-latest",
            provider: "openrouter",
          },
          {
            value: "pinned",
            model: "anthropic/claude-sonnet-4.6",
            provider: "openrouter",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByText("Latest")).toBeInTheDocument();
  });

  it("pins the routers to the top of the list", async () => {
    const user = userEvent.setup();
    render(
      <LlmModelSearchableSelect
        value=""
        onValueChange={vi.fn()}
        options={[
          { value: "a", model: "aaa/model", provider: "openrouter" },
          {
            value: OPENROUTER_AUTO_MODEL_ID,
            model: OPENROUTER_AUTO_MODEL_ID,
            provider: "openrouter",
          },
          {
            value: OPENROUTER_FREE_MODEL_ID,
            model: OPENROUTER_FREE_MODEL_ID,
            provider: "openrouter",
            isFree: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    const free = screen.getByText(OPENROUTER_FREE_MODEL_ID);
    const auto = screen.getByText(OPENROUTER_AUTO_MODEL_ID);
    const other = screen.getByText("aaa/model");
    // The free router precedes the auto router, which precedes everything else.
    expect(
      free.compareDocumentPosition(auto) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      auto.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("orders recommended models above the rest", async () => {
    const user = userEvent.setup();
    render(
      <LlmModelSearchableSelect
        value=""
        onValueChange={vi.fn()}
        options={[
          { value: "z", model: "zzz/model", provider: "openrouter" },
          {
            value: "best",
            model: "best/model",
            provider: "openrouter",
            isBest: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    const best = screen.getByText("best/model");
    const rest = screen.getByText("zzz/model");
    expect(
      best.compareDocumentPosition(rest) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("detects the free router by modelId when the label is a display name", async () => {
    const user = userEvent.setup();
    render(
      <LlmModelSearchableSelect
        value=""
        onValueChange={vi.fn()}
        options={[
          {
            value: "models-table-uuid",
            model: "Free Models Router",
            modelId: OPENROUTER_FREE_MODEL_ID,
            provider: "openrouter",
            isFree: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByText("Free")).toBeInTheDocument();
  });
});
