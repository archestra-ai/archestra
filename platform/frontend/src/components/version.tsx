"use client";

import { usePathname } from "next/navigation";
import config from "@/lib/config";

const { version } = config;

export function Version() {
  const pathname = usePathname();

  if (pathname.startsWith("/chat")) {
    return null;
  }

  return (
    <>
      {version && (
        <div className="text-xs text-muted-foreground text-center py-4">
          Version: {version}
        </div>
      )}
    </>
  );
}
