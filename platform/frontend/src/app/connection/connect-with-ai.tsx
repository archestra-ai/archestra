"use client";

import { Terminal } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";

export function ConnectWithAi() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setPrompt(
            `Read ${window.location.origin}/connect.md and connect this client.`,
          );
          setOpen(true);
        }}
      >
        <Terminal className="size-4" />
        <span>Connect with your AI</span>
      </Button>
      <StandardDialog
        open={open}
        onOpenChange={setOpen}
        title="Connect with your AI"
        description="Paste this prompt into Claude Code, Cursor, Codex, or Copilot CLI. Your AI handles setup; you review and approve it in your browser."
      >
        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-4">
          <code className="min-w-0 flex-1 break-words text-sm">{prompt}</code>
          <CopyButton text={prompt} />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          No skill to install first. Requires Node.js 18 or later.
        </p>
      </StandardDialog>
    </>
  );
}
