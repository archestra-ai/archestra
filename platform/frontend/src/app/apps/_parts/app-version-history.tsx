"use client";

import { LoadingWrapper } from "@/components/loading";
import { useAppVersions } from "@/lib/app.query";

export function AppVersionHistory({ appId }: { appId: string }) {
  const { data: versions, isPending } = useAppVersions(appId);

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Version history</h2>

      <LoadingWrapper isPending={isPending && !versions} loadingFallback={null}>
        {!versions || versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No versions yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between px-4 py-3 text-sm"
              >
                <span className="font-medium">v{v.version}</span>
                <span className="text-muted-foreground">
                  {new Date(v.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </LoadingWrapper>
    </section>
  );
}
