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
        "[&_code]:bg-secondary-foreground/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded",
        "[&_pre]:bg-secondary-foreground/5 [&_pre]:p-3 [&_pre]:rounded [&_pre]:my-2 [&_pre]:overflow-x-auto",
        className,
      )}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

Response.displayName = "Response";
