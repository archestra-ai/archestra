"use client";

import { LoadingWrapper } from "@/components/loading";
import { useAppVersions } from "@/lib/app.query";

// Read-only history of an app's immutable versions, newest first. Editing the
// HTML (via the scaffold_app/edit_app surfaces) forks a new version.
export function AppVersionsTab({ appId }: { appId: string }) {
  const { data: versions, isPending } = useAppVersions(appId);

  return (
    <LoadingWrapper isPending={isPending && !versions}>
      {!versions || versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No versions yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {versions.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between px-4 py-3 text-sm"
            >
              <span className="font-medium">Version {v.version}</span>
              <span className="text-muted-foreground">
                {new Date(v.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </LoadingWrapper>
  );
}
