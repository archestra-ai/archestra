"use client";

import { Wrench } from "lucide-react";

type MaintenanceModePageProps = {
  message: string;
};

export function MaintenanceModePage({ message }: MaintenanceModePageProps) {
  return (
    <main className="flex h-screen w-full items-center justify-center bg-background px-6">
      <div className="w-full max-w-lg text-center">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-muted">
          <Wrench className="size-6 text-muted-foreground" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-semibold tracking-normal">
          Maintenance mode
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {message}
        </p>
      </div>
    </main>
  );
}
