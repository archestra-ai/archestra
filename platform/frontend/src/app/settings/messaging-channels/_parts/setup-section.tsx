"use client";

import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalDocsLink } from "./external-docs-link";

export function SetupSection({
  allStepsCompleted,
  isLoading,
  providerLabel,
  docsUrl,
  collapseWhenDone = false,
  children,
}: {
  allStepsCompleted: boolean;
  isLoading: boolean;
  providerLabel: string;
  docsUrl: string | null;
  /**
   * Fold the steps away once they are all done, so the page leads with what
   * the provider is used for rather than with a finished checklist.
   */
  collapseWhenDone?: boolean;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapseWhenDone && allStepsCompleted && !expanded;
  return (
    <section className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Setup</h2>
            {!isLoading && allStepsCompleted && (
              <Badge
                variant="secondary"
                className="border-green-500/70 bg-green-500/10 text-green-600"
              >
                <CheckCircle2 className="size-3" />
                Completed
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            {collapseWhenDone && allStepsCompleted && !isLoading && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={!collapsed}
                onClick={() => setExpanded((value) => !value)}
              >
                {collapsed ? "Show setup" : "Hide setup"}
              </Button>
            )}
            <ExternalDocsLink href={docsUrl} className="text-xs">
              Learn more
            </ExternalDocsLink>
          </div>
        </div>
        {!isLoading && !collapsed && (
          <p className="mt-1 text-xs text-muted-foreground">
            Connect {providerLabel} so agents can receive and respond to
            messages.
          </p>
        )}
      </div>
      {!isLoading && !collapsed && children}
    </section>
  );
}
