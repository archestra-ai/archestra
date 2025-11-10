"use client";

import { useHealth } from "@/lib/health.query";

export function Version() {
  const { data } = useHealth();
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
