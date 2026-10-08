"use client";

import { Check, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { LoadingState } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  useClientConnection,
  useDecideClientConnection,
} from "@/lib/client-connection.query";
import { ClaudeDesktopGatewaySteps } from "./claude-desktop-gateway-steps";
import { ClientIcon } from "./client-icon";
import { CONNECT_CLIENTS } from "./clients";

export function ClientConnectionApproval({
  requestId,
  setupId,
  clientId,
  platform,
  gatewaySelected,
  gatewayName,
  proxySelected,
  proxyUsesVirtualKey,
  skillsSelected,
}: {
  requestId: string;
  setupId?: string;
  clientId: string;
  platform: string;
  gatewaySelected: boolean;
  gatewayName: string;
  proxySelected: boolean;
  proxyUsesVirtualKey: boolean;
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
                {proxySelected && proxyUsesVirtualKey && (
                  <li>
                    For model routing, find “Cursor model settings (manual
                    step)” in the output of the setup command Cursor ran. Paste
                    its proxy URL and virtual key into Cursor Settings → Models
                    → API Keys.
                  </li>
                )}
                {proxySelected && !proxyUsesVirtualKey && (
                  <li>
                    For model routing, find “Cursor model settings (manual
                    step)” in the output of the setup command Cursor ran. Paste
                    its proxy URL and your own OpenAI API key into Cursor
                    Settings → Models → API Keys.
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
  return (
    <div>
      <div className="space-y-5 p-5 sm:p-6">
        <div className="flex items-center gap-3">
          {client && <ClientIcon client={client} size={32} />}
          <h2 className="text-base font-semibold tracking-tight">
            Confirm the connection
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Confirm the code matches your terminal. Approval lets your AI apply
          the selected setup to your client.
        </p>
        <div className="space-y-2 rounded-lg border bg-muted/40 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">
            Terminal code
          </p>
          <p className="break-all font-mono text-2xl font-semibold tracking-wider">
            {request.data.userCode}
          </p>
        </div>
        {request.data.deviceName && (
          <p className="break-words text-sm text-muted-foreground">
            <span>Requested from </span>
            <span className="font-medium text-foreground">
              {request.data.deviceName}
            </span>
          </p>
        )}
        <label
          htmlFor="confirm-connection-code"
          className="flex items-start gap-2.5 text-sm leading-relaxed"
        >
          <Checkbox
            id="confirm-connection-code"
            className="mt-0.5"
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
      <div className="flex flex-wrap gap-2 border-t bg-muted/20 px-5 py-4 sm:px-6">
        <Button
          size="sm"
          disabled={!confirmed || !matches || !setupId || decision.isPending}
          onClick={() =>
            decision.mutate({ decision: "approve", setupId: setupId as string })
          }
        >
          <span>Approve connection</span>
        </Button>
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
