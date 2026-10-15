"use client";

import { Check, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { LoadingState } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
import { ClaudeDesktopGatewaySteps } from "./claude-desktop-gateway-steps";
import { ClientIcon } from "./client-icon";
import { CONNECT_CLIENTS } from "./clients";
import { platformLabels, toPlatformOption } from "./platform.utils";

export function ClientConnectionApproval({
  requestId,
  setupId,
  setupProblem,
  clientId,
  platform,
  gatewaySelected,
  gatewayName,
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
  gatewaySelected: boolean;
  gatewayName: string;
  proxySelected: boolean;
  skillsSelected: boolean;
}) {
  const client = CONNECT_CLIENTS.find((c) => c.id === clientId);
  const clientLabel = client?.label ?? "your agent";
  const request = useClientConnection(requestId);
  const decision = useDecideClientConnection(requestId);
  const [confirmed, setConfirmed] = useState(false);
  if (decision.data)
    return (
      <output className="block space-y-4 p-5 text-sm sm:p-6">
        {decision.data.status === "approved" ? (
          <>
            <InlineNotice variant="success">
              <Check aria-hidden />
              <span>
                Connection approved. Return to your terminal to finish setup.
              </span>
            </InlineNotice>
            {(gatewaySelected || skillsSelected || proxySelected) && (
              <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">
                <p className="font-medium">What happens next</p>
                <p className="text-muted-foreground">
                  Once setup is complete, start a new {clientLabel} session. It
                  will have access to:
                </p>
                <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {gatewaySelected && <li>The tools from {gatewayName}</li>}
                  {skillsSelected && (
                    <li>Your organization&apos;s shared skills</li>
                  )}
                  {proxySelected && (
                    <li>Model requests routed through the LLM Proxy</li>
                  )}
                </ul>
                <p className="text-muted-foreground">
                  Ask {clientLabel} to use them like any other tool or skill.
                </p>
              </div>
            )}
            {clientId === "cursor" && (
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                {gatewaySelected && (
                  <li>
                    In Cursor, open Customize → MCPs and authenticate the
                    gateway.
                  </li>
                )}
                {skillsSelected && <li>Reload Cursor to see shared skills.</li>}
                {proxySelected && (
                  <li>
                    Quit and reopen Cursor to load its model settings. Add
                    models under Settings → Models by their provider-qualified
                    id, such as anthropic:&lt;model&gt;.
                  </li>
                )}
              </ul>
            )}
            {clientId === "claude-desktop" && gatewaySelected && (
              <ClaudeDesktopGatewaySteps gatewayName={gatewayName} />
            )}
          </>
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
    return (
      <div className="p-5 sm:p-6">
        <LoadingState
          variant="inline"
          showLabel
          label="Loading connection request…"
        />
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
  const approveDisabledReason =
    approveBlockedReason ??
    (decision.isPending ? "Sending your decision…" : null);
  return (
    <div>
      <div className="space-y-3 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          {client && <ClientIcon client={client} size={24} />}
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-sm font-semibold">Confirm the connection</h2>
            <p className="text-sm text-muted-foreground">
              Check the code matches your terminal, then approve.
            </p>
          </div>
        </div>
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
                      },
                    },
                  )
                }
              >
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
          onClick={() => decision.mutate({ decision: "deny" })}
        >
          <span>Deny</span>
        </Button>
      </div>
    </div>
  );
}
