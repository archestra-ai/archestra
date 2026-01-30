"use client";

import { type ComponentProps, memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

type ResponseProps = ComponentProps<typeof Streamdown>;

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        // Add proper list styling
        "[&_ul]:list-disc [&_ul]:ml-6 [&_ul]:my-2",
        "[&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:my-2",
        "[&_li]:my-1",
        // Add proper heading styling
        "[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4",
        "[&_h2]:text-xl [&_h2]:font-bold [&_h2]:my-3",
        "[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:my-2",
        // Add proper paragraph spacing
        "[&_p]:my-2",
        // Add proper code block styling
        // Only style inline code, not code inside pre elements
        "[&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:text-foreground [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded",
        "[&_pre]:bg-muted [&_pre]:p-3 [&_pre]:rounded [&_pre]:my-2 [&_pre]:overflow-x-auto",
        // Fix streamdown code blocks - remove padding from code elements inside them
        "[&_[data-streamdown='code-block']_code]:p-0 [&_[data-streamdown='code-block']_code]:bg-transparent",
        // Fix button link styling - use group variant to match parent's is-user/is-assistant class
        "group-[.is-user]:[&_[data-streamdown='link']]:text-primary-foreground",
        "group-[.is-assistant]:[&_[data-streamdown='link']]:text-secondary-foreground",
        className,
      )}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

Response.displayName = "Response";
