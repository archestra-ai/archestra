import { describe, expect, it } from "vitest";
import { isCardShowingInstallInProgress } from "./card-install-state";

describe("isCardShowingInstallInProgress", () => {
  it("does NOT treat another user's pending install as installing (the merge-queue flake: teammate's pending connection hid the viewer's Install button)", () => {
    expect(
      isCardShowingInstallInProgress({
        deploymentFailed: false,
        viewerTriggeredInstall: false,
        variant: "local",
        installationStatus: "pending",
        hasInstalledServer: true,
        installationOwnedByViewer: false,
      }),
    ).toBe(false);
  });

  it("does NOT treat another user's tool discovery as installing", () => {
    expect(
      isCardShowingInstallInProgress({
        deploymentFailed: false,
        viewerTriggeredInstall: false,
        variant: "local",
        installationStatus: "discovering-tools",
        hasInstalledServer: true,
        installationOwnedByViewer: false,
      }),
    ).toBe(false);
  });

  it("treats the viewer's own pending install as installing", () => {
    expect(
      isCardShowingInstallInProgress({
        deploymentFailed: false,
        viewerTriggeredInstall: false,
        variant: "local",
        installationStatus: "pending",
        hasInstalledServer: true,
        installationOwnedByViewer: true,
      }),
    ).toBe(true);
  });

  it("treats the viewer's own tool discovery as installing", () => {
    expect(
      isCardShowingInstallInProgress({
        deploymentFailed: false,
        viewerTriggeredInstall: false,
        variant: "local",
        installationStatus: "discovering-tools",
        hasInstalledServer: true,
        installationOwnedByViewer: true,
      }),
    ).toBe(true);
  });

  it("treats an install the viewer just triggered as installing regardless of ownership data", () => {
    expect(
      isCardShowingInstallInProgress({
        deploymentFailed: false,
        viewerTriggeredInstall: true,
        variant: "local",
        installationStatus: null,
        hasInstalledServer: false,
        installationOwnedByViewer: false,
      }),
    ).toBe(true);
  });

  it("is not installing once the viewer's install succeeded", () => {
    expect(
      isCardShowingInstallInProgress({
        deploymentFailed: false,
        viewerTriggeredInstall: false,
        variant: "local",
        installationStatus: "success",
        hasInstalledServer: true,
        installationOwnedByViewer: true,
      }),
    ).toBe(false);
  });

  it("shows the failure state, not a spinner, when the deployment failed while still pending", () => {
    expect(
      isCardShowingInstallInProgress({
        deploymentFailed: true,
        viewerTriggeredInstall: false,
        variant: "local",
        installationStatus: "pending",
        hasInstalledServer: true,
        installationOwnedByViewer: true,
      }),
    ).toBe(false);
  });

  it("never derives installing from backend status on non-local variants", () => {
    expect(
      isCardShowingInstallInProgress({
        deploymentFailed: false,
        viewerTriggeredInstall: false,
        variant: "remote",
        installationStatus: "pending",
        hasInstalledServer: true,
        installationOwnedByViewer: true,
      }),
    ).toBe(false);
  });
});
