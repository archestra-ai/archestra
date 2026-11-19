import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  devicePlatformLabel,
  deviceProgramUpdateNotice,
  deviceProgramVersionLabel,
  deviceStatusLabel,
} from "./device-labels";

describe("deviceStatusLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives no time for a device that is online", () => {
    expect(
      deviceStatusLabel({
        online: true,
        lastPolledAt: "2026-11-12T11:59:58Z",
      }),
    ).toEqual({ status: "Online", lastOnline: null });
  });

  it("says when an offline device was last online", () => {
    expect(
      deviceStatusLabel({
        online: false,
        lastPolledAt: "2026-11-12T09:00:00Z",
      }),
    ).toEqual({ status: "Offline", lastOnline: "Last online 3 hours ago" });
  });

  it("gives no time for a device that was never online", () => {
    expect(deviceStatusLabel({ online: false, lastPolledAt: null })).toEqual({
      status: "Offline",
      lastOnline: null,
    });
  });
});

describe("devicePlatformLabel", () => {
  it("names each system that the MCP bridge runs on", () => {
    expect(devicePlatformLabel("macos")).toBe("macOS");
    expect(devicePlatformLabel("windows")).toBe("Windows");
    expect(devicePlatformLabel("linux")).toBe("Linux");
  });
});

describe("deviceProgramVersionLabel", () => {
  it("shows the version the MCP bridge reported", () => {
    expect(deviceProgramVersionLabel("0.2.0")).toBe("0.2.0");
  });

  it("says so when the MCP bridge reported no version", () => {
    expect(deviceProgramVersionLabel(null)).toBe("Not reported");
  });
});

describe("deviceProgramUpdateNotice", () => {
  const notice = (
    device: Partial<Parameters<typeof deviceProgramUpdateNotice>[0]>,
  ) =>
    deviceProgramUpdateNotice({
      platform: "linux",
      programUpdate: { version: "0.2.0" },
      programAutoUpdate: true,
      ...device,
    });
  const sentence = (device: Parameters<typeof notice>[0]) => {
    const text = notice(device)?.text;
    return text && `${text.before}${text.command}${text.after}`;
  };

  it("shows nothing for a device with no update", () => {
    expect(notice({ programUpdate: null })).toBeNull();
  });

  it("names the new version when it is known", () => {
    expect(notice({})?.title).toBe(
      "A new version of the MCP bridge (0.2.0) is available",
    );
    expect(notice({ programUpdate: { version: null } })?.title).toBe(
      "A new version of the MCP bridge is available",
    );
  });

  it("says that a Windows device updates by itself, and how to update now", () => {
    const text =
      "The device updates by itself when no tool call is running. To update now, run archestra update in a terminal on that device.";
    expect(sentence({ platform: "windows" })).toBe(text);
  });

  it("tells a macOS or Linux user to run the command", () => {
    expect(sentence({ platform: "macos" })).toBe(
      "Run archestra update in a terminal on that device.",
    );
    expect(sentence({ platform: "linux" })).toBe(
      "Run archestra update in a terminal on that device.",
    );
  });

  it("tells every user to run the command when auto-update is off", () => {
    expect(sentence({ platform: "windows", programAutoUpdate: false })).toBe(
      "Run archestra update in a terminal on that device.",
    );
  });

  it("gives the command apart from the words around it", () => {
    expect(notice({ platform: "macos" })?.text).toEqual({
      before: "Run ",
      command: "archestra update",
      after: " in a terminal on that device.",
    });
  });
});
