import {
  E2eTestId,
  getSubscriptionPickerOptionTestId,
} from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import { LlmProviderApiKeyDropdown } from "./llm-provider-api-key-dropdown";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

global.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};
Element.prototype.scrollIntoView = vi.fn();

describe("LlmProviderApiKeyDropdown", () => {
  beforeEach(() => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as ReturnType<typeof useSession>);
  });

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

  describe("subscriptions group", () => {
    it("lists all three subscriptions above the API keys, with sign-in when unconnected", async () => {
      const user = userEvent.setup();

      renderDropdown({
        availableKeys: [
          {
            id: "key-1",
            name: "Prod key",
            provider: "anthropic",
            scope: "org",
            teamName: null,
          },
        ] as LlmProviderApiKey[],
        selectedApiKeyId: null,
        onSelectKey: () => {},
        triggerVariant: "button",
        showSubscriptions: true,
      });

      await user.click(
        screen.getByRole("button", { name: /select provider key/i }),
      );

      for (const provider of [
        "github-copilot",
        "microsoft-365-copilot",
        "openai",
      ]) {
        expect(
          screen.getByTestId(getSubscriptionPickerOptionTestId(provider)),
        ).toHaveTextContent("Sign in");
      }

      // Subscriptions lead the list; the pasted key follows.
      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(4);
      expect(options[3]).toHaveTextContent("Prod key");

      // Both credential types explain their semantics at the selection point:
      // subscriptions resolve per user, API keys are one shared credential.
      expect(
        screen.getByText(/each person signs in with their own plan/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/everyone it's shared with uses the same credential/i),
      ).toBeInTheDocument();
    });

    it("selects the backing key instead of signing in when already connected", async () => {
      const user = userEvent.setup();
      const onSelectKey = vi.fn();

      renderDropdown({
        availableKeys: [
          {
            id: "copilot-key",
            name: "GitHub Copilot",
            provider: "github-copilot",
            scope: "personal",
            userId: "user-1",
            teamName: null,
          },
        ] as LlmProviderApiKey[],
        selectedApiKeyId: null,
        onSelectKey,
        triggerVariant: "button",
        showSubscriptions: true,
      });

      await user.click(
        screen.getByRole("button", { name: /select provider key/i }),
      );

      const row = screen.getByTestId(
        getSubscriptionPickerOptionTestId("github-copilot"),
      );
      expect(row).toHaveTextContent("Your account");
      expect(row).not.toHaveTextContent("Sign in");

      await user.click(row);
      expect(onSelectKey).toHaveBeenCalledWith("copilot-key");
    });

    it("keeps a subscription-shaped key visible when no subscription entry backs it", async () => {
      const user = userEvent.setup();

      // An org-scoped ChatGPT-subscription key: it looks like a subscription but
      // `useSubscriptions` only surfaces the viewer's own personal one, so no
      // Subscriptions row represents it. It must stay in the OpenAI group rather
      // than being stripped with nowhere to select it.
      renderDropdown({
        availableKeys: [
          {
            id: "org-chatgpt",
            name: "Shared ChatGPT",
            provider: "openai",
            scope: "org",
            userId: null,
            isChatgptSubscription: true,
            teamName: null,
          },
        ] as LlmProviderApiKey[],
        selectedApiKeyId: "org-chatgpt",
        onSelectKey: () => {},
        triggerVariant: "button",
        showSubscriptions: true,
      });

      await user.click(screen.getByRole("button", { name: /shared chatgpt/i }));

      expect(
        screen.getByRole("option", { name: /shared chatgpt/i }),
      ).toBeInTheDocument();
      // The ChatGPT subscription row still offers sign-in — the org key does not
      // back the viewer's personal subscription.
      expect(
        screen.getByTestId(getSubscriptionPickerOptionTestId("openai")),
      ).toHaveTextContent("Sign in");
    });

    it("does not repeat a connected subscription in the provider groups", async () => {
      const user = userEvent.setup();

      renderDropdown({
        availableKeys: [
          {
            id: "copilot-key",
            name: "GitHub Copilot",
            provider: "github-copilot",
            scope: "personal",
            userId: "user-1",
            teamName: null,
          },
        ] as LlmProviderApiKey[],
        selectedApiKeyId: null,
        onSelectKey: () => {},
        triggerVariant: "button",
        showSubscriptions: true,
      });

      await user.click(
        screen.getByRole("button", { name: /select provider key/i }),
      );

      // Three subscription rows and nothing else — the key backs one of them.
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });
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
