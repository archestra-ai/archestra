import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/tailwind";

/**
 * The one panel the app draws when a list has nothing to show — whether that
 * is a page with no rows yet or a search that matched none.
 *
 * There used to be two of these: the framed-icon panel on `/apps` and a
 * plainer grey glyph over a single muted sentence inside `DataTable` and
 * `TableCardList`, plus a dozen hand-rolled copies in individual pages. Two
 * lists a click apart reported the same state in visibly different ways, and
 * every new list picked whichever it happened to be near. This is the only
 * definition; `DataTable` and `TableCardList` render it for their consumers,
 * so a page gets it by using either of them and never styles its own.
 *
 * @param icon - The page's own icon, which should be the one the sidebar uses
 * for it, so the panel reads as part of the page rather than as a generic
 * error. Defaults to a neutral tray for lists with no icon of their own.
 * @param title - What is (not) here, as a short headline: "No agents match
 * your filters". Not a sentence with the advice appended — that is
 * `description`, which is set below it in muted text.
 * @param action - A call to action for a list that is empty because nothing
 * has been created yet ("Add your first skill"). Mutually useful with
 * `onClearFilters`, never shown together in practice: one is for "nothing
 * here yet", the other for "nothing matched".
 * @param onClearFilters - Renders the reset affordance. It is a text link
 * rather than a button: the panel already carries a heading and an icon, and a
 * third framed element in the same column made a dead-end state look like a
 * form. Pass it only while a filter is actually applied — offering to clear
 * nothing is what makes an empty page look broken.
 * @param variant - `"firstUse"` is for a page the reader has never put
 * anything on. The panel is then the whole page, so it explains the feature
 * rather than reporting the empty list: `title` names the outcome ("Send each
 * session to the right model"), `description` says what the thing is in one
 * or two plain sentences, `action` is the first step, and `secondaryAction` is
 * at most one text link (ready-made examples, or the docs). Guardrails' own
 * first-run page set this layout. A filtered list that matched nothing keeps
 * the default variant: its reader already knows the feature.
 * @param canAct - `firstUse` only. `false` replaces both actions with
 * `readerMessage`, so a reader without permission sees who sets the feature
 * up rather than a disabled button. `undefined` (permissions still loading)
 * shows neither, so nothing flickers.
 * @param align - `firstUse` only. `"start"` sets the panel on the page's left
 * line, directly under the page header, so it reads on from the page title
 * instead of floating in the middle of the page.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  onClearFilters,
  className,
  variant = "default",
  secondaryAction,
  canAct,
  readerMessage,
  align = "center",
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  onClearFilters?: () => void;
  className?: string;
  variant?: "default" | "firstUse";
  secondaryAction?: ReactNode;
  canAct?: boolean;
  readerMessage?: ReactNode;
  align?: "center" | "start";
}) {
  if (variant === "firstUse") {
    return (
      <div
        className={cn(
          "flex max-w-xl flex-col",
          align === "start"
            ? "items-start py-2 text-left"
            : "mx-auto items-center px-2 py-10 text-center sm:py-16",
          className,
        )}
      >
        <span className="flex size-28 items-center justify-center rounded-full bg-muted sm:size-36">
          <Icon
            aria-hidden="true"
            className="size-12 text-primary sm:size-14"
            strokeWidth={1.5}
          />
        </span>
        {/* Not a heading, for the same reason as the default variant below. */}
        <p className="mt-8 text-2xl font-semibold tracking-tight text-balance">
          {title}
        </p>
        {description ? (
          <p className="mt-3 max-w-md leading-relaxed text-pretty text-muted-foreground">
            {description}
          </p>
        ) : null}
        {canAct === true ? (
          <div
            className={cn(
              "mt-8 flex flex-wrap items-center gap-x-6 gap-y-3",
              align === "start" ? "justify-start" : "justify-center",
            )}
          >
            {action}
            {secondaryAction}
          </div>
        ) : canAct === false && readerMessage ? (
          <p className="mt-8 text-sm text-muted-foreground">{readerMessage}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-12 text-center",
        className,
      )}
    >
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border bg-background shadow-sm">
        <Icon className="h-6 w-6 text-primary" />
      </div>
      {/* Deliberately not a heading. The panel sits inside a table body and
          its text names the current filter result, not a section of the page,
          so it does not belong in the document outline — and as a heading it
          made every page-title locator ambiguous, because "Agents" is a
          substring of "No agents found". `ui/empty.tsx` renders its own title
          as a plain element for the same reason. */}
      <p className="mb-1 text-lg font-semibold">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
      {onClearFilters ? (
        <Button
          variant="link"
          size="sm"
          className="mt-2 h-auto p-0 text-sm"
          onClick={onClearFilters}
        >
          <span>Clear filters</span>
        </Button>
      ) : null}
    </div>
  );
}
