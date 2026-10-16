"use client";

import { usePathname } from "next/navigation";
import { isSensitiveReplayPath } from "@/lib/telemetry-privacy";

export function SessionReplayPrivacy({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div
      className="contents"
      data-session-replay-sensitive={
        isSensitiveReplayPath(pathname) || undefined
      }
    >
      {children}
    </div>
  );
}
