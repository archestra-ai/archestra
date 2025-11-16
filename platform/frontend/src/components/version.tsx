"use client";

import { usePathname } from "next/navigation";
import { useHealth } from "@/lib/health.query";

export function Version() {
  const { data } = useHealth();
  const pathname = usePathname();

  if (pathname.startsWith("/chat")) {
    return null;
  }

  return (
    <>
      {data?.version && (
        <div className="text-xs text-muted-foreground text-center py-4">
          Version: {data.version}
        </div>
      )}
    </>
  );
}
