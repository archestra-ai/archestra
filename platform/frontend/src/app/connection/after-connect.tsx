"use client";

// What comes after the connect prompt: a status card under the connect band.
// Copying the prompt starts it waiting; a "connected" broadcast from the
// approval tab (or "Done?") turns it into the welcome prompt. The "Show the
// starter prompt" link opens the same prompt any time.

import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConnectClient } from "./clients";
import {
  nameOf,
  PromptRow,
  sentenceNameOf,
  TextButton,
  useCopy,
} from "./connect-page-parts";

export type AfterConnectPhase = "idle" | "waiting" | "connected" | "starter";

/** The card's state, and the setup it was entered from. */
export interface AfterConnectRun {
  phase: AfterConnectPhase;
  /** The setup (agent, mode, choices) the phase belongs to. */
  key: string;
  /** The agent the prompt was copied for. */
  client: ConnectClient;
  /** The installer command was copied, not the prompt. */
  script: boolean;
}

export function AfterConnect({
  phase,
  client,
  script,
  welcome,
  showLink,
  onPhase,
}: {
  phase: AfterConnectPhase;
  client: ConnectClient;
  script: boolean;
  /** The welcome prompt; null until the page knows its origin. */
  welcome: string | null;
  /** Offer "Show the starter prompt" while idle. */
  showLink: boolean;
  onPhase: (phase: AfterConnectPhase) => void;
}) {
  const name = nameOf(client);
  // The installer ends with a command that starts every script agent but
  // Cursor, which has no command to start.
  const launches = script && client.id !== "cursor";
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
    <>
      {phase === "idle" && showLink && (
        <div className="flex justify-end pt-2 pr-1.5 text-xs text-muted-foreground">
          <TextButton onClick={() => onPhase("starter")}>
            Show the starter prompt
          </TextButton>
        </div>
      )}

      {/* Announces the status as it moves on, not the starter card. */}
      <div aria-live="polite">
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
                {script ? "The command" : sentenceNameOf(client)} opens a
                browser page. Approve there and this card moves on by itself.
              </p>
              <span className="text-xs text-muted-foreground">
                <TextButton onClick={() => onPhase("connected")}>
                  Done? Show the next step
                </TextButton>
              </span>
              <Button
                variant="outline"
                size="xs"
                onClick={() => onPhase("idle")}
              >
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
                {launches
                  ? `Your terminal ends with a command that starts ${name} and asks it what it can do. You can also paste this into a new ${name} session.`
                  : `Once ${script ? "your terminal" : name} says setup is done, paste this into a new ${name} session.`}
              </p>
              <WelcomePrompt text={welcome} />
            </section>
          </>
        )}
      </div>

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
            to the Connect page.
          </p>
          <WelcomePrompt text={welcome} />
        </section>
      )}
    </>
  );
}

function WelcomePrompt({ text }: { text: string | null }) {
  const { copied, copy } = useCopy();
  return (
    <PromptRow
      text={text}
      copied={copied}
      onCopy={() => text && void copy(text)}
    />
  );
}

/** Joins the connect band to the status card below it. */
function Stem() {
  return <div aria-hidden className="mx-auto h-8 w-px bg-foreground/60" />;
}
