import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The one inline notice: a slim strip that tells the user something about the
 * surface it sits on — a form that could not reach a repository, a composer
 * whose agent is missing a connection, a panel that is read-only.
 *
 * Deliberately slimmer than `<Alert>`. These sit inside forms, dialogs and
 * directly under the chat composer, where a full padded alert block dwarfs the
 * controls it is talking about. `<Alert>` remains the right thing for a
 * page-level banner that is the content of its own row.
 *
 * Composition is icon, then a `font-medium` title span, then
 * `<InlineNoticeText>` for the explanation, then an optional trailing action
 * (`className="ml-auto"`). Title and explanation share a row and wrap only
 * when the width requires it, which is what keeps the strip one line tall in
 * the common case.
 *
 * The variant carries every colour, including the explanation's: never hand a
 * child its own amber/red class, or the two drift apart the next time a
 * palette moves.
 */
const inlineNoticeVariants = cva(
  "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs [&>svg]:size-3.5 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        warning:
          "border-amber-500/50 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-200 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400 *:data-[slot=inline-notice-text]:text-amber-800 dark:*:data-[slot=inline-notice-text]:text-amber-300",
        error:
          "border-destructive/40 bg-destructive/5 text-destructive [&>svg]:text-destructive *:data-[slot=inline-notice-text]:text-destructive/90",
        success:
          "border-emerald-500/40 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/50 dark:text-emerald-200 [&>svg]:text-emerald-600 dark:[&>svg]:text-emerald-400 *:data-[slot=inline-notice-text]:text-emerald-800 dark:*:data-[slot=inline-notice-text]:text-emerald-300",
        info: "border-blue-500/50 bg-blue-50 text-blue-900 dark:border-blue-500/30 dark:bg-blue-950/50 dark:text-blue-200 [&>svg]:text-blue-600 dark:[&>svg]:text-blue-400 *:data-[slot=inline-notice-text]:text-blue-800 dark:*:data-[slot=inline-notice-text]:text-blue-300",
        neutral:
          "bg-muted/40 text-foreground [&>svg]:text-muted-foreground *:data-[slot=inline-notice-text]:text-muted-foreground",
      },
      /**
       * The notice sits over content that scrolls under it, such as a sticky
       * form footer. It needs a backdrop of its own so the page does not read
       * through it. Here rather than at the call site: a screen that needs
       * this would otherwise paste its own `bg-amber-50/90`, and the next
       * palette change would move the variant and leave the copy behind.
       */
      floating: {
        true: "shadow-sm backdrop-blur-md",
        false: "",
      },
    },
    compoundVariants: [
      {
        variant: "warning",
        floating: true,
        class: "bg-amber-50/90 dark:bg-amber-950/60",
      },
      { variant: "error", floating: true, class: "bg-destructive/10" },
      {
        variant: "success",
        floating: true,
        class: "bg-emerald-50/90 dark:bg-emerald-950/60",
      },
      {
        variant: "info",
        floating: true,
        class: "bg-blue-50/90 dark:bg-blue-950/60",
      },
      { variant: "neutral", floating: true, class: "bg-muted/80" },
    ],
    defaultVariants: {
      variant: "warning",
      floating: false,
    },
  },
);

export function InlineNotice({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inlineNoticeVariants>) {
  return (
    <div
      role="alert"
      data-slot="inline-notice"
      className={cn(inlineNoticeVariants({ variant }), className)}
      {...props}
    />
  );
}

/**
 * The explanation beside the title. Its colour comes from the variant.
 *
 * A `div`, not a `span`: some notices explain themselves with a list of
 * validation failures, and a `<ul>` inside a `<span>` is invalid HTML. As a
 * flex item it still sits on the title's row and wraps the same way.
 */
export function InlineNoticeText({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="inline-notice-text"
      className={cn("min-w-0", className)}
      {...props}
    />
  );
}
