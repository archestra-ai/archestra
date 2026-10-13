import { defaultRuntimeHandoffInstructions } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/llm-provider-api-keys.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/integration-overrides", () => ({
  useModelProviderCatalog: () => ({
    label: (provider: string) => provider,
    visibleIds: [],
  }),
}));
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/llm-models.query", () => ({
  useModelsWithApiKeys: () => ({ data: [], isPending: false }),
}));
vi.mock("@/components/agent-selector", () => ({
  AgentSelector: ({ agents }: { agents: { id: string; name: string }[] }) => (
    <ul aria-label="Default MCP Gateway options">
      {agents.map((agent) => (
        <li key={agent.id}>{agent.name}</li>
      ))}
    </ul>
  ),
}));
vi.mock("@/components/roles/with-permissions", () => ({
  WithPermissions: ({
    children,
  }: {
    children: (props: { hasPermission: boolean }) => ReactNode;
  }) => children({ hasPermission: true }),
}));
vi.mock("@/components/settings/settings-block", () => ({
  SettingsBlock: ({
    title,
    description,
    control,
    children,
  }: {
    title: string;
    description: ReactNode;
    control: ReactNode;
    children?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      {control}
      {children}
    </section>
  ),
  SettingsSectionStack: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  SettingsSaveBar: ({
    hasChanges,
    onSave,
    onCancel,
  }: {
    hasChanges: boolean;
    onSave: () => void;
    onCancel: () => void;
  }) => (
    <>
      <button type="button" disabled={!hasChanges} onClick={onSave}>
        Save
      </button>
      <button type="button" disabled={!hasChanges} onClick={onCancel}>
        Discard
      </button>
    </>
  ),
}));

import { useProfiles } from "@/lib/agent.query";
import { useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useAppearanceSettings,
  useOrganization,
  useUpdateConnectionSettings,
} from "@/lib/organization.query";
import { ConnectionSettingsForm } from "./connection-settings-form";

// jsdom doesn't implement scrollIntoView, which the Add back command list calls.
Element.prototype.scrollIntoView = vi.fn();

const mutate = vi.fn();
const APP_NAME = "Acme";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useOrganization).mockReturnValue({
    data: {
      connectionDefaultMcpGatewayId: null,
      connectionDefaultClientId: null,
      connectionShownClientIds: null,
      connectionBaseUrls: null,
      connectionClientProviderKeys: null,
      connectionSkillsEnabled: true,
      connectionLlmProxyEnabled: true,
      connectionPluginsEnabled: true,
    },
  } as ReturnType<typeof useOrganization>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: { appName: APP_NAME },
  } as unknown as ReturnType<typeof useAppearanceSettings>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "admin" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useProfiles).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useProfiles>);
  vi.mocked(useLlmProviderApiKeys).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useLlmProviderApiKeys>);
  vi.mocked(useUpdateConnectionSettings).mockReturnValue({
    mutate,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateConnectionSettings>);
});

describe("ConnectionSettingsForm", () => {
  it("reorders with the handle, saves through settings, and restores that order after reload", async () => {
    const user = userEvent.setup();
    const view = render(<ConnectionSettingsForm />);
    const handles = () =>
      within(agentList()).getAllByRole("button", { name: /^Reorder / });
    const [firstName, secondName] = agentOrder();
    handles()[1].focus();
    await user.keyboard("{ArrowUp}");
    expect(agentOrder().slice(0, 2)).toEqual([secondName, firstName]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const saved = mutate.mock.lastCall?.[0];
    expect(saved.connectionClientOrder.slice(0, 2)).toEqual([
      "cursor",
      "claude-code",
    ]);
    expect(saved.connectionShownClientIds).toBeNull();

    view.unmount();
    const organization = vi.mocked(useOrganization)();
    vi.mocked(useOrganization).mockReturnValue({
      ...organization,
      data: { ...organization.data, ...saved },
    } as ReturnType<typeof useOrganization>);
    render(<ConnectionSettingsForm />);
    expect(agentOrder().slice(0, 2)).toEqual([secondName, firstName]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    handles()[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(agentOrder().slice(0, 2)).toEqual([firstName, secondName]);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(agentOrder().slice(0, 2)).toEqual([secondName, firstName]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("folds a removed agent into the hidden footer and adds it back at the end", async () => {
    const user = userEvent.setup();
    render(<ConnectionSettingsForm />);
    expect(
      screen.queryByRole("button", { name: "Add an agent back to Connect" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Remove Codex from Connect" }),
    );
    expect(agentOrder()).not.toContain("Codex");
    expect(screen.getByText("1 hidden")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Add an agent back to Connect" }),
    );
    await user.click(screen.getByRole("option", { name: /Codex$/ }));
    expect(agentOrder().at(-1)).toBe("Codex");
    expect(
      screen.queryByRole("button", { name: "Add an agent back to Connect" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    const saved = mutate.mock.lastCall?.[0];
    expect(saved.connectionShownClientIds).toBeNull();
    expect(saved.connectionClientOrder.at(-1)).toBe("codex");
  });

  it("adds a hidden agent at the end, removes it, and discards back to the saved list", async () => {
    const user = userEvent.setup();
    const organization = vi.mocked(useOrganization)();
    vi.mocked(useOrganization).mockReturnValue({
      ...organization,
      data: {
        ...organization.data,
        connectionShownClientIds: ["codex"],
        connectionClientOrder: ["codex"],
      },
    } as ReturnType<typeof useOrganization>);
    render(<ConnectionSettingsForm />);
    const addBack = () =>
      screen.getByRole("button", { name: "Add an agent back to Connect" });
    await user.click(addBack());
    await user.click(screen.getByRole("option", { name: /Cursor$/ }));
    expect(agentOrder()).toEqual(["Codex", "Cursor"]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionShownClientIds: ["codex", "cursor"],
        connectionClientOrder: ["codex", "cursor"],
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Remove Codex from Connect" }),
    );
    expect(agentOrder()).toEqual(["Cursor"]);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(agentOrder()).toEqual(["Codex"]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Remove Codex from Connect" }),
    );
    expect(
      screen.getByText("No agents on Connect. Add one back below."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionShownClientIds: [],
        connectionClientOrder: [],
      }),
    );
    await user.click(addBack());
    await user.click(screen.getByRole("option", { name: /Codex$/ }));
    expect(agentOrder()).toEqual(["Codex"]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("preserves instructions when toggled and allows disabling an empty draft", async () => {
    const user = userEvent.setup();
    render(<ConnectionSettingsForm />);
    const editor = screen.getByRole("textbox", {
      name: "Instructions for connected agents",
    });
    expect(editor).toBeVisible();
    expect(editor).toBeEnabled();
    expect(editor).toHaveValue(defaultRuntimeHandoffInstructions(APP_NAME));
    const toggle = screen.getByRole("switch", {
      name: "Enable instructions for connected agents",
    });
    expect(toggle).toBeChecked();
    // The untouched default saves as null, so it keeps following the default.
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionRuntimeHandoffEnabled: false,
        connectionRuntimeHandoffInstructions: null,
      }),
    );
    await user.click(toggle);
    await user.clear(editor);
    await user.type(editor, "Offer overnight work.");
    await user.click(toggle);
    expect(editor).toBeDisabled();
    expect(editor).toHaveValue("Offer overnight work.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionRuntimeHandoffEnabled: false,
        connectionRuntimeHandoffInstructions: "Offer overnight work.",
      }),
    );
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionRuntimeHandoffEnabled: true,
        connectionRuntimeHandoffInstructions: "Offer overnight work.",
      }),
    );
    await user.clear(editor);
    mutate.mockClear();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeVisible();
    await user.click(toggle);
    expect(editor).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionRuntimeHandoffEnabled: false,
        connectionRuntimeHandoffInstructions: null,
      }),
    );
  });

  it("respects a saved disabled managed instructions setting", () => {
    const organization = vi.mocked(useOrganization)();
    vi.mocked(useOrganization).mockReturnValue({
      ...organization,
      data: {
        ...organization.data,
        connectionRuntimeHandoffEnabled: false,
      },
    } as ReturnType<typeof useOrganization>);
    render(<ConnectionSettingsForm />);
    expect(
      screen.getByRole("switch", {
        name: "Enable instructions for connected agents",
      }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("textbox", {
        name: "Instructions for connected agents",
      }),
    ).toBeDisabled();
  });

  it("omits the plugin setting and its PATCH field when plugins are unavailable", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockReturnValue(undefined);

    render(<ConnectionSettingsForm />);

    expect(
      screen.queryByRole("switch", {
        name: "Offer plugins on the Connect page",
      }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("switch", { name: "Offer skills on the Connect page" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mutate).toHaveBeenCalledWith(
      expect.not.objectContaining({
        connectionPluginsEnabled: expect.anything(),
      }),
    );
  });

  it("shows the plugin setting when the deployment enables plugins", () => {
    vi.mocked(useFeature).mockReturnValue(true);

    render(<ConnectionSettingsForm />);

    expect(
      screen.getByRole("switch", { name: "Offer plugins on the Connect page" }),
    ).toBeVisible();
  });

  it("does not overwrite unchanged feature settings when saving another field", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockReturnValue(true);

    render(<ConnectionSettingsForm />);
    await user.click(
      screen.getByRole("switch", { name: "Offer skills on the Connect page" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ connectionSkillsEnabled: false }),
    );
    expect(mutate).toHaveBeenCalledWith(
      expect.not.objectContaining({
        connectionLlmProxyEnabled: expect.anything(),
        connectionPluginsEnabled: expect.anything(),
        connectionClientOrder: expect.anything(),
      }),
    );
  });

  it("maps provider keys to one client's setup command and leaves the others on users' own keys", async () => {
    vi.mocked(useLlmProviderApiKeys).mockReturnValue({
      data: [
        { id: "anthropic-org", name: "Anthropic org", provider: "anthropic" },
        { id: "openai-org", name: "OpenAI org", provider: "openai" },
        { id: "copilot", name: "Copilot", provider: "github-copilot" },
      ],
    } as unknown as ReturnType<typeof useLlmProviderApiKeys>);
    const user = userEvent.setup();
    render(<ConnectionSettingsForm />);

    const row = (label: string) => {
      const item = within(agentList())
        .getAllByRole("listitem")
        .find((li) => within(li).queryByText(label));
      if (!item) throw new Error(`No agent row for ${label}`);
      return item;
    };
    expect(
      within(row("Claude Code")).getByText("Users' own keys"),
    ).toBeVisible();
    expect(
      within(row("Cursor")).getByText("Users' primary keys"),
    ).toBeVisible();
    expect(within(row("Amp")).getByText("Manual setup")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Amp provider keys" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Cursor provider keys" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Cursor" });
    await user.click(
      within(dialog).getByRole("button", { name: /Enable all/ }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(row("Cursor")).getByText("Admin keys")).toBeVisible();
    expect(
      within(row("Claude Code")).getByText("Users' own keys"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mutate.mock.lastCall?.[0].connectionClientProviderKeys).toEqual({
      cursor: [
        { provider: "anthropic", providerApiKeyId: "anthropic-org" },
        { provider: "openai", providerApiKeyId: "openai-org" },
      ],
    });
  });

  it("offers shared gateways as the default but not a member's personal one", () => {
    vi.mocked(useProfiles).mockReturnValue({
      data: [
        { id: "shared", name: "Team Gateway", isPersonalGateway: false },
        { id: "personal", name: "My Gateway", isPersonalGateway: true },
      ],
    } as unknown as ReturnType<typeof useProfiles>);
    render(<ConnectionSettingsForm />);
    const options = screen.getByRole("list", {
      name: "Default MCP Gateway options",
    });
    expect(within(options).getByText("Team Gateway")).toBeInTheDocument();
    expect(within(options).queryByText("My Gateway")).not.toBeInTheDocument();
  });
});

// ===================================================================
// Helpers
// ===================================================================

function agentList() {
  return screen.getByRole("list", { name: "Agents users can connect" });
}

/** Shown agent names, top to bottom, read from their reorder handles. */
function agentOrder() {
  return within(agentList())
    .getAllByRole("button", { name: /^Reorder / })
    .map((handle) =>
      handle
        .getAttribute("aria-label")
        ?.replace(/^Reorder (.+), position \d+$/, "$1"),
    );
}
