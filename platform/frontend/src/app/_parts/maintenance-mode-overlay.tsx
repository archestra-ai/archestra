"use client";

import { useEffect, useState } from "react";
import { usePublicConfig } from "@/lib/config/config.query";

export function MaintenanceModeOverlay() {
  const { data: config, isLoading } = usePublicConfig();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || isLoading) {
    return null;
  }

  const maintenanceMessage = config?.maintenanceMode;

  if (!maintenanceMessage) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background">
      <div className="max-w-md text-center space-y-4 p-8">
        <div className="text-6xl mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-16 w-16 mx-auto text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            role="img"
            aria-label="Maintenance warning"
          >
            <title>Maintenance Warning</title>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-foreground">
          Maintenance in Progress
        </h1>
        <p className="text-muted-foreground text-sm">{maintenanceMessage}</p>
        <p className="text-xs text-muted-foreground">Please check back soon.</p>
      </div>
    </div>
  );
}
