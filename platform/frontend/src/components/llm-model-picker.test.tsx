import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LlmModelPicker } from "./llm-model-picker";

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => (
    <img alt={alt} src={src} />
  ),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const mockModels = [
  {
    provider: "openai",
    model: "gpt-4o",
    pricePerMillionInput: "2.50",
    pricePerMillionOutput: "10.00",
  },
  {
    provider: "anthropic",
    model: "claude-3.5-sonnet",
    pricePerMillionInput: "3.00",
    pricePerMillionOutput: "15.00",
  },
];

describe("LlmModelPicker", () => {
  describe("single select mode", () => {
    it("renders dropdown with model options", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <LlmModelPicker
          value=""
          onValueChange={onValueChange}
          models={mockModels}
          editable
        />,
      );

      await user.click(screen.getByRole("combobox"));
      expect(screen.getByText("gpt-4o")).toBeInTheDocument();
      expect(screen.getByText("claude-3.5-sonnet")).toBeInTheDocument();
    });

    it("calls onValueChange when selecting a model", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <LlmModelPicker
          value=""
          onValueChange={onValueChange}
          models={mockModels}
          editable
        />,
      );

      await user.click(screen.getByRole("combobox"));
      await user.click(screen.getByText("gpt-4o"));

      expect(onValueChange).toHaveBeenCalledWith("gpt-4o");
    });

    it("auto-selects first model when autoSelectFirst is true", () => {
      const onValueChange = vi.fn();

      render(
        <LlmModelPicker
          value=""
          onValueChange={onValueChange}
          models={mockModels}
          editable
          autoSelectFirst
        />,
      );

      expect(onValueChange).toHaveBeenCalledWith("gpt-4o");
    });

    it("shows 'Add pricing' link when no models have pricing", () => {
      render(
        <LlmModelPicker
          value=""
          onValueChange={vi.fn()}
          models={[]}
          editable
        />,
      );

      expect(screen.getByText("Add pricing")).toHaveAttribute(
        "href",
        "/llm/providers/models",
      );
    });

    it("renders read-only badge in non-editable mode", () => {
      render(
        <LlmModelPicker
          value="gpt-4o"
          onValueChange={vi.fn()}
          models={mockModels}
          editable={false}
        />,
      );

      expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    });

    it("shows warning icon for model without pricing in read-only mode", () => {
      render(
        <LlmModelPicker
          value="unknown-model"
          onValueChange={vi.fn()}
          models={mockModels}
          editable={false}
        />,
      );

      expect(screen.getByText("unknown-model")).toBeInTheDocument();
      expect(document.querySelector("svg")).toBeInTheDocument();
    });
  });

  describe("multi select mode", () => {
    it("renders dropdown with multiple model options", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <LlmModelPicker
          multiple
          value={[]}
          onValueChange={onValueChange}
          models={mockModels}
          editable
        />,
      );

      await user.click(screen.getByRole("combobox"));
      expect(screen.getByText("gpt-4o")).toBeInTheDocument();
      expect(screen.getByText("claude-3.5-sonnet")).toBeInTheDocument();
    });

    it("calls onValueChange with multiple selected models", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <LlmModelPicker
          multiple
          value={[]}
          onValueChange={onValueChange}
          models={mockModels}
          editable
        />,
      );

      await user.click(screen.getByRole("combobox"));
      await user.click(screen.getByText("gpt-4o"));

      expect(onValueChange).toHaveBeenCalledWith(["gpt-4o"]);
    });

    it("renders read-only badges for multiple selected models", () => {
      render(
        <LlmModelPicker
          multiple
          value={["gpt-4o", "claude-3.5-sonnet"]}
          onValueChange={vi.fn()}
          models={mockModels}
          editable={false}
        />,
      );

      expect(screen.getByText("gpt-4o")).toBeInTheDocument();
      expect(screen.getByText("claude-3.5-sonnet")).toBeInTheDocument();
    });
  });

  describe("includeAllOption", () => {
    it("shows 'All models' option when includeAllOption is true", async () => {
      const user = userEvent.setup();

      render(
        <LlmModelPicker
          multiple
          value={[]}
          onValueChange={vi.fn()}
          models={mockModels}
          editable
          includeAllOption
        />,
      );

      await user.click(screen.getByRole("combobox"));
      expect(screen.getByText("All models")).toBeInTheDocument();
    });

    it("selecting 'All models' clears other selections", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <LlmModelPicker
          multiple
          value={["gpt-4o"]}
          onValueChange={onValueChange}
          models={mockModels}
          editable
          includeAllOption
        />,
      );

      await user.click(screen.getByRole("combobox"));
      await user.click(screen.getByText("All models"));

      expect(onValueChange).toHaveBeenCalledWith(["all"]);
    });

    it("selecting a model while 'All models' is selected replaces 'all' with the model", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <LlmModelPicker
          multiple
          value={["all"]}
          onValueChange={onValueChange}
          models={mockModels}
          editable
          includeAllOption
        />,
      );

      await user.click(screen.getByRole("combobox"));
      await user.click(screen.getByText("claude-3.5-sonnet"));

      expect(onValueChange).toHaveBeenCalledWith(["claude-3.5-sonnet"]);
    });

    it("allows selecting multiple models after deselecting 'All models'", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      const { rerender } = render(
        <LlmModelPicker
          multiple
          value={["all"]}
          onValueChange={onValueChange}
          models={mockModels}
          editable
          includeAllOption
        />,
      );

      await user.click(screen.getByRole("combobox"));
      await user.click(screen.getByText("gpt-4o"));

      expect(onValueChange).toHaveBeenCalledWith(["gpt-4o"]);

      rerender(
        <LlmModelPicker
          multiple
          value={["gpt-4o"]}
          onValueChange={onValueChange}
          models={mockModels}
          editable
          includeAllOption
        />,
      );

      await user.click(screen.getByText("claude-3.5-sonnet"));
      expect(onValueChange).toHaveBeenLastCalledWith([
        "gpt-4o",
        "claude-3.5-sonnet",
      ]);
    });

    it("does not interfere with normal multi-select when includeAllOption is false", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <LlmModelPicker
          multiple
          value={[]}
          onValueChange={onValueChange}
          models={mockModels}
          editable
        />,
      );

      await user.click(screen.getByRole("combobox"));
      await user.click(screen.getByText("gpt-4o"));

      expect(onValueChange).toHaveBeenCalledWith(["gpt-4o"]);
    });
  });

  describe("sorting", () => {
    it("sorts models by price ascending", async () => {
      const user = userEvent.setup();

      render(
        <LlmModelPicker
          value=""
          onValueChange={vi.fn()}
          models={mockModels}
          editable
          sortDirection="asc"
        />,
      );

      await user.click(screen.getByRole("combobox"));
      const options = screen.getAllByText(/gpt-4o|claude-3.5-sonnet/);
      expect(options[0]).toHaveTextContent("gpt-4o");
    });

    it("sorts models by price descending", async () => {
      const user = userEvent.setup();

      render(
        <LlmModelPicker
          value=""
          onValueChange={vi.fn()}
          models={mockModels}
          editable
          sortDirection="desc"
        />,
      );

      await user.click(screen.getByRole("combobox"));
      const options = screen.getAllByText(/gpt-4o|claude-3.5-sonnet/);
      expect(options[0]).toHaveTextContent("claude-3.5-sonnet");
    });
  });

  describe("maxSelected", () => {
    it("respects maxSelected limit", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <LlmModelPicker
          multiple
          value={["gpt-4o"]}
          onValueChange={onValueChange}
          models={mockModels}
          editable
          maxSelected={1}
        />,
      );

      await user.click(screen.getByRole("combobox"));
      await user.click(screen.getByText("claude-3.5-sonnet"));

      expect(onValueChange).not.toHaveBeenCalled();
    });
  });
});
