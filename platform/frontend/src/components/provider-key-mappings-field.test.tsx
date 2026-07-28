import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import {
  type ProviderApiKeyMap,
  ProviderKeyMappingsField,
} from "@/components/provider-key-mappings-field";

global.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};
Element.prototype.scrollIntoView = vi.fn();

const providerApiKeys = [
  {
    id: "openai-production",
    name: "OpenAI production",
    provider: "openai",
    scope: "org",
  },
  {
    id: "openai-staging",
    name: "OpenAI staging",
    provider: "openai",
    scope: "team",
    teamName: "Platform",
  },
  {
    id: "anthropic-production",
    name: "Anthropic production",
    provider: "anthropic",
    scope: "personal",
  },
] as LlmProviderApiKeyResponse[];

describe("ProviderKeyMappingsField", () => {
  it("groups searchable provider keys in one picker", async () => {
    const user = userEvent.setup();
    renderField();

    expect(
      screen.queryByRole("button", { name: /^add$/i }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /select a provider key/i }),
    );

    const picker = screen.getByRole("listbox");
    expect(within(picker).getByText("OpenAI")).toBeInTheDocument();
    expect(within(picker).getByText("Anthropic")).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Search provider keys..."),
      "staging",
    );

    expect(
      screen.getByRole("option", { name: /openai staging/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /anthropic production/i }),
    ).not.toBeInTheDocument();
  });

  it("does not offer another key for a configured provider", async () => {
    const user = userEvent.setup();
    renderField({ openai: "openai-production" });

    expect(screen.getByText("OpenAI production")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /select a provider key/i }),
    );
    expect(
      screen.queryByRole("option", { name: /openai staging/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /openai production/i }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("option", { name: /anthropic production/i }),
    );

    expect(screen.getByText("OpenAI production")).toBeInTheDocument();
    expect(screen.getByText("Anthropic production")).toBeInTheDocument();
  });

  it("removes a configured provider mapping", async () => {
    const user = userEvent.setup();
    renderField({ openai: "openai-production" });

    await user.click(screen.getByRole("button", { name: "Remove OpenAI key" }));

    expect(screen.getByText("No provider keys added")).toBeInTheDocument();
    expect(
      screen.getByText("Map this virtual API key to a real provider API key."),
    ).toBeInTheDocument();
  });

  it("explains when no provider keys are available", () => {
    renderField({}, []);

    expect(screen.getAllByText("No provider keys available")).toHaveLength(2);
    expect(
      screen.getByText("Create a provider API key first."),
    ).toBeInTheDocument();
  });
});

function renderField(
  initialMappings: ProviderApiKeyMap = {},
  availableKeys = providerApiKeys,
) {
  function ControlledField() {
    const [mappings, setMappings] =
      useState<ProviderApiKeyMap>(initialMappings);

    return (
      <ProviderKeyMappingsField
        providerApiKeyIds={mappings}
        onProviderApiKeyIdsChange={setMappings}
        providerApiKeys={availableKeys}
      />
    );
  }

  return render(<ControlledField />);
}
