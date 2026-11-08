import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderGroupedModelSelect } from "@/components/provider-grouped-model-select";
import { useOrganization } from "@/lib/organization.query";

vi.mock("@/lib/organization.query");

beforeAll(() => {
  // cmdk scrolls the highlighted row into view; jsdom has no layout.
  Element.prototype.scrollIntoView = () => {};
});

// No organization data means no provider overrides: built-in labels.
beforeEach(() => {
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
});

const MODELS = [
  { value: "openai:gpt-5.4", provider: "openai", modelId: "gpt-5.4" },
  {
    value: "gemini:gemini-2.5-flash",
    provider: "gemini",
    modelId: "gemini-2.5-flash",
  },
  { value: "openai:gpt-5-mini", provider: "openai", modelId: "gpt-5-mini" },
  {
    value: "bedrock:amazon.nova-lite-v1:0",
    provider: "bedrock",
    modelId: "amazon.nova-lite-v1:0",
  },
] as const;

const POOLS = [{ value: "pool:fast", name: "fast", description: "Cheap" }];

function renderPicker(value: string) {
  const onValueChange = vi.fn();
  const view = render(
    <ProviderGroupedModelSelect
      id="model"
      value={value}
      onValueChange={onValueChange}
      models={[...MODELS]}
      pools={POOLS}
      placeholder="Pick a model"
    />,
  );
  return { ...view, onValueChange };
}

const headings = () =>
  [...document.querySelectorAll("[cmdk-group-heading]")].map(
    (heading) => heading.textContent,
  );
const optionNames = () =>
  screen.getAllByRole("option").map((option) => option.textContent);

describe("ProviderGroupedModelSelect", () => {
  it("lists pools first, then models under their provider without the prefix", async () => {
    const user = userEvent.setup();
    renderPicker("openai:gpt-5.4");

    await user.click(screen.getByRole("combobox"));

    expect(headings()).toEqual([
      "Model pools",
      "OpenAI",
      "Gemini",
      "AWS Bedrock",
    ]);
    expect(optionNames()).toEqual([
      "fastCheap",
      "gpt-5.4",
      "gpt-5-mini",
      "gemini-2.5-flash",
      "amazon.nova-lite-v1:0",
    ]);
  });

  it("shows the model id but emits the full value", async () => {
    const user = userEvent.setup();
    const { onValueChange } = renderPicker("openai:gpt-5.4");

    expect(screen.getByRole("combobox")).toHaveTextContent(/^gpt-5\.4$/);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "gemini-2.5-flash" }));

    expect(onValueChange).toHaveBeenCalledWith("gemini:gemini-2.5-flash");
  });

  it("finds a provider's models by its name, not only its id", async () => {
    const user = userEvent.setup();
    renderPicker("openai:gpt-5.4");

    await user.click(screen.getByRole("combobox"));
    // "AWS" is in the provider's label but in no model value.
    await user.type(screen.getByPlaceholderText("Search models…"), "AWS");

    expect(optionNames()).toEqual(["amazon.nova-lite-v1:0"]);
  });

  it("opens on the current choice", async () => {
    const user = userEvent.setup();
    renderPicker("openai:gpt-5-mini");

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByRole("option", { name: "gpt-5-mini" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
