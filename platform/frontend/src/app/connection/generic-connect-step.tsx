"use client";

import { Check, Copy } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { copyToClipboard } from "@/lib/clipboard";
import type { ConnectClient } from "./clients";
import type { ConnectChoices } from "./connect-choices";
import { useUpdateUrlParams } from "./use-update-url-params";

/**
 * Apps on the generic instructions are set up from a prompt by default; the
 * manual instructions are one switch away. Kept in the URL so links (and the
 * prompt's instructions) can point at either.
 */
export function useGenericMode(): "prompt" | "manual" {
  return useSearchParams().get("mode") === "manual" ? "manual" : "prompt";
}

export function GenericModeSwitch() {
  const mode = useGenericMode();
  const updateUrlParams = useUpdateUrlParams();
  return (
    <Tabs
      value={mode}
      onValueChange={(v) =>
        updateUrlParams({ mode: v === "manual" ? "manual" : null })
      }
    >
      <TabsList size="sm" aria-label="Setup method">
        <TabsTrigger value="prompt">Prompt</TabsTrigger>
        <TabsTrigger value="manual">Manual</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/**
 * The prompt for an app without a tailored installer. It stays a short
 * pointer: connect.md?client=generic has the agent check what its app
 * supports and holds every other instruction. Only the review step's choices
 * ride along in the URL.
 */
export function GenericConnectPrompt({
  client,
  choices,
  gatewaySlug,
  proxyAvailable,
  skillsAvailable,
  baseUrl,
}: {
  client: ConnectClient;
  choices: ConnectChoices;
  /** The selected gateway's slug; null when no gateway is offered. */
  gatewaySlug: string | null;
  proxyAvailable: boolean;
  skillsAvailable: boolean;
  baseUrl: string;
}) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const setup = [
    gatewaySlug && choices.tools && "tools",
    skillsAvailable && choices.skills && "skills",
    proxyAvailable && choices.proxy && "models",
  ].filter((part): part is string => !!part);
  const params = new URLSearchParams({ client: "generic" });
  if (gatewaySlug && setup.includes("tools")) {
    params.set("gateway", gatewaySlug);
  }
  params.set("setup", setup.join(","));
  // connect.md falls back to this page's own origin.
  if (baseUrl !== `${origin}/v1`) params.set("base", baseUrl);
  const query = decodeURIComponent(params.toString());
  const prompt = `Read ${origin}/connect.md?${query} and connect ${client.label}.`;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Paste this prompt into {client.label}. It checks what {client.label}{" "}
        supports and asks before changing anything.
      </p>
      {setup.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Turn on at least one part of the setup above.
        </p>
      ) : (
        <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
          <code className="min-w-0 flex-1 break-words font-mono text-sm leading-6">
            {origin ? prompt : "Loading your connection prompt…"}
          </code>
          <CopyButton value={prompt} disabled={!origin} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        It backs up every config file it edits. To disconnect, ask{" "}
        {client.label} to remove what it added.
      </p>
    </div>
  );
}

function CopyButton({ value, disabled }: { value: string; disabled: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      className="shrink-0"
      aria-label={copied ? "Copied" : "Copy prompt"}
      title={copied ? "Copied" : "Copy prompt"}
      onClick={async () => {
        try {
          await copyToClipboard(value);
          setCopied(true);
        } catch {
          toast.error(
            "Could not copy. Select the prompt and copy it manually.",
          );
        }
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
