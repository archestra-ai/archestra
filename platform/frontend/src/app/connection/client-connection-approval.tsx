"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  useClientConnection,
  useDecideClientConnection,
} from "@/lib/client-connection.query";

export function ClientConnectionApproval({
  requestId,
  setupId,
  clientId,
  platform,
  gatewaySelected,
  proxySelected,
  skillsSelected,
}: {
  requestId: string;
  setupId?: string;
  clientId: string;
  platform: string;
  gatewaySelected: boolean;
  proxySelected: boolean;
  skillsSelected: boolean;
}) {
  const request = useClientConnection(requestId);
  const decision = useDecideClientConnection(requestId);
  const [confirmed, setConfirmed] = useState(false);
  if (decision.data)
    return (
      <output className="block space-y-3 p-5 text-sm">
        {decision.data.status === "approved" ? (
          <>
            <p>Connection approved. Return to your terminal to finish setup.</p>
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
                    To route OpenAI model requests, enter the proxy URL and key
                    in Cursor Settings → Models → API Keys.
                  </li>
                )}
              </ul>
            )}
            {clientId === "claude-desktop" && gatewaySelected && (
              <p className="text-muted-foreground">
                After Claude Desktop restarts, connect the gateway in Settings →
                Connectors and enable it in your conversation.
              </p>
            )}
          </>
        ) : (
          <p>Connection denied. The installer cannot apply this setup.</p>
        )}
      </output>
    );
  if (request.isError)
    return (
      <p role="alert" className="p-5">
        <span>
          This connection request is unavailable or expired. Start the installer
          again.
        </span>
      </p>
    );
  if (!request.data)
    return (
      <output className="block p-5">
        <span>Loading connection request…</span>
      </output>
    );
  const matches =
    request.data.clientId === clientId && request.data.platform === platform;
  return (
    <div className="space-y-4 p-5">
      <p className="text-sm text-muted-foreground">
        Confirm the code matches your terminal. Approval lets your AI apply the
        setup above to your client.
      </p>
      <p className="font-mono text-2xl font-semibold tracking-wider">
        {request.data.userCode}
      </p>
      <label
        htmlFor="confirm-connection-code"
        className="flex items-center gap-2 text-sm"
      >
        <Checkbox
          id="confirm-connection-code"
          checked={confirmed}
          onCheckedChange={(value) => setConfirmed(value === true)}
        />
        <span>This code matches the code in my terminal.</span>
      </label>
      {!matches && (
        <p role="alert">
          <span>
            Select the requested client and operating system before approving.
          </span>
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={!confirmed || !matches || !setupId || decision.isPending}
          onClick={() =>
            decision.mutate({ decision: "approve", setupId: setupId as string })
          }
        >
          <span>Approve connection</span>
        </Button>
        <Button
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
