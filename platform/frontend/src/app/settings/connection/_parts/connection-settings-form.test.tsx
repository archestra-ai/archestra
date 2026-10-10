import { DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/llm-provider-api-keys.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/integration-overrides", () => ({
  useModelProviderCatalog: () => ({ label: (provider: string) => provider }),
}));
vi.mock("@/components/agent-selector", () => ({
  AgentSelector: () => null,
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
import { useFeature } from "@/lib/config/config.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useOrganization,
  useUpdateConnectionSettings,
} from "@/lib/organization.query";
import { ConnectionSettingsForm } from "./connection-settings-form";

const mutate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useOrganization).mockReturnValue({
    data: {
      connectionDefaultMcpGatewayId: null,
      connectionDefaultClientId: null,
      connectionShownClientIds: null,
      connectionBaseUrls: null,
      connectionDefaultProviderKeys: null,
      connectionSkillsEnabled: true,
      connectionLlmProxyEnabled: true,
      connectionPluginsEnabled: true,
    },
  } as ReturnType<typeof useOrganization>);
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
    const list = () => screen.getByRole("list", { name: "Available agents" });
    const originalHandles = within(list()).getAllByRole("button", {
      name: /^Reorder /,
    });
    const firstName = originalHandles[0].getAttribute("aria-label");
    const secondName = originalHandles[1].getAttribute("aria-label");
    originalHandles[1].focus();
    await user.keyboard("{ArrowLeft}");
    expect(
      within(list()).getAllByRole("button", { name: /^Reorder / })[0],
    ).toHaveAttribute("aria-label", secondName);
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
    expect(
      within(list())
        .getAllByRole("button", { name: /^Reorder / })
        .slice(0, 2)
        .map((handle) => handle.getAttribute("aria-label")),
    ).toEqual([secondName, firstName]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    within(list())
      .getAllByRole("button", { name: /^Reorder / })[0]
      .focus();
    await user.keyboard("{ArrowRight}");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(
      within(list()).getAllByRole("button", { name: /^Reorder / })[0],
    ).toHaveAttribute("aria-label", secondName);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("disables Add when all agents are chosen and re-enables it after removal", async () => {
    const user = userEvent.setup();
    render(<ConnectionSettingsForm />);
    expect(screen.getByRole("button", { name: "Add agent" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Remove Codex from Connect" }),
    );
    expect(screen.getByRole("button", { name: "Add agent" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await user.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByRole("button", { name: "Add agent" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove Codex from Connect" }),
    ).toHaveFocus();
  });

  it("adds an agent through the inline menu at the end, removes it, and discards back to the saved list", async () => {
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
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await user.click(screen.getByRole("button", { name: "Cursor" }));
    expect(
      within(screen.getByRole("list", { name: "Available agents" }))
        .getAllByRole("button", { name: /^Reorder / })
        .map((handle) => handle.getAttribute("aria-label")),
    ).toEqual(["Reorder Codex", "Reorder Cursor"]);
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
    expect(
      screen.queryByRole("button", { name: "Reorder Codex" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Cursor from Connect" }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(
      screen.getByRole("button", { name: "Reorder Codex" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reorder Cursor" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Remove Codex from Connect" }),
    );
    expect(
      screen.getByText("No agents added. Generic client is still available."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add agent" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionShownClientIds: [],
        connectionClientOrder: [],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await user.click(screen.getByRole("button", { name: "Codex" }));
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
    expect(editor).toHaveValue(DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS);
    const toggle = screen.getByRole("switch", {
      name: "Enable managed instructions",
    });
    expect(toggle).toBeChecked();
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
      screen.getByRole("switch", { name: "Enable managed instructions" }),
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
});
