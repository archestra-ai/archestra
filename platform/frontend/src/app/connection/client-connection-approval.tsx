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
}: {
  requestId: string;
  setupId?: string;
  clientId: string;
  platform: string;
}) {
  const request = useClientConnection(requestId);
  const decision = useDecideClientConnection(requestId);
  const [confirmed, setConfirmed] = useState(false);
  if (decision.data)
    return (
      <output className="block p-5">
        <span>
          {decision.data.status === "approved"
            ? "Connection approved. Return to your terminal to finish setup."
            : "Connection denied. The installer cannot apply this setup."}
        </span>
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
      <p>
        <span>Your terminal requested setup for </span>
        <strong>{request.data.clientId}</strong>
        <span> on </span>
        <strong>{request.data.platform}</strong>
        <span>.</span>
      </p>
      <p className="text-sm text-muted-foreground">
        Approve only a request you started. Approval lets that terminal apply
        the configuration reviewed above.
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
