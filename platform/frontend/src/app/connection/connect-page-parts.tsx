"use client";

// Connect page pieces: picker, dialogs, helpers.

import { Check, Copy, History } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils/tailwind";
import { ClientIcon } from "./client-icon";
import type { ConnectClient } from "./clients";
import type { ConnectPageData } from "./connect-page-data";

// The markdown renderer is large; only a skill being read needs it.

// === Agent picker: the searchable list behind "Other agents" ===

export function AgentSearch({
  data,
  selectedId,
  lastConnectedId,
  onPick,
  tiled,
  children,
}: {
  data: ConnectPageData;
  selectedId: string;
  /** The agents with their own tile; the list holds the rest. */
  tiled?: ConnectClient[];
  /** The agent the user connected last, marked in the list. */
  lastConnectedId?: string;
  onPick: (id: string) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const featuredIds = new Set((tiled ?? data.featuredClients).map((c) => c.id));
  // Filter here instead of cmdk so search preserves the picker order.
  const needle = query.trim().toLowerCase();
  const agents = data.clients.filter(
    (c) =>
      !featuredIds.has(c.id) &&
      c.id !== "generic" &&
      `${c.label} ${c.sub}`.toLowerCase().includes(needle),
  );
  if (!data.hasClientOrder)
    agents.sort((a, b) => a.label.localeCompare(b.label));
  const generic = data.clients.find((c) => c.id === "generic");
  const shown = generic ? [...agents, generic] : agents;
  const choose = (id: string) => {
    onPick(id);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery("");
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search agents"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-80">
            <CommandEmpty className="px-3 py-4 text-sm text-muted-foreground">
              No agents match.
            </CommandEmpty>
            {shown.map((c) => (
              <CommandItem
                key={c.id}
                value={c.id}
                onSelect={() => choose(c.id)}
                className="gap-2"
              >
                <ClientIcon client={c} size={22} />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.id === lastConnectedId && (
                  <History
                    aria-label="Last connected"
                    className="size-3.5 text-muted-foreground"
                  />
                )}
                {c.id === selectedId && <Check className="size-3.5" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function InfoDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader className="px-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
        </DialogHeader>
        <DialogBody className="text-sm text-muted-foreground">
          {children}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// === Shared bits: text links, the prompt row ===

/** A quiet underlined button, for links within a line of muted text. */
export function TextButton({
  className,
  ...props
}: ComponentProps<typeof UnstyledButton>) {
  return (
    <UnstyledButton
      type="button"
      className={cn(
        "rounded-sm underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}

/** Copies text with a brief "Copied" on the button, or a toast on failure. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  // The reset must not outlive the component: one firing after unmount sets
  // state on a tree that is gone (in tests, after the DOM is torn down).
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  const copy = async (text: string) => {
    try {
      await copyToClipboard(text);
    } catch {
      toast.error("Could not copy. Select the prompt and copy it manually.");
      return false;
    }
    setCopied(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1800);
    return true;
  };
  return { copied, copy };
}

/** A prompt shown whole, wrapped, so it can be read before copying. */
export function PromptRow({
  text,
  placeholder,
  copied,
  disabled,
  onCopy,
  onSelectionCopy,
  className,
}: {
  /** null shows the placeholder instead. */
  text: string | null;
  placeholder?: string;
  copied: boolean;
  disabled?: boolean;
  onCopy: () => void;
  /** The text was selected and copied by hand. */
  onSelectionCopy?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-16 items-center gap-3 rounded-2xl border bg-background py-2 pr-2 pl-5 shadow-sm",
        className,
      )}
    >
      <code
        onCopy={onSelectionCopy}
        className={cn(
          "min-w-0 flex-1 font-mono text-sm leading-relaxed [overflow-wrap:anywhere]",
          !text && "font-sans text-muted-foreground",
        )}
      >
        {text ?? placeholder}
      </code>
      <Button
        size="lg"
        onClick={onCopy}
        disabled={!text || disabled}
        className="h-12 shrink-0 rounded-xl px-6"
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy prompt"}
      </Button>
    </div>
  );
}

// === Helpers ===

export function nameOf(client: ConnectClient) {
  return client.id === "generic" ? "your agent" : client.label;
}

/** nameOf, to start a sentence: "Your agent", "Cursor". */
export function sentenceNameOf(client: ConnectClient) {
  const name = nameOf(client);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function plural(n: number, word: string) {
  return n === 1 ? word : `${word}s`;
}

export function fmt(n: number) {
  return n.toLocaleString("en-US");
}

/** A token estimate, rounded so it doesn't read as exact: "~3.2K tokens". */
export function approxTokens(n: number) {
  if (n === 0) return "~0 tokens";
  if (n < 1000) return `~${Math.max(100, Math.round(n / 100) * 100)} tokens`;
  const k = n / 1000;
  return `~${k < 100 ? k.toFixed(1).replace(/\.0$/, "") : fmt(Math.round(k))}K tokens`;
}
