import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalDeviceCards } from "./local-device-cards";
import type { LocalDevicesController } from "./use-local-devices-controller";

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterAll(() => {
  if (originalScrollIntoView) {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

function controller() {
  return {
    availability: "ready",
    appName: "Acme",
    desktopName: "Acme Desktop",
    connectors: { recommended: null, status: "ready" },
    downloadDesktop: vi.fn(),
    openDesktop: vi.fn(),
    devices: [
      {
        id: "work-mac",
        name: "Work Mac",
        platform: "darwin",
        arch: "arm64",
        appVersion: "1.0.0",
        status: "offline",
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
      },
    ],
    enrollment: null,
    suggestedName: "Another Mac",
    renamingId: null,
    revokingId: null,
    isEnrolling: false,
    dismissEnrollment: vi.fn(),
    cancelEnrollment: vi.fn().mockResolvedValue(true),
    rename: vi.fn().mockResolvedValue(true),
    revoke: vi.fn().mockResolvedValue(true),
    addDevice: vi.fn().mockResolvedValue(null),
  } as unknown as LocalDevicesController;
}

describe("LocalDeviceCards", () => {
  it("renames a device inline without opening a dialog", async () => {
    const user = userEvent.setup();
    const data = controller();
    render(<LocalDeviceCards controller={data} />);
    await user.click(screen.getByRole("button", { name: "Rename Work Mac" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", {
      name: "Device name for Work Mac",
    });
    await user.clear(input);
    await user.type(input, "Travel Mac{Enter}");
    expect(data.rename).toHaveBeenCalledWith("work-mac", "Travel Mac");
    await waitFor(() =>
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
    );
  });

  it("cancels an inline rename with Escape without saving", async () => {
    const user = userEvent.setup();
    const data = controller();
    render(<LocalDeviceCards controller={data} />);
    await user.click(screen.getByRole("button", { name: "Rename Work Mac" }));
    const input = screen.getByRole("textbox", {
      name: "Device name for Work Mac",
    });
    await user.clear(input);
    await user.type(input, "Discard this{Escape}");
    expect(data.rename).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Rename Work Mac" }),
    ).toBeInTheDocument();
  });

  it("adds computers through Connect without offering a desktop download", () => {
    render(<LocalDeviceCards controller={controller()} />);
    expect(screen.getByRole("link", { name: /Add device/ })).toHaveAttribute(
      "href",
      "/connection",
    );
    expect(
      screen.queryByRole("button", { name: /download/i }),
    ).not.toBeInTheDocument();
  });
});
