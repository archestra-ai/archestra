"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Mail } from "lucide-react";
import Link from "next/link";
import { AgentIcon } from "@/components/agent-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Agent = archestraApiTypes.GetAgentResponses["200"];

export function EmailChannelDetailsDialog({
  agent,
  emailAddress,
  open,
  onOpenChange,
}: {
  agent: Agent;
  emailAddress: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const securityDescription = getSecurityDescription(agent);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex min-w-0 items-start gap-2.5 text-left">
            <Mail className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <DialogTitle className="break-words">
                {emailAddress || "Email channel"}
              </DialogTitle>
              <DialogDescription>Email</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-5">
          <dl className="grid gap-x-6 gap-y-4 border-y py-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <dt className="text-xs text-muted-foreground">Assigned agent</dt>
              <dd>
                <Link
                  href={`/agents/${agent.id}`}
                  className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium hover:underline"
                >
                  <AgentIcon icon={agent.icon} size={16} />
                  <span className="truncate">{agent.name}</span>
                </Link>
              </dd>
            </div>
            <div className="min-w-0 space-y-1">
              <dt className="text-xs text-muted-foreground">Security mode</dt>
              <dd className="text-sm capitalize">
                {agent.incomingEmailSecurityMode}
              </dd>
            </div>
          </dl>

          <div className="space-y-1">
            <p className="text-sm font-medium">Who can send email</p>
            <p className="text-sm text-muted-foreground">
              {securityDescription}
            </p>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            <span>Close</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function getSecurityDescription(agent: Agent) {
  if (agent.incomingEmailSecurityMode === "public") {
    return "Any sender can invoke this agent by email.";
  }
  if (agent.incomingEmailSecurityMode === "internal") {
    return agent.incomingEmailAllowedDomain
      ? `Only senders from @${agent.incomingEmailAllowedDomain} can invoke this agent.`
      : "Only senders from the configured domain can invoke this agent.";
  }
  return "Only registered users with access to this agent can invoke it by email.";
}
