import { render, screen } from "@testing-library/react";
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
  }: {
    hasChanges: boolean;
    onSave: () => void;
  }) => (
    <button type="button" disabled={!hasChanges} onClick={onSave}>
      Save
    </button>
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
      }),
    );
  });
});
