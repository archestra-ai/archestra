// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { AutoSyncPermissionsToggle } from "./auto-sync-permissions-toggle";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

function setGates({
  beta = true,
  enterprise = true,
  permitted = true,
}: {
  beta?: boolean;
  enterprise?: boolean;
  permitted?: boolean;
} = {}) {
  vi.mocked(useFeature).mockImplementation((flag) =>
    flag === "kbAutoSyncPermissionsEnabled" ? beta : false,
  );
  vi.mocked(useEnterpriseFeature).mockReturnValue(enterprise);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: permitted,
  } as unknown as ReturnType<typeof useHasPermissions>);
}

function renderToggle(props?: {
  enabled?: boolean;
  supported?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
}) {
  render(
    <AutoSyncPermissionsToggle
      enabled={props?.enabled ?? false}
      onEnabledChange={props?.onEnabledChange ?? vi.fn()}
      supported={props?.supported ?? true}
      permissionAction="update"
    />,
  );
}

const toggle = () =>
  screen.queryByRole("switch", { name: /Sync permissions from the source/ });

beforeEach(() => {
  vi.clearAllMocks();
  setGates();
});

it("hides the capability entirely while the beta flag is off", () => {
  setGates({ beta: false });
  renderToggle();
  expect(toggle()).not.toBeInTheDocument();
});

it("stays available on a connector already using it, whatever the gates say", async () => {
  // Every gate shut: a connector that is already syncing permissions must
  // still be able to stop, or the capability becomes a one-way door.
  setGates({ beta: false, enterprise: false, permitted: false });
  const onEnabledChange = vi.fn();
  const user = userEvent.setup();
  renderToggle({ enabled: true, onEnabledChange });

  const control = toggle();
  expect(control).toBeEnabled();
  await user.click(control as HTMLElement);
  expect(onEnabledChange).toHaveBeenCalledWith(false);
});

it("locks the capability for a source that cannot sync permissions", () => {
  renderToggle({ supported: false });
  expect(toggle()).toBeDisabled();
  expect(screen.getByText("Not supported for this source.")).toBeVisible();
});

it("locks the capability for someone without the auto-sync permission", () => {
  setGates({ permitted: false });
  renderToggle();
  expect(toggle()).toBeDisabled();
  expect(screen.getByText("Requires permission.")).toBeVisible();
});

it("locks the capability when enterprise access control is inactive", () => {
  setGates({ enterprise: false });
  renderToggle();
  expect(toggle()).toBeDisabled();
  expect(screen.getByText("Enterprise feature.")).toBeVisible();
});
