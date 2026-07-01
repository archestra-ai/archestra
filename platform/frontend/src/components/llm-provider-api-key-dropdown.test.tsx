import { E2eTestId } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import { LlmProviderApiKeyDropdown } from "./llm-provider-api-key-dropdown";

global.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};
Element.prototype.scrollIntoView = vi.fn();

describe("LlmProviderApiKeyDropdown", () => {
  it("renders chat selector test ids and provider groups", async () => {
    const user = userEvent.setup();

    renderDropdown({
      availableKeys: [
        {
          id: "key-1",
          name: "OpenAI key",
          provider: "openai",
          scope: "personal",
          teamName: null,
        } as LlmProviderApiKey,
      ],
      selectedApiKeyId: "key-1",
      onSelectKey: () => {},
      showChatTestIds: true,
    });

    await user.click(screen.getByTestId(E2eTestId.ChatApiKeySelectorTrigger));

    expect(
      screen.getByTestId(E2eTestId.ChatApiKeySelectorSearchInput),
    ).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("OpenAI key")).toBeInTheDocument();
  });

  it("supports selecting organization default", async () => {
    const user = userEvent.setup();
    const onSelectOrganizationDefault = vi.fn();

    renderDropdown({
      availableKeys: [],
      selectedApiKeyId: null,
      onSelectKey: () => {},
      triggerVariant: "button",
      allowOrganizationDefault: true,
      organizationDefaultSelected: true,
      onSelectOrganizationDefault,
    });

    await user.click(
      screen.getByRole("button", { name: /organization default/i }),
    );
    await user.click(
      screen.getByRole("option", { name: /organization default/i }),
    );

    expect(onSelectOrganizationDefault).toHaveBeenCalledTimes(1);
  });
});

function renderDropdown(
  props: Omit<
    ComponentProps<typeof LlmProviderApiKeyDropdown>,
    "open" | "onOpenChange"
  >,
) {
  function ControlledDropdown() {
    const [open, setOpen] = useState(false);
    return (
      <LlmProviderApiKeyDropdown
        {...props}
        open={open}
        onOpenChange={setOpen}
      />
    );
  }

  return render(<ControlledDropdown />);
}
