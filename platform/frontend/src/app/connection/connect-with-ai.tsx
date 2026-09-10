"use client";

import { ArrowRight, Check, Copy, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyToClipboard } from "@/lib/clipboard";
import { ClientIcon } from "./client-icon";
import { CONNECT_CLIENTS } from "./clients";

export function ConnectWithAi({
  onManualSetup,
}: {
  onManualSetup: () => void;
}) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  const prompt = `Read ${origin}/connect.md and connect this client.`;

  return (
    <main
      id="main-content"
      className="flex min-h-[75dvh] items-center justify-center px-6 py-16"
    >
      <div className="w-full max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Connect your{" "}
          <span className="bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent">
            AI
          </span>
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          Paste this into your coding agent. It handles the setup.
        </p>
        <div className="mt-8 overflow-hidden rounded-xl border border-zinc-700/60 bg-[#111113] text-zinc-100 shadow-xl shadow-black/10">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <span className="inline-flex items-center gap-2 text-xs text-zinc-400">
              <Terminal className="size-3.5" />
              <span>Prompt your agent</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={!origin}
              className="h-7 gap-2 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
              onClick={async () => {
                try {
                  await copyToClipboard(prompt);
                  setCopied(true);
                } catch {
                  toast.error(
                    "Could not copy. Select the prompt and copy it manually.",
                  );
                }
              }}
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              <span>{copied ? "Copied" : "Copy prompt"}</span>
            </Button>
          </div>
          <div className="flex gap-4 px-5 py-7 sm:px-7 sm:py-9">
            <span
              aria-hidden="true"
              className="select-none font-mono text-primary"
            >
              ›
            </span>
            <code className="min-w-0 break-words font-mono text-sm leading-7 sm:text-base">
              {origin ? prompt : "Loading your connection prompt…"}
            </code>
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          You review and approve the connection in your browser.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <ClientLogos
            ids={["claude-code", "codex", "cursor", "copilot-cli"]}
          />
          <span className="text-xs text-muted-foreground/70">Node.js 18+</span>
        </div>
        <div className="mt-6">
          <Button
            variant="link"
            onClick={onManualSetup}
            className="h-auto gap-1.5 p-0 text-xs text-primary underline underline-offset-4 hover:text-primary/80 has-[>svg]:px-0"
          >
            <span>Other ways to connect</span>
            <ArrowRight className="size-3" />
          </Button>
          <div className="mt-3 flex items-center gap-3">
            <ClientLogos ids={["claude-desktop", "cursor", "n8n"]} />
            <span className="text-xs text-muted-foreground/70">
              and manual setup
            </span>
          </div>
        </div>
      </div>
    </main>
  );
}

function ClientLogos({ ids }: { ids: string[] }) {
  return (
    <div className="flex items-center gap-2">
      {ids.map((id) => {
        const client = CONNECT_CLIENTS.find((entry) => entry.id === id);
        return client ? (
          <Tooltip key={id}>
            <TooltipTrigger aria-label={client.label} className="rounded-md">
              <ClientIcon client={client} size={24} />
            </TooltipTrigger>
            <TooltipContent>{client.label}</TooltipContent>
          </Tooltip>
        ) : null;
      })}
    </div>
  );
}
