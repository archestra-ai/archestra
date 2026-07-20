"use client";

import { ChevronDown } from "lucide-react";
import type { ConnectClient } from "./clients";
import { type DisconnectStep, getDisconnectSteps } from "./disconnect";
import { TerminalBlock } from "./terminal-block";

interface DisconnectSectionProps {
  client: ConnectClient;
  /** The server name the gateway is registered under in the client's config. */
  serverName: string;
  appName: string;
}

/**
 * A collapsible "Disconnect" panel shown beneath the connect flow. Detaching is
 * always a local change to the client's own config, so it keeps working when
 * the proxy or the platform is down — the exact situation where you most need
 * to get out.
 */
export function DisconnectSection({
  client,
  serverName,
  appName,
}: DisconnectSectionProps) {
  const steps = getDisconnectSteps(client.id, { serverName, appName });

  return (
    <details className="group mt-8 rounded-lg border border-dashed border-border bg-muted/20">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-sm font-medium">
        <span>Disconnect {client.label}</span>
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-dashed border-border p-4">
        <p className="text-sm text-muted-foreground">
          Detaching only changes {client.label}'s own config, so it works even
          when {appName} or the proxy is unreachable.
        </p>
        <ol className="mt-4 space-y-4">
          {steps.map((step, index) => (
            <Step key={step.title} step={step} index={index} />
          ))}
        </ol>
      </div>
    </details>
  );
}

function Step({ step, index }: { step: DisconnectStep; index: number }) {
  return (
    <li className="text-sm">
      <div className="font-medium">
        {index + 1}. {step.title}
      </div>
      {step.body ? (
        <p className="mt-1 text-muted-foreground">{step.body}</p>
      ) : null}
      {step.command ? (
        <div className="mt-2">
          <TerminalBlock code={step.command} />
        </div>
      ) : null}
    </li>
  );
}
