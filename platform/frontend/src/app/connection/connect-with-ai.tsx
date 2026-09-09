"use client";

import { ArrowRight, Check, Copy, Terminal } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

export function ConnectWithAi() {
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
        <p className="mt-1 text-xs text-muted-foreground/70">
          Claude Code, Codex, or Copilot CLI · Node.js 18+
        </p>
        <div className="mt-9">
          <Link
            href="/connection?mode=manual"
            className="group inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>Other ways to connect</span>
            <ArrowRight className="size-3.5" />
          </Link>
          <p className="mt-2 text-xs text-muted-foreground/70">
            Claude Desktop, Cursor, n8n, and manual setup
          </p>
        </div>
      </div>
    </main>
  );
}
