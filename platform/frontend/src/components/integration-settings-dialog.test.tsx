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

  it("saves a turned-off entry and a renamed one, dropping untouched entries", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByTestId("channel-settings"));
    await user.click(
      screen.getByRole("switch", { name: "Make Slack available" }),
    );
    await user.type(screen.getByLabelText("Email display name"), "Inbox");
    await user.click(screen.getByTestId("integration-settings-save"));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(mutate.mock.calls[0][0]).toEqual({
      messagingChannelOverrides: {
        slack: { hidden: true },
        email: { displayName: "Inbox" },
      },
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

  it("turns every entry off in one action", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByTestId("channel-settings"));
    await user.click(screen.getByRole("button", { name: "Turn all off" }));
    await user.click(screen.getByTestId("integration-settings-save"));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(mutate.mock.calls[0][0]).toEqual({
      messagingChannelOverrides: {
        slack: { hidden: true },
        email: { hidden: true },
      },
    });
  });
});
