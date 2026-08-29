import { E2eTestId } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { LlmProviderApiKeyDropdown } from "./llm-provider-api-key-dropdown";

global.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};
Element.prototype.scrollIntoView = vi.fn();

vi.mock("@/lib/organization.query");

beforeEach(() => {
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
});

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

  it("highlights only one row when keys share the same name", async () => {
    const user = userEvent.setup();

    renderDropdown({
      availableKeys: [
        {
          id: "key-1",
          name: "Anthropic",
          provider: "anthropic",
          scope: "personal",
          teamName: null,
        },
        {
          id: "key-2",
          name: "Anthropic",
          provider: "anthropic",
          scope: "personal",
          teamName: null,
        },
      ] as LlmProviderApiKey[],
      selectedApiKeyId: "key-2",
      onSelectKey: () => {},
      triggerVariant: "button",
    });

    await user.click(screen.getByRole("button", { name: /anthropic/i }));

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(
      options.filter(
        (option) => option.getAttribute("aria-selected") === "true",
      ),
    ).toHaveLength(1);
  });

  it("filters keys by name via search", async () => {
    const user = userEvent.setup();

    renderDropdown({
      availableKeys: [
        {
          id: "key-1",
          name: "Prod key",
          provider: "anthropic",
          scope: "personal",
          teamName: null,
        },
        {
          id: "key-2",
          name: "Staging key",
          provider: "openai",
          scope: "personal",
          teamName: null,
        },
      ] as LlmProviderApiKey[],
      selectedApiKeyId: null,
      onSelectKey: () => {},
      triggerVariant: "button",
      showChatTestIds: true,
    });

    await user.click(
      screen.getByRole("button", { name: /select provider key/i }),
    );
    await user.type(
      screen.getByTestId(E2eTestId.ChatApiKeySelectorSearchInput),
      "Staging",
    );

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Staging key");
  });

  it("offers provider-key creation inside the selector", async () => {
    const user = userEvent.setup();
    const onAddApiKey = vi.fn();

    renderDropdown({
      availableKeys: [],
      selectedApiKeyId: null,
      onSelectKey: () => {},
      onAddApiKey,
      triggerVariant: "button",
    });

    await user.click(
      screen.getByRole("button", { name: /select provider key/i }),
    );
    await user.click(screen.getByRole("option", { name: "Add provider key" }));

    expect(onAddApiKey).toHaveBeenCalledOnce();
  });

  it("places provider-key creation at the top of the API keys section", async () => {
    const user = userEvent.setup();

    renderDropdown({
      availableKeys: [
        {
          id: "chatgpt-subscription",
          name: "ChatGPT Subscription",
          provider: "openai",
          scope: "personal",
          subscriptionKind: "chatgpt",
        },
        {
          id: "openai-key",
          name: "OpenAI production",
          provider: "openai",
          scope: "org",
        },
      ] as LlmProviderApiKey[],
      selectedApiKeyId: null,
      onSelectKey: () => {},
      onAddApiKey: () => {},
      triggerVariant: "button",
    });

    await user.click(
      screen.getByRole("button", { name: /select provider key/i }),
    );

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("ChatGPT Subscription"),
      "Add provider key",
      expect.stringContaining("OpenAI production"),
    ]);
  });

  it("separates personal subscriptions from API keys", async () => {
    const user = userEvent.setup();

    renderDropdown({
      availableKeys: [
        {
          id: "chatgpt-subscription",
          name: "ChatGPT Subscription",
          provider: "openai",
          scope: "personal",
          subscriptionKind: "chatgpt",
        },
        {
          id: "github-copilot",
          name: "GitHub Copilot",
          provider: "github-copilot",
          scope: "personal",
        },
        {
          id: "x-premium-subscription",
          name: "SuperGrok",
          provider: "xai",
          scope: "personal",
          subscriptionKind: "x-premium",
        },
        {
          id: "openai-key",
          name: "OpenAI production",
          provider: "openai",
          scope: "org",
          subscriptionKind: null,
        },
        {
          id: "xai-key",
          name: "xAI production",
          provider: "xai",
          scope: "org",
        },
      ] as LlmProviderApiKey[],
      selectedApiKeyId: "chatgpt-subscription",
      onSelectKey: () => {},
      triggerVariant: "button",
    });

    expect(screen.getByRole("button")).toHaveTextContent("Per-user");

    await user.click(screen.getByRole("button"));

    expect(screen.getByText("Personal subscriptions")).toBeInTheDocument();
    expect(
      screen.getByText("Each user connects their own account"),
    ).toBeInTheDocument();
    expect(screen.getByText("API keys")).toBeInTheDocument();
    expect(screen.getAllByText("Per-user")).toHaveLength(4);
    expect(
      screen.getByRole("option", { name: /supergrok/i }),
    ).toHaveTextContent("Per-user");
    expect(
      screen.getByRole("option", { name: /openai production/i }),
    ).not.toHaveTextContent("Per-user");
    expect(
      screen.getByRole("option", { name: /xai production/i }),
    ).not.toHaveTextContent("Per-user");
  });

  it("groups an unconnected SuperGrok entry under personal subscriptions", async () => {
    const user = userEvent.setup();

    renderDropdown({
      availableKeys: [
        {
          id: "connect-subscription-x-premium",
          name: "SuperGrok",
          provider: "xai",
          scope: "personal",
          subscriptionKind: "x-premium",
          connectRequired: true,
        },
      ],
      selectedApiKeyId: null,
      onSelectKey: () => {},
      triggerVariant: "button",
    });

    await user.click(
      screen.getByRole("button", { name: /select provider key/i }),
    );

    expect(screen.getByText("Personal subscriptions")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /supergrok.*connect/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("API keys")).not.toBeInTheDocument();
  });

  it("labels unconnected subscription options as connect actions", async () => {
    const user = userEvent.setup();

    renderDropdown({
      availableKeys: [
        {
          id: "connect-subscription-github-copilot",
          name: "GitHub Copilot",
          provider: "github-copilot",
          scope: "personal",
          connectRequired: true,
        },
      ],
      selectedApiKeyId: null,
      onSelectKey: () => {},
      triggerVariant: "button",
    });

    await user.click(
      screen.getByRole("button", { name: /select provider key/i }),
    );

    expect(
      screen.getByRole("option", { name: /github copilot.*connect/i }),
    ).toBeInTheDocument();
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
