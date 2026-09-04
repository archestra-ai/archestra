"use client";

import type { PropsWithChildren } from "react";
import { Version } from "@/components/version";
import { EnvSiteNotificationBar } from "./site-notification-bar";

/**
 * The frame every auth surface renders in: notification bar on top, version
 * footer at the bottom, and a flex column for the content between them.
 *
 * The session gate (WithAuthCheck) and the app shell's auth branch both draw
 * this frame, so a loading indicator shown by one is centred in exactly the
 * box the other will centre its own content in — whichever of the two renders
 * at any point during boot, the geometry is the same.
 */
export function AuthSurfaceFrame({ children }: PropsWithChildren) {
  return (
    <main className="h-app-viewport w-full flex flex-col bg-background">
      <EnvSiteNotificationBar />
      <div className="flex-1 flex flex-col">{children}</div>
      <Version />
    </main>
  );
}
