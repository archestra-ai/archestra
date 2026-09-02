"use client";

import { ArrowRight } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SuggestionsProps = ComponentProps<"fieldset">;

export const Suggestions = ({
  className,
  children,
  ...props
}: SuggestionsProps) => (
  <fieldset
    className={cn(
      "m-0 grid min-w-0 w-full max-w-xl grid-cols-2 gap-x-4 border-0 p-0 sm:gap-x-8",
      className,
    )}
    {...props}
  >
    {children}
  </fieldset>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = "ghost",
  size = "sm",
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = useCallback(() => {
    onClick?.(suggestion);
  }, [onClick, suggestion]);

  return (
    <Button
      className={cn(
        "group h-auto min-h-11 w-full cursor-pointer justify-between rounded-none border-b border-border/60 px-1 py-2.5 text-left font-normal text-muted-foreground hover:bg-transparent hover:text-foreground active:translate-y-px dark:hover:bg-transparent",
        className,
      )}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      <span className="min-w-0 text-pretty">{children || suggestion}</span>
      <ArrowRight
        aria-hidden="true"
        className="size-3.5 shrink-0 opacity-40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:opacity-80 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-80 motion-reduce:transition-none"
      />
    </Button>
  );
};
