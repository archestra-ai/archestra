import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils/tailwind";
import { ShortHash } from "./refs";
import { ADDED_TEXT } from "./tones";

/**
 * The bottom line of the dialog, like a terminal's: what is checked out (HEAD,
 * or the version being viewed and where HEAD is), a transient notice or the
 * pane's reading, and the keys. A key that cannot act right now is dimmed;
 * one a history does not have at all (apps neither diff nor hash) is left out.
 */
export function VersionHistoryStatusLine({
  activeVersion,
  headVersion,
  isHead,
  hash,
  isBusy,
  notice,
  reading,
  keys,
}: {
  activeVersion: number | null;
  headVersion: number | null;
  isHead: boolean;
  hash: string | null;
  /** The selected version is still loading. */
  isBusy: boolean;
  /** A transient message, such as a copied hash. */
  notice: string | null;
  /** How the pane reads the version: as a diff, or whole as a tree. */
  reading: "diff" | "tree" | null;
  keys: {
    /** Absent when the history has no Changes/All views. */
    toggleView?: boolean;
    /** Absent when the history does not hash its versions. */
    copyHash?: boolean;
    restore: boolean;
  };
}) {
  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t bg-muted/40 px-3 font-mono text-[11px] text-muted-foreground">
      {activeVersion === null ? (
        <span>no version selected</span>
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "shrink-0 rounded-[3px] px-1.5 leading-[18px] font-semibold",
              isHead
                ? "bg-primary text-primary-foreground"
                : "bg-foreground/80 text-background",
            )}
          >
            {isHead ? "HEAD" : `v${activeVersion}`}
          </span>
          {hash ? <ShortHash hash={hash} /> : null}
          <span className="truncate">
            {isHead
              ? `v${activeVersion}, current`
              : headVersion !== null
                ? `viewing, HEAD at v${headVersion}`
                : "viewing"}
          </span>
          {isBusy ? (
            <span className="shrink-0 animate-pulse text-foreground/70 motion-reduce:animate-none">
              loading...
            </span>
          ) : notice ? (
            <span aria-live="polite" className={cn("shrink-0", ADDED_TEXT)}>
              {notice}
            </span>
          ) : reading ? (
            <span className="hidden shrink-0 lg:inline">{reading}</span>
          ) : null}
        </span>
      )}
      <span aria-hidden className="ml-auto hidden items-center gap-3.5 md:flex">
        <KeyHint keys={["j", "k"]} label="move" />
        <KeyHint keys={["g"]} label="HEAD" />
        {keys.toggleView === undefined ? null : (
          <KeyHint keys={["d"]} label="changes/all" dim={!keys.toggleView} />
        )}
        {keys.copyHash === undefined ? null : (
          <KeyHint keys={["y"]} label="copy hash" dim={!keys.copyHash} />
        )}
        <KeyHint keys={["r"]} label="restore" dim={!keys.restore} />
        <KeyHint keys={["esc"]} label="close" />
      </span>
    </footer>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function KeyHint({
  keys,
  label,
  dim = false,
}: {
  keys: string[];
  label: string;
  dim?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 transition-opacity",
        dim && "opacity-40",
      )}
    >
      <span className="inline-flex gap-0.5">
        {keys.map((key) => (
          <Kbd key={key} className="bg-background font-mono">
            {key}
          </Kbd>
        ))}
      </span>
      <span>{label}</span>
    </span>
  );
}
