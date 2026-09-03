import type { archestraApiTypes } from "@archestra/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppVersions, useRestoreAppVersion } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { AppVersionHistoryDialog } from "./app-version-history-dialog";

const restore = vi.fn();

vi.mock("@/lib/app.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/components/standard-dialog", () => ({
  StandardDialog: ({
    open,
    title,
    children,
    footer,
  }: {
    open: boolean;
    title: string;
    children: ReactNode;
    footer: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
        {footer}
      </div>
    ) : null,
}));
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

    expect(screen.getByText("Version 2")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
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

  it("keeps history browseable but disables restore for a locked app", () => {
    render(
      <AppVersionHistoryDialog
        app={{ ...app, locked: true }}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const restoreButton = screen.getByRole("button", { name: "Restore" });
    expect(restoreButton).toBeDisabled();
    expect(restoreButton).toHaveAttribute(
      "title",
      "Unlock the app before restoring a version.",
    );
  });
});
