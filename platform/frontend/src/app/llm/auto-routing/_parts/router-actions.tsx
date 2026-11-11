"use client";

import { History, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAutoRouter } from "@/lib/auto-routing.query";
import { ConfigureAutoRoutingButton } from "./configure-button";
import { PastSessionsDialog } from "./past-sessions";

/**
 * The router page's header actions: Configure, and once a plan is active a
 * menu for the occasional jobs, like scoring past sessions.
 */
export function RouterActions() {
  const { data: router } = useAutoRouter();
  const { data: canUpdate = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  const [scoring, setScoring] = useState(false);
  const showMenu =
    canUpdate &&
    router?.usesPastSessions === true &&
    router.status.activePlan !== null;

  return (
    <div className="flex items-center gap-2">
      <ConfigureAutoRoutingButton />
      {showMenu && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Auto router actions"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setScoring(true)}>
                <History />
                <span>Score past sessions…</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Dialog open={scoring} onOpenChange={setScoring}>
            {scoring && (
              <PastSessionsDialog
                scorer={router.status.scorer}
                onClose={() => setScoring(false)}
              />
            )}
          </Dialog>
        </>
      )}
    </div>
  );
}
