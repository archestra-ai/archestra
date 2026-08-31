import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A run of {@link SettingsSection}s, ruled between one another.
 *
 * The group draws no border or background of its own: a configuration panel is
 * the page's content, not a card floating on it. The rule is what separates
 * one subject from the next, and the left-hand labels are what name them.
 */
export function SettingsSectionGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("divide-y divide-border", className)}>{children}</div>
  );
}

/**
 * One labelled section of a settings surface: what the section is about on the
 * left, the controls that change it on the right.
 *
 * The label column is the reason this exists. A stack of unlabelled field
 * groups makes the reader infer what each one is for from the fields inside
 * it; naming the subject once, beside the controls, means the answer is on
 * screen while they read them. Below `md` the two columns stack, so the label
 * reads as an ordinary heading above its fields.
 */
export function SettingsSection({
  title,
  description,
  headerExtra,
  children,
  className,
  contentClassName,
  ...rest
}: {
  /**
   * Omitted where the surface already names the section — a page whose side
   * nav says "Messaging Channels" does not need the pane to say it again. The
   * label column is still laid out, so the fields stay on the same line as
   * every other section's.
   */
  title?: ReactNode;
  /** One line on what the section decides. Omit when the title says it all. */
  description?: ReactNode;
  /** Controls that belong to the section as a whole, under its description. */
  headerExtra?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "title" | "children">) {
  // Nothing to put in the label column — the surface names this section
  // elsewhere — so the controls take the whole width rather than sitting
  // beside an empty gutter.
  const hasLabel = !!title || !!description || !!headerExtra;

  return (
    <section
      className={cn(
        // No `last:pb-0`: the save row that follows a panel draws its own top
        // border, and zeroing the padding left the last field sitting on it.
        "grid gap-x-8 gap-y-4 py-8 first:pt-0",
        hasLabel && "md:grid-cols-[12rem_minmax(0,1fr)]",
        className,
      )}
      {...rest}
    >
      {hasLabel && (
        <div className="space-y-1.5">
          {/* `h3` throughout: these sit under the page's `h1`, and every
              section of a panel is a peer of every other. */}
          {title && (
            <h3 className="text-base font-semibold leading-none">{title}</h3>
          )}
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
          {headerExtra}
        </div>
      )}
      <div className={cn("min-w-0 space-y-4", contentClassName)}>
        {children}
      </div>
    </section>
  );
}
