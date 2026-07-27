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

  it("adds or replaces a provider mapping as soon as a key is selected", async () => {
    const user = userEvent.setup();
    renderField({ openai: "openai-production" });

    expect(screen.getByText("OpenAI production")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /select a provider key/i }),
    );
    await user.click(screen.getByRole("option", { name: /openai staging/i }));

    expect(screen.getByText("OpenAI staging")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI production")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /select a provider key/i }),
    );
    await user.click(
      screen.getByRole("option", { name: /anthropic production/i }),
    );

    expect(screen.getByText("OpenAI staging")).toBeInTheDocument();
    expect(screen.getByText("Anthropic production")).toBeInTheDocument();
  });

  it("removes a configured provider mapping", async () => {
    const user = userEvent.setup();
    renderField({ openai: "openai-production" });

    await user.click(screen.getByRole("button", { name: "Remove OpenAI key" }));

    expect(
      screen.getByText("No provider keys configured."),
    ).toBeInTheDocument();
  });
});

function renderField(initialMappings: ProviderApiKeyMap = {}) {
  function ControlledField() {
    const [mappings, setMappings] =
      useState<ProviderApiKeyMap>(initialMappings);

    return (
      <ProviderKeyMappingsField
        providerApiKeyIds={mappings}
        onProviderApiKeyIdsChange={setMappings}
        providerApiKeys={providerApiKeys}
      />
    );
  }

  return render(<ControlledField />);
}
