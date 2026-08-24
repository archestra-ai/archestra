import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  onClearFilters,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  onClearFilters?: () => void;
  className?: string;
}) {
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
      <h2 className="mb-1 text-lg font-semibold">{title}</h2>
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
