"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
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
  // Start collapsed while loading. Once data arrives, expand only if incomplete.
  // After the initial decision, the user controls the state via the toggle.
  const initializedRef = useRef(false);
  const [open, setOpen] = useState(false);

  if (!isLoading && !initializedRef.current) {
    initializedRef.current = true;
    if (!allStepsCompleted) {
      setOpen(true);
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="flex flex-col gap-4">
        <div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Setup</h2>
              {allStepsCompleted && (
                <Badge
                  variant="secondary"
                  className="bg-green-500/10 text-green-600 border-green-500/20"
                >
                  <CheckCircle2 className="size-3" />
                  Completed
                </Badge>
              )}
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="text-xs">
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
          <p className="text-xs text-muted-foreground mt-1">
            Connect {providerLabel} so agents can receive and respond to
            messages.{" "}
            <Link
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Learn more
              <ExternalLink className="h-3 w-3" />
            </Link>
          </p>
        </div>
        <CollapsibleContent className="flex flex-col gap-4">
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
