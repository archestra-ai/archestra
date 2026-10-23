"use client";

import { BookOpen, CircleCheck, Route, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/tailwind";
import { ClientIcon } from "./client-icon";
import { CONNECT_CLIENTS } from "./clients";
import { GatewayLink } from "./gateway-link";

/**
 * What the browser shows once a terminal's connection request is approved:
 * the installer is waiting in the terminal, so the card sends the reader back
 * there and shows the prompts they are about to answer.
 */
export function ApprovedHandoff({
  clientId,
  clientLabel,
  appName,
  platform,
  gateway,
  mcpServerName,
  proxySelected,
  skillsSelected,
  clientSteps,
}: {
  clientId: string;
  clientLabel: string;
  appName: string;
  platform: string;
  /** The gateway whose tools the client gets; null when tools are left out. */
  gateway: { id: string; name: string } | null;
  /** The name the client lists the gateway under, as the installer prints it. */
  mcpServerName: string;
  proxySelected: boolean;
  skillsSelected: boolean;
  /** What is left to do inside the client itself, such as Cursor's sign-in. */
  clientSteps: ReactNode;
}) {
  const client = CONNECT_CLIENTS.find((c) => c.id === clientId);
  const desktop = clientId === "claude-desktop";
  const lines = terminalLines({
    clientId,
    clientLabel,
    appName,
    platform,
    gatewayName: gateway ? mcpServerName : null,
  });
  const firstPrompt = lines.findIndex((line) => line.kind === "prompt");

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        {client && (
          <div className="relative shrink-0">
            <ClientIcon client={client} size={40} />
            <CircleCheck
              aria-hidden
              className="absolute -right-1.5 -bottom-1.5 size-5 rounded-full bg-background text-emerald-600 dark:text-emerald-400"
            />
          </div>
        )}
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Approved in the browser
          </p>
          <h2 className="text-base font-semibold leading-tight tracking-tight">
            {desktop
              ? "Finish in the setup terminal"
              : "Switch back to your terminal"}
          </h2>
          <p className="text-muted-foreground">
            {desktop
              ? `It applies the settings and restarts ${clientLabel}, so finish any active tasks there first. You can close this tab.`
              : `The installer is waiting there to finish connecting ${clientLabel} to ${appName}. You can close this tab.`}
          </p>
        </div>
      </div>

      <figure className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300 shadow-sm">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
          <span aria-hidden className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-zinc-700" />
            <span className="size-2.5 rounded-full bg-zinc-700" />
            <span className="size-2.5 rounded-full bg-zinc-700" />
          </span>
          <figcaption className="text-[11px] font-medium text-zinc-500">
            Next in your terminal
          </figcaption>
        </div>
        <div className="space-y-2 overflow-x-auto px-4 py-3.5 font-mono text-xs leading-relaxed">
          {lines.map((line, index) => (
            <TerminalLine
              key={`${line.kind}-${line.text}`}
              line={line}
              waiting={index === firstPrompt}
            />
          ))}
        </div>
      </figure>

      {(gateway || skillsSelected || proxySelected) && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            What {clientLabel} gets
          </h3>
          <ul className="divide-y rounded-lg border">
            {gateway && (
              <GetsRow icon={<Wrench className="size-4" />}>
                <span>Tools from </span>
                <GatewayLink gateway={gateway} className="font-medium" />
              </GetsRow>
            )}
            {skillsSelected && (
              <GetsRow icon={<BookOpen className="size-4" />}>
                <span>Your organization&apos;s shared skills</span>
              </GetsRow>
            )}
            {proxySelected && (
              <GetsRow icon={<Route className="size-4" />}>
                <span>Model requests routed through the LLM Proxy</span>
              </GetsRow>
            )}
          </ul>
        </section>
      )}

      {clientSteps && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            Then, in {clientLabel}
          </h3>
          <div>{clientSteps}</div>
        </section>
      )}
    </div>
  );
}

// ===

type TerminalLineSpec =
  | { kind: "done"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "plain"; text: string }
  /** Nested prompts sit under the heading they answer, as the installer indents them. */
  | { kind: "prompt"; text: string; nested: boolean };

/**
 * The installer's own wording, in order, for what follows the approval. It
 * mirrors finishSetup in the backend's client-connection-installer and the
 * Desktop setup script, so a reader recognizes each line when it appears.
 */
function terminalLines(params: {
  clientId: string;
  clientLabel: string;
  appName: string;
  platform: string;
  gatewayName: string | null;
}): TerminalLineSpec[] {
  const { clientId, clientLabel, appName, platform, gatewayName } = params;
  const approved: TerminalLineSpec = {
    kind: "done",
    text: "Browser approval confirmed.",
  };
  if (clientId === "claude-desktop") {
    return [
      approved,
      {
        kind: "plain",
        text: "Applying Desktop setup. Finish any active tasks before continuing.",
      },
      {
        kind: "done",
        text: "Desktop is configured. Send a message and check LLM Proxy Logs.",
      },
    ];
  }
  const lines: TerminalLineSpec[] = [
    approved,
    { kind: "done", text: `${clientLabel} is connected to ${appName}.` },
  ];
  const binary = LAUNCHED_BINARIES[clientId];
  if (gatewayName) {
    lines.push({
      kind: "heading",
      text: `Authorize ${clientLabel} for the "${gatewayName}" MCP gateway`,
    });
    lines.push(
      SIGNS_IN_FROM_INSTALLER.has(clientId)
        ? {
            kind: "prompt",
            text: `Authorize now? This opens ${appName} in your browser. [Y/n]`,
            nested: true,
          }
        : { kind: "plain", text: signInElsewhere(clientId, gatewayName) },
    );
  }
  if (!binary) {
    lines.push({
      kind: "heading",
      text: `Next: open ${clientLabel} to start using ${appName}.`,
    });
  } else if (platform === "windows") {
    lines.push({
      kind: "heading",
      text: `Next: open a new terminal and run: ${binary} …`,
    });
  } else {
    lines.push({
      kind: "prompt",
      text: `Start ${clientLabel} now? [Y/n]`,
      nested: false,
    });
  }
  return lines;
}

/** Clients whose gateway sign-in the installer can run itself. */
const SIGNS_IN_FROM_INSTALLER: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "opencode",
  "kilo",
]);

/** Clients the installer can start for you, by the command it runs. */
const LAUNCHED_BINARIES: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  "copilot-cli": "copilot",
  opencode: "opencode",
  kilo: "kilo",
};

/** Where the gateway sign-in happens for a client the installer cannot run it for. */
function signInElsewhere(clientId: string, serverName: string): string {
  if (clientId === "pi")
    return `Run pi mcp login ${serverName}, then use the Pi launch command printed in your terminal.`;
  if (clientId === "cursor")
    return `In Cursor, open Customize > MCPs and sign in to "${serverName}".`;
  return "Copilot opens your browser to sign in the first time it uses these tools.";
}

function TerminalLine({
  line,
  waiting,
}: {
  line: TerminalLineSpec;
  waiting: boolean;
}) {
  if (line.kind === "done")
    return (
      <p className="text-zinc-400">
        <span className="text-emerald-400">✓</span> <span>{line.text}</span>
      </p>
    );
  if (line.kind === "heading")
    return <p className="pt-1 font-semibold text-zinc-100">{line.text}</p>;
  if (line.kind === "plain")
    return <p className="pl-2 text-zinc-400">{line.text}</p>;
  return (
    <p
      className={cn(
        "whitespace-nowrap text-zinc-100",
        line.nested ? "pl-2" : "pt-1 font-semibold",
      )}
    >
      <span>{line.text}</span>{" "}
      {waiting && (
        <span
          aria-hidden
          className="inline-block h-3.5 w-1.5 translate-y-0.5 bg-zinc-300 motion-safe:animate-pulse"
        />
      )}
    </p>
  );
}

function GetsRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}
