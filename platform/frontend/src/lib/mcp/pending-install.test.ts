import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingInstall,
  getPendingInstall,
  MAX_PENDING_INSTALL_REOPENS,
  registerPendingInstallReopen,
  setPendingInstall,
} from "./pending-install";

describe("pending-install intent", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("round-trips a stashed intent", () => {
    setPendingInstall({ catalogId: "cat-1", scope: "team", teamId: "team-9" });
    expect(getPendingInstall()).toEqual({
      catalogId: "cat-1",
      scope: "team",
      teamId: "team-9",
    });
  });

  it("returns null when nothing is stashed", () => {
    expect(getPendingInstall()).toBeNull();
  });

  it("clears a stashed intent", () => {
    setPendingInstall({ catalogId: "cat-1" });
    clearPendingInstall();
    expect(getPendingInstall()).toBeNull();
  });

  it("ignores a malformed stashed value", () => {
    sessionStorage.setItem("archestra:pending-install", "{not json");
    expect(getPendingInstall()).toBeNull();
  });

  it("allows re-opens up to the cap, then gives up and clears the intent", () => {
    setPendingInstall({ catalogId: "cat-1" });

    // The first open comes straight from the deep link and does not register;
    // only re-opens after a loss are counted here.
    for (let i = 0; i < MAX_PENDING_INSTALL_REOPENS; i++) {
      expect(registerPendingInstallReopen()).toBe(true);
      // The intent survives while still under the cap.
      expect(getPendingInstall()).not.toBeNull();
    }

    // One past the cap: refused, and the intent is dropped so it stops being
    // reconsidered.
    expect(registerPendingInstallReopen()).toBe(false);
    expect(getPendingInstall()).toBeNull();
  });

  it("resets the re-open counter when a fresh intent is stashed", () => {
    setPendingInstall({ catalogId: "cat-1" });
    for (let i = 0; i < MAX_PENDING_INSTALL_REOPENS; i++) {
      registerPendingInstallReopen();
    }
    // A new deep link stashes a fresh intent — its re-open budget starts over.
    setPendingInstall({ catalogId: "cat-2" });
    expect(registerPendingInstallReopen()).toBe(true);
  });
});
