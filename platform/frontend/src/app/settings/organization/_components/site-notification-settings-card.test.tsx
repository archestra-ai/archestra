import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SiteNotificationSettingsCard } from "./site-notification-settings-card";

describe("SiteNotificationSettingsCard", () => {
  it("normalizes markdown and expiration when saving", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <SiteNotificationSettingsCard
        initialNotification={null}
        canUpdate
        isSaving={false}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("Announcement markdown"), {
      target: {
        value: "  [Status page](https://status.example.com)  ",
      },
    });
    await user.type(screen.getByLabelText("Expires at"), "2026-05-14T09:30");
    await user.click(screen.getByRole("button", { name: "Save notification" }));

    expect(onSave).toHaveBeenCalledTimes(1);

    const payload = onSave.mock.calls[0][0] as {
      markdown: string | null;
      expiresAt: string | null;
    };

    expect(payload.markdown).toBe("[Status page](https://status.example.com)");
    expect(payload.expiresAt).not.toBeNull();
    expect(new Date(payload.expiresAt ?? "").getTime()).toBe(
      new Date("2026-05-14T09:30").getTime(),
    );
  });

  it("lets admins clear the notification and expiration", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <SiteNotificationSettingsCard
        initialNotification={{
          markdown: "Existing banner",
          expiresAt: "2026-05-14T09:30:00.000Z",
        }}
        canUpdate
        isSaving={false}
        onSave={onSave}
      />,
    );

    await user.clear(screen.getByLabelText("Announcement markdown"));
    await user.clear(screen.getByLabelText("Expires at"));
    await user.click(screen.getByRole("button", { name: "Save notification" }));

    expect(onSave).toHaveBeenCalledWith({
      markdown: null,
      expiresAt: null,
    });
  });
});
