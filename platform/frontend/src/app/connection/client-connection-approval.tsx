"use client";

import { Check, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useClientConnection,
  useDecideClientConnection,
} from "@/lib/client-connection.query";
import { postConnected } from "@/lib/connect-signal";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ApprovedHandoff } from "./approved-handoff";
import { ClaudeDesktopGatewaySteps } from "./claude-desktop-gateway-steps";
import { ClientIcon } from "./client-icon";
import { CONNECT_CLIENTS, type ConnectClient } from "./clients";
import { GatewayLink } from "./gateway-link";
import { platformLabels, toPlatformOption } from "./platform.utils";

export function ClientConnectionApproval({
  requestId,
  setupId,
  setupProblem,
  clientId,
  platform,
  gateway,
  mcpServerName,
  onDecided,
  proxySelected,
  skillsSelected,
}: {
  requestId: string;
  setupId?: string;
  /**
   * Why the setup cannot be prepared and how to fix it (a selection over a
   * limit, or a refused request); null while it can still arrive.
   */
  setupProblem: string | null;
  clientId: string;
  platform: string;
  /** The gateway whose tools the client gets; null when tools are left out. */
  gateway: { id: string; name: string } | null;
  /** The name the client lists the gateway under. */
  mcpServerName: string;
  /** Called once the approval or denial is recorded. */
  onDecided?: () => void;
  proxySelected: boolean;
  skillsSelected: boolean;
}) {
  const client = CONNECT_CLIENTS.find((c) => c.id === clientId);
  const clientLabel = client?.label ?? "your agent";
  const request = useClientConnection(requestId);
  const decision = useDecideClientConnection(requestId);
  const [confirmed, setConfirmed] = useState(false);
  const gatewaySelected = gateway !== null;
  const appName = useAppName();
  const clientSteps =
    clientId === "cursor" ||
    (clientId === "claude-desktop" && gatewaySelected) ? (
      <>
        {clientId === "cursor" && (
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {gatewaySelected && (
              <li>
                In Cursor, open Customize → MCPs and authenticate the gateway.
              </li>
            )}
            {skillsSelected && <li>Reload Cursor to see shared skills.</li>}
            {proxySelected && (
              <li>
                Quit and reopen Cursor to load its model settings. Add models
                under Settings → Models by their provider-qualified id, such as
                anthropic:&lt;model&gt;.
              </li>
            )}
          </ul>
        )}
        {clientId === "claude-desktop" && gatewaySelected && (
          <ClaudeDesktopGatewaySteps gatewayName={mcpServerName} />
        )}
      </>
    ) : null;
  const approved = decision.data?.status === "approved";
  if (decision.data)
    return (
      <output className="block space-y-4 p-5 text-sm sm:p-6">
        {approved ? (
          <ApprovedHandoff
            clientId={clientId}
            clientLabel={clientLabel}
            appName={appName}
            platform={platform}
            gateway={gateway}
            mcpServerName={mcpServerName}
            proxySelected={proxySelected}
            skillsSelected={skillsSelected}
            clientSteps={clientSteps}
          />
        ) : (
          <InlineNotice variant="neutral">
            <span>
              Connection denied. The installer cannot apply this setup.
            </span>
          </InlineNotice>
        )}
      </output>
    );
  if (request.isError)
    return (
      <div className="p-5 sm:p-6">
        <InlineNotice variant="error" role="alert">
          <TriangleAlert aria-hidden />
          <InlineNoticeText>
            This connection request is unavailable or expired. Start the
            installer again.
          </InlineNoticeText>
        </InlineNotice>
      </div>
    );
  if (!request.data)
    // The card's own layout with placeholders, so the request lands without
    // moving anything.
    return (
      <div aria-busy>
        <div className="space-y-3 p-4 sm:p-5">
          <CardHeading client={client} />
          <div className="rounded-lg border bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground">Terminal code</p>
            <div className="flex h-7 items-center">
              <Skeleton className="h-5 w-36" />
            </div>
          </div>
          <div className="flex h-5 items-center">
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        {/* Outside the spaced column, so it adds no gap. */}
        <output className="sr-only">Loading connection request…</output>
        <div className="flex flex-wrap gap-2 border-t bg-muted/20 px-4 py-3 sm:px-5">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-8 w-16" />
        </div>
      </div>
    );
  const matches =
    request.data.clientId === clientId && request.data.platform === platform;
  const requestedClientId = request.data.clientId;
  const requestedClientLabel =
    CONNECT_CLIENTS.find((c) => c.id === requestedClientId)?.label ??
    "another app";
  // Approve stays off until every check passes; the tooltip names the first
  // one that does not, and what to do about it.
  const approveBlockedReason = !matches
    ? `Your terminal asked to connect ${requestedClientLabel} on ${platformLabels[toPlatformOption(request.data.platform)]}. Select the same app and operating system on this page, then approve.`
    : setupProblem
      ? setupProblem
      : !confirmed
        ? "Check that the code above matches the code in your terminal, then select the checkbox to confirm it."
        : !setupId
          ? "Preparing the setup for your terminal. Approve turns on as soon as it is ready."
          : null;
  // Something is still on its way (the setup, or the decision being sent):
  // show it moving, so a disabled button does not read as stuck.
  const working = (!setupId && !setupProblem) || decision.isPending;
  const approveDisabledReason =
    approveBlockedReason ??
    (decision.isPending ? "Sending your decision…" : null);
  return (
    <div>
      <div className="space-y-3 p-4 sm:p-5">
        <CardHeading client={client} />
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Terminal code</p>
            <p className="break-all font-mono text-xl font-semibold tracking-wider">
              {request.data.userCode}
            </p>
          </div>
          {request.data.deviceName && (
            <p className="break-words pb-1 text-xs text-muted-foreground">
              <span>from </span>
              <span className="font-medium text-foreground">
                {request.data.deviceName}
              </span>
            </p>
          )}
        </div>
        <label
          htmlFor="confirm-connection-code"
          className="flex items-center gap-2.5 text-sm"
        >
          <Checkbox
            id="confirm-connection-code"
            checked={confirmed}
            onCheckedChange={(value) => setConfirmed(value === true)}
          />
          <span>This code matches the code in my terminal.</span>
        </label>
        {!matches && (
          <InlineNotice role="alert">
            <TriangleAlert aria-hidden />
            <InlineNoticeText>
              Select the requested client and operating system before approving.
            </InlineNoticeText>
          </InlineNotice>
        )}
      </div>
      <div className="flex flex-wrap gap-2 border-t bg-muted/20 px-4 py-3 sm:px-5">
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled button gets no pointer or focus events, so this
                wrapper carries the reason. It stays mounted either way, so
                Approve keeps its identity and focus when it turns on. */}
            <span
              className="inline-flex"
              tabIndex={approveDisabledReason ? 0 : undefined}
            >
              <Button
                size="sm"
                disabled={approveDisabledReason !== null}
                onClick={() =>
                  decision.mutate(
                    { decision: "approve", setupId: setupId as string },
                    {
                      // Tell the Connect page in another tab to show what's next.
                      onSuccess: (result) => {
                        if (result?.status === "approved") postConnected();
                        onDecided?.();
                      },
                    },
                  )
                }
              >
                {/* The icon changes, not the width: Deny stays in place
                    when the setup is ready. */}
                {working ? (
                  <Loader2
                    aria-hidden
                    data-testid="approve-connection-progress"
                    className="animate-spin"
                  />
                ) : (
                  <Check aria-hidden />
                )}
                <span>Approve connection</span>
              </Button>
            </span>
          </TooltipTrigger>
          {approveDisabledReason && (
            <TooltipContent className="max-w-xs">
              {approveDisabledReason}
            </TooltipContent>
          )}
        </Tooltip>
        <Button
          size="sm"
          variant="outline"
          disabled={decision.isPending}
          onClick={() =>
            decision.mutate({ decision: "deny" }, { onSuccess: onDecided })
          }
        >
          <span>Deny</span>
        </Button>
      </div>
    </div>
  );
}

function CardHeading({ client }: { client: ConnectClient | undefined }) {
  return (
    <div className="flex items-start gap-3">
      {client && <ClientIcon client={client} size={24} />}
      <div className="min-w-0 space-y-0.5">
        <h2 className="text-sm font-semibold">Confirm the connection</h2>
        <p className="text-sm text-muted-foreground">
          Check the code matches your terminal, then approve.
        </p>
      </div>
    </div>
  );
}
