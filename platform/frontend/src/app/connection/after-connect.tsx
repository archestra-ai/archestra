"use client";

// What comes after the connect prompt: a status card under the connect band.
// Copying the prompt starts it waiting; a "connected" broadcast from the
// approval tab (or "Done?") turns it into the welcome prompt. The "Show the
// starter prompt" link opens the same prompt any time.

import { Check, Copy, Loader2, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { copyToClipboard } from "@/lib/clipboard";
import { type ConnectClient, usesGenericInstructions } from "./clients";
import { nameOf } from "./connect-page-parts";

export type AfterConnectPhase = "idle" | "waiting" | "connected" | "starter";

export function AfterConnect({
  phase,
  client,
  script,
  welcome,
  showLink,
  onPhase,
}: {
  phase: AfterConnectPhase;
  /** The agent the prompt was copied for. */
  client: ConnectClient;
  /** The installer command was copied, not the prompt. */
  script: boolean;
  /** The welcome prompt. */
  welcome: string;
  /** Offer "Show the starter prompt" while idle. */
  showLink: boolean;
  onPhase: (phase: AfterConnectPhase) => void;
}) {
  const name = nameOf(client);
  const Name = capitalize(name);
  const close = (
    <Button
      variant="outline"
      size="xs"
      className="ml-auto"
      onClick={() => onPhase("idle")}
    >
      <X />
      Close
    </Button>
  );

  return (
    <div aria-live="polite">
      {phase === "idle" && showLink && (
        <div className="flex justify-end pt-2 pr-1.5 text-xs text-muted-foreground">
          <TextButton onClick={() => onPhase("starter")}>
            Show the starter prompt
          </TextButton>
        </div>
      )}

      {phase === "waiting" && (
        <>
          <Stem />
          <section
            aria-label="Connection status"
            className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card px-[18px] py-3.5 shadow-sm"
          >
            <Loader2
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
            />
            <p className="text-sm font-semibold">Waiting for approval</p>
            <p className="min-w-0 flex-1 basis-64 text-xs text-muted-foreground">
              {script ? "The command" : Name} opens a browser page. Approve
              there and this card moves on by itself.
            </p>
            <span className="text-xs text-muted-foreground">
              <TextButton onClick={() => onPhase("connected")}>
                Done? Show the next step
              </TextButton>
            </span>
            <Button variant="outline" size="xs" onClick={() => onPhase("idle")}>
              <X />
              Cancel
            </Button>
          </section>
        </>
      )}

      {phase === "connected" && (
        <>
          <Stem />
          <section
            aria-label="Connection status"
            className="grid gap-2 rounded-2xl border border-emerald-600/50 bg-card px-6 py-5 shadow-sm ring-[3px] ring-emerald-600/15"
          >
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="grid size-6 shrink-0 place-items-center rounded-full bg-emerald-600 text-white [&_svg]:size-3.5"
              >
                <Check strokeWidth={2.5} />
              </span>
              <h2 className="text-sm font-semibold">
                Connected. Next, ask {name} what it can do now
              </h2>
              {close}
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              Once{" "}
              {usesGenericInstructions(client) && !script
                ? name
                : "your terminal"}{" "}
              says setup is done, paste this into a new {name} session.
            </p>
            <WelcomePrompt text={welcome} />
          </section>
        </>
      )}

      {phase === "starter" && (
        <section
          aria-label="Starter prompt"
          className="mt-2.5 grid gap-2 rounded-2xl border bg-card px-5 py-4"
        >
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-semibold">Starter prompt</h2>
            {close}
          </div>
          <p className="px-1 text-xs text-muted-foreground">
            Works once {name} is connected. If it isn't yet, it points you back
            to the connect prompt.
          </p>
          <WelcomePrompt text={welcome} />
        </section>
      )}
    </div>
  );
}

/** The welcome prompt, in the same row as the connect prompt. */
function WelcomePrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyToClipboard(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Could not copy. Select the prompt and copy it manually.");
    }
  };
  return (
    <div className="flex min-h-16 items-center gap-3 rounded-2xl border bg-background py-2 pr-2 pl-5 shadow-sm">
      <code className="min-w-0 flex-1 font-mono text-sm leading-relaxed [overflow-wrap:anywhere]">
        {text}
      </code>
      <Button
        size="lg"
        onClick={copy}
        disabled={!text}
        className="h-12 shrink-0 rounded-xl px-6"
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy prompt"}
      </Button>
    </div>
  );
}

/** Joins the connect band to the status card below it. */
function Stem() {
  return <div aria-hidden className="mx-auto h-8 w-px bg-foreground/60" />;
}

function TextButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <UnstyledButton
      type="button"
      onClick={onClick}
      className="rounded-sm underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </UnstyledButton>
  );
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
