import { describe, expect, it } from "vitest";
import {
  buildBundledTriggerNavigation,
  getFirstTriggerHref,
} from "./bundled-trigger-navigation";

describe("bundled trigger navigation", () => {
  it("maps bundled adapters to trigger tabs with running state", () => {
    const navigation = buildBundledTriggerNavigation([
      {
        adapterId: "whatsapp",
        displayName: "WhatsApp",
        description: "Run the bundled WhatsApp ChatOps adapter process.",
        status: "running",
        pid: 42,
        lastStartedAt: "2026-05-01T12:00:00.000Z",
        lastExitAt: null,
        errorMessage: null,
        hasConnectionPage: true,
      },
    ]);

    expect(navigation).toEqual([
      {
        adapterId: "whatsapp",
        displayName: "WhatsApp",
        description: "Run the bundled WhatsApp ChatOps adapter process.",
        status: "running",
        pid: 42,
        lastStartedAt: "2026-05-01T12:00:00.000Z",
        lastExitAt: null,
        errorMessage: null,
        hasConnectionPage: true,
        href: "/agents/triggers/whatsapp",
        active: true,
      },
    ]);
  });

  it("falls back to a running bundled tab after fixed tabs when needed", () => {
    const firstHref = getFirstTriggerHref(
      [
        { href: "/agents/triggers/ms-teams", active: false },
        { href: "/agents/triggers/slack", active: false },
      ],
      [{ href: "/agents/triggers/whatsapp", active: true }],
    );

    expect(firstHref).toBe("/agents/triggers/whatsapp");
  });
});
