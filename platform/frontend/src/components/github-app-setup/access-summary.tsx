"use client";

import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** What a GitHub App setup's App may do: a line, then one badge per permission. */
export function AccessSummary({
  intro,
  permissions,
}: {
  intro: string;
  permissions: Array<{ name: string; access: string }>;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-muted/40 px-4 py-3">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-2">
        <p className="text-xs text-muted-foreground">{intro}</p>
        <div className="flex flex-wrap gap-1.5">
          {permissions.map((permission) => (
            <Badge
              key={permission.name}
              variant="outline"
              className="bg-background"
            >
              <span>{permission.name}</span>
              <span className="font-normal text-muted-foreground">
                {permission.access}
              </span>
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
