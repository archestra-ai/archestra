"use client";

import { CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ExternalDocsLink } from "./external-docs-link";

export function CollapsibleSetupSection({
  allStepsCompleted,
  isLoading,
  providerLabel,
  docsUrl,
  children,
}: {
  allStepsCompleted: boolean;
  isLoading: boolean;
  providerLabel: string;
  docsUrl: string | null;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // Decide expanded/collapsed exactly ONCE, on the first settled (non-loading)
  // render: expanded while setup is incomplete, collapsed once it's complete.
  // Deciding once (rather than reacting to every allStepsCompleted change) means
  // query refetch churn can't flip it — the old effect keyed off a null→false→
  // true transition, so whether it ended up open depended on async settle order.
  // If setup completes while the user is here, `open` stays true (we never
  // auto-collapse), so it doesn't yank the UI out from under them. Manual toggles
  // via the trigger win after the initial decision.
  const decided = useRef(false);
  useEffect(() => {
    if (isLoading || decided.current) return;
    decided.current = true;
    setOpen(!allStepsCompleted);
  }, [isLoading, allStepsCompleted]);

  // While loading or setup incomplete: always show content, no collapse toggle
  if (isLoading || !allStepsCompleted) {
    return (
      <section className="flex flex-col gap-4">
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Setup</h2>
            <ExternalDocsLink href={docsUrl} className="text-xs">
              Learn more
            </ExternalDocsLink>
          </div>
          {!isLoading && (
            <p className="text-xs text-muted-foreground mt-1">
              Connect {providerLabel} so agents can receive and respond to
              messages.
            </p>
          )}
        </div>
        {!isLoading && children}
      </section>
    );
  }

  // Setup completed: collapsible, starts collapsed
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="flex flex-col gap-4">
        <div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Setup</h2>
              <Badge
                variant="secondary"
                className="bg-green-500/10 text-green-600 border-green-500/70"
              >
                <CheckCircle2 className="size-3" />
                Completed
              </Badge>
            </div>
            <div className="flex items-center gap-1">
              <ExternalDocsLink href={docsUrl} className="text-xs">
                Learn more
              </ExternalDocsLink>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs hover:bg-transparent"
                >
                  {open ? (
                    <>
                      Hide details
                      <ChevronUp className="h-3 w-3 ml-1" />
                    </>
                  ) : (
                    <>
                      Show details
                      <ChevronDown className="h-3 w-3 ml-1" />
                    </>
                  )}
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>
          {open && (
            <p className="text-xs text-muted-foreground mt-1">
              Connect {providerLabel} so agents can receive and respond to
              messages.
            </p>
          )}
        </div>
        <CollapsibleContent className="flex flex-col gap-4">
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
