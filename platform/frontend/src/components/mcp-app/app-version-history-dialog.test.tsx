import type { archestraApiTypes } from "@archestra/shared";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppVersions, useRestoreAppVersion } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { AppVersionHistoryDialog } from "./app-version-history-dialog";

const restore = vi.fn();

vi.mock("@/lib/app.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: ({
    open,
    title,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div>
        <span>{title}</span>
        <button type="button" onClick={onConfirm}>
          Confirm restore
        </button>
      </div>
    ) : null,
}));

type OwnedApp = Extract<
  archestraApiTypes.GetAppsResponses["200"]["data"][number],
  { source: "owned" }
>;

const app: OwnedApp = {
  source: "owned",
  id: "app-1",
  slug: "history-test",
  name: "History Test",
  description: null,
  scope: "org",
  authorId: "user-1",
  authorName: "Test Author",
  viewerRole: "owner",
  latestVersion: 2,
  enabled: true,
  locked: false,
  teams: [],
  users: [],
  executionModel: "viewer-scoped",
  cspOrigin: "platform-pinned",
  pinnedAt: null,
  labels: [],
  icon: null,
  iconUrl: null,
  createdBy: null,
};

describe("AppVersionHistoryDialog", () => {
  beforeEach(() => {
    restore.mockReset();
    restore.mockResolvedValue({ latestVersion: 3 });
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useAppVersions).mockReturnValue({
      data: [
        {
          id: "version-2",
          appId: app.id,
          version: 2,
          createdAt: "2026-09-03T12:00:00.000Z",
        },
        {
          id: "version-1",
          appId: app.id,
          version: 1,
          createdAt: "2026-09-03T11:00:00.000Z",
        },
      ],
      isPending: false,
      isError: false,
    } as ReturnType<typeof useAppVersions>);
    vi.mocked(useRestoreAppVersion).mockReturnValue({
      mutateAsync: restore,
      isPending: false,
    } as unknown as ReturnType<typeof useRestoreAppVersion>);
  });

  it("restores an older version against the current head", async () => {
    const onOpenChange = vi.fn();
    render(
      <AppVersionHistoryDialog app={app} open onOpenChange={onOpenChange} />,
    );

    // Opens on the head, which wears the HEAD ref and cannot be restored.
    expect(screen.getByRole("heading", { name: "Version 2" })).toBeVisible();
    expect(within(railRow(2)).getByText("HEAD")).toBeInTheDocument();
    expect(restoreButton()).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(railRow(1));
    fireEvent.click(restoreButton());
    expect(screen.getByText("Restore version 1?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));

    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith({
        appId: app.id,
        version: 1,
        baseVersion: 2,
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps history browseable but refuses restore for a locked app, saying why", () => {
    render(
      <AppVersionHistoryDialog
        app={{ ...app, locked: true }}
        open
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(railRow(1));

    expect(screen.getByRole("heading", { name: "Version 1" })).toBeVisible();
    expect(restoreButton()).toHaveAttribute("aria-disabled", "true");
    expect(restoreButton()).toHaveAccessibleDescription(
      "Unlock the app before restoring a version.",
    );
    fireEvent.click(restoreButton());
    expect(screen.queryByText("Restore version 1?")).not.toBeInTheDocument();
  });
});

/** A version's row in the commit-graph rail. */
function railRow(version: number) {
  return screen.getByRole("button", {
    name: new RegExp(`^Version ${version}\\b`),
  });
}

/** The pane's restore button, whichever version it is offering. */
function restoreButton() {
  return screen.getByRole("button", { name: /^Restore v\d+$/ });
}
