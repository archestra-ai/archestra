"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

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
  docsUrl: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // While loading or setup incomplete: always show content, no collapse toggle
  if (isLoading || !allStepsCompleted) {
    return (
      <section className="flex flex-col gap-4">
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Setup</h2>
            <Link
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Learn more
              <ExternalLink className="h-3 w-3" />
            </Link>
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
              <Link
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Learn more
                <ExternalLink className="h-3 w-3" />
              </Link>
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
