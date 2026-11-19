"use client";

import { FolderTree, PanelLeft, Search, TriangleAlert } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { FileQuickOpen, type QuickOpenConfig } from "./file-quick-open";
import { useStoredFlag } from "./use-stored-flag";

/**
 * Files laid out as an IDE: an explorer on the left, the open file beside it,
 * and one bar on top that names the file and opens a palette of every file on
 * Cmd/Ctrl+P. The Guardrails policy, a skill and a plugin all read their
 * files through this; each brings its own explorer rows, bar actions and
 * editor pane. It takes the height its container gives it.
 *
 * Below the `md` breakpoint the explorer is a panel laid over the editor,
 * opened from the bar's Files button; a picked file or Escape closes it.
 */
export function FileWorkspace({
  explorer,
  explorerStorageKey = null,
  activeKey,
  title,
  quickOpenLabel,
  quickOpen,
  shortcutScope = "focus",
  actions,
  notice,
  className,
  children,
}: {
  /**
   * The explorer, as a column (`overlay` false) or as the small screen's
   * panel (`overlay` true); null shows none and no control for it.
   */
  explorer: ((overlay: boolean) => ReactNode) | null;
  /** Remembers whether the explorer is shown; null remembers nothing. */
  explorerStorageKey?: string | null;
  /** The open file: the small screen's panel closes when it changes. */
  activeKey: string | null;
  /** The bar's middle, on the button that opens the palette. */
  title: ReactNode;
  quickOpenLabel: string;
  quickOpen: QuickOpenConfig;
  /**
   * Where Cmd/Ctrl+P opens the palette: anywhere on the page (`window`, for a
   * page that is the workspace) or while focus is inside it (`focus`, for a
   * workspace that shares its page).
   */
  shortcutScope?: "window" | "focus";
  /** The bar's end: the open file's actions and the panels' toggles. */
  actions?: ReactNode;
  /** A line between the bar and the files. */
  notice?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [explorerOpen, setExplorerOpen] = useStoredFlag(explorerStorageKey);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [filesPanel, setFilesPanel] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes when the open file changes
  useEffect(() => setFilesPanel(false), [activeKey]);
  useEffect(() => {
    if (!filesPanel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilesPanel(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filesPanel]);
  // Capture phase, so the editor does not take the key first.
  useEffect(() => {
    if (shortcutScope !== "window") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isQuickOpenKey(event)) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [shortcutScope]);
  const onKeyDownCapture =
    shortcutScope === "focus"
      ? (event: ReactKeyboardEvent) => {
          if (isQuickOpenKey(event)) {
            event.preventDefault();
            setPaletteOpen(true);
          }
        }
      : undefined;
  const isMac = useIsMac();

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border bg-background",
        className,
      )}
      onKeyDownCapture={onKeyDownCapture}
    >
      {/* On a phone the actions take the first row and the file the second. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/40 p-1 sm:grid sm:h-8 sm:grid-cols-[1fr_minmax(0,30rem)_1fr] sm:py-0">
        <div className="hidden items-center sm:flex">
          {explorer && (
            <WorkspacePanelToggle
              label={explorerOpen ? "Hide files" : "Show files"}
              pressed={explorerOpen}
              onClick={() => setExplorerOpen(!explorerOpen)}
              className="hidden md:inline-flex"
            >
              <PanelLeft className="size-3.5" />
            </WorkspacePanelToggle>
          )}
        </div>

        <UnstyledButton
          onClick={() => setPaletteOpen(true)}
          aria-label={quickOpenLabel}
          className="group order-last flex h-6 w-full min-w-0 items-center gap-2 rounded-md border bg-background px-2 text-xs outline-none transition-colors hover:border-ring/60 hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:order-none sm:w-auto"
        >
          <Search
            className="size-3 shrink-0 text-muted-foreground"
            aria-hidden
          />
          {title}
          <span className="ml-auto hidden shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100 sm:flex">
            <Kbd className="h-4 min-w-4 px-1">{isMac ? "⌘" : "Ctrl"}</Kbd>
            <Kbd className="h-4 min-w-4 px-1">P</Kbd>
          </span>
        </UnstyledButton>

        <div className="flex w-full items-center justify-end gap-0.5 sm:w-auto">
          {explorer && (
            <Button
              variant="ghost"
              size="xs"
              aria-expanded={filesPanel}
              onClick={() => setFilesPanel(!filesPanel)}
              className={cn(
                "mr-auto md:hidden",
                filesPanel ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <FolderTree className="size-3.5" aria-hidden />
              <span>Files</span>
            </Button>
          )}
          {actions}
        </div>
      </div>
      {notice}
      <div className="relative flex min-h-0 flex-1">
        {explorer && explorerOpen && explorer(false)}
        {explorer && filesPanel && (
          // On a small screen the files lie over the editor, inside the
          // workspace's own frame, and what is left of it closes them.
          <div className="absolute inset-0 z-20 flex md:hidden">
            <div className="flex w-64 max-w-[80%] flex-col border-r bg-background shadow-lg">
              {explorer(true)}
            </div>
            <UnstyledButton
              aria-label="Close files"
              onClick={() => setFilesPanel(false)}
              className="flex-1 bg-background/70"
            />
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
      <FileQuickOpen
        config={quickOpen}
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
      />
    </div>
  );
}

/**
 * A notice about the whole workspace, for its `notice` slot: a slim strip that
 * spans the workspace under its bar, not a card inside the editor. From `sm`
 * up the title and explanation share one line and the explanation truncates,
 * with the full text on hover. On a phone, where there is no hover, the
 * explanation wraps onto its own lines under the title.
 */
export function FileWorkspaceNotice({
  variant = "warning",
  title,
  children,
  className,
  ...props
}: {
  variant?: "warning" | "error";
  title: ReactNode;
  /** The explanation. Plain text, so it can be the hover title too. */
  children: string;
} & Omit<ComponentProps<"div">, "title" | "children">) {
  return (
    <div
      role="alert"
      className={cn(
        "flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-xs sm:items-center",
        variant === "error"
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        className,
      )}
      {...props}
    >
      <TriangleAlert className="mt-px size-3.5 shrink-0 sm:mt-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
        <span className="shrink-0 font-medium">{title}</span>
        <span className="min-w-0 opacity-90 sm:truncate" title={children}>
          {children}
        </span>
      </div>
    </div>
  );
}

/** A file's path in the bar: its folder muted, its name in full colour. */
export function FilePathLabel({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className="min-w-0 truncate font-mono text-[12px]">
      {slash >= 0 && (
        <span className="text-muted-foreground">
          {path.slice(0, slash + 1)}
        </span>
      )}
      <span className="text-foreground">{path.slice(slash + 1)}</span>
    </span>
  );
}

/** A small coloured chip that names the open file's kind in the bar. */
export function FileKindChip({
  className,
  children,
  ...props
}: {
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <span
      {...props}
      className={cn(
        "shrink-0 rounded-sm border px-1 text-[10px] font-medium leading-4",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** An icon-sized bar control, named by its tooltip. */
export function IconAction({
  label,
  className,
  children,
}: {
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex", className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** An icon that opens a page in a new tab, named by its tooltip. */
export function IconLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <IconAction label={label}>
      <Button
        asChild
        variant="ghost"
        size="icon-xs"
        className="size-6 text-muted-foreground hover:text-foreground"
      >
        <a
          href={href}
          aria-label={label}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      </Button>
    </IconAction>
  );
}

/** An icon that shows a state and names it in a tooltip, such as read-only. */
export function IconBadge({
  label,
  tooltip,
  children,
}: {
  /** The accessible name. */
  label: string;
  /** What the tooltip says, when it is more than the name. */
  tooltip?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className="flex size-6 items-center justify-center text-muted-foreground"
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-52">
        {tooltip ?? label}
      </TooltipContent>
    </Tooltip>
  );
}

/** A bar button that shows or hides a panel, pressed while it is shown. */
export function WorkspacePanelToggle({
  label,
  tooltip,
  pressed,
  onClick,
  className,
  children,
}: {
  label: string;
  /** What the tooltip says, such as the shortcut; the label when left out. */
  tooltip?: string;
  pressed: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <IconAction label={tooltip ?? label} className={className}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          "size-6",
          pressed ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {children}
      </Button>
    </IconAction>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function isQuickOpenKey(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "p"
  );
}

function useIsMac() {
  const [isMac, setIsMac] = useState(true);
  useEffect(() => {
    setIsMac(/mac|iphone|ipad/i.test(window.navigator.userAgent));
  }, []);
  return isMac;
}
