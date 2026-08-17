import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useUpdateIntegrationSettings } from "@/lib/organization.query";
import { IntegrationSettingsDialog } from "./integration-settings-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");

const mutate = vi.fn();

const ITEMS = [
  { id: "slack" as const, label: "Slack" },
  { id: "email" as const, label: "Email" },
];

function renderDialog(
  overrides: Parameters<
    typeof IntegrationSettingsDialog
  >[0]["overrides"] = null,
) {
  return render(
    <IntegrationSettingsDialog
      field="messagingChannelOverrides"
      title="Messaging channel settings"
      description="Admin only."
      entityNamePlural="channels"
      items={ITEMS}
      overrides={overrides}
      testId="channel-settings"
    />,
  );
}

describe("IntegrationSettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useUpdateIntegrationSettings).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateIntegrationSettings>);
  });

  it("stays hidden from users without organization-settings update", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as unknown as ReturnType<typeof useHasPermissions>);

    renderDialog();

    expect(screen.queryByTestId("channel-settings")).toBeNull();
  });

  it("saves a turned-off entry, dropping untouched entries", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByTestId("channel-settings"));
    await user.click(
      screen.getByRole("switch", { name: "Make Slack available" }),
    );
    await user.click(screen.getByTestId("integration-settings-save"));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(mutate.mock.calls[0][0]).toEqual({
      messagingChannelOverrides: { slack: { hidden: true } },
    });
  });

  // Channels and connectors are toggle-only; only providers take a name.
  it("offers no name field unless the catalog allows renaming", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByTestId("channel-settings"));

    expect(screen.queryByLabelText("Slack display name")).toBeNull();
  });

  it("saves a renamed entry when the catalog allows renaming", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationSettingsDialog
        field="modelProviderOverrides"
        title="Model provider settings"
        description="Admin only."
        entityNamePlural="providers"
        items={[{ id: "openai" as const, label: "OpenAI" }]}
        overrides={null}
        allowRename
        testId="provider-settings"
      />,
    );

    await user.click(screen.getByTestId("provider-settings"));
    await user.type(
      screen.getByLabelText("OpenAI display name"),
      "OpenAI (approved)",
    );
    await user.click(screen.getByTestId("integration-settings-save"));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(mutate.mock.calls[0][0]).toEqual({
      modelProviderOverrides: { openai: { displayName: "OpenAI (approved)" } },
    });
  });

  it("clears the catalog when every override is undone", async () => {
    const user = userEvent.setup();
    renderDialog({ slack: { hidden: true } });

    await user.click(screen.getByTestId("channel-settings"));
    await user.click(
      screen.getByRole("switch", { name: "Make Slack available" }),
    );
    await user.click(screen.getByTestId("integration-settings-save"));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(mutate.mock.calls[0][0]).toEqual({
      messagingChannelOverrides: null,
    });
  });

  it("cannot be saved until something changes", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByTestId("channel-settings"));

    expect(screen.getByTestId("integration-settings-save")).toBeDisabled();
  });

  // A five-row catalog reads at a glance, so it is rendered without the search
  // box that the longer provider and connector catalogs need.
  it("drops the search box for a compact catalog", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationSettingsDialog
        field="messagingChannelOverrides"
        title="Messaging channel settings"
        description="Admin only."
        entityNamePlural="channels"
        items={ITEMS}
        overrides={null}
        compact
        testId="channel-settings"
      />,
    );

    await user.click(screen.getByTestId("channel-settings"));

    expect(screen.queryByLabelText("Search channels")).toBeNull();
    expect(screen.getByTestId("integration-settings-row-slack")).toBeVisible();
  });
});
