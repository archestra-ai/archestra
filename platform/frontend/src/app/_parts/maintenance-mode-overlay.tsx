"use client";

import { useEffect, useState } from "react";
import { AppLogo } from "@/components/app-logo";
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
        <AppLogo />
        <h1 className="text-2xl font-semibold text-foreground">
          Maintenance in Progress
        </h1>
        <p className="text-muted-foreground text-sm">{maintenanceMessage}</p>
      </div>
    </div>
  );
}
