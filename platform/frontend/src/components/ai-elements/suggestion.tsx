"use client";

import { ArrowUpRight } from "lucide-react";
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
      "m-0 flex max-w-[34rem] flex-wrap justify-center gap-1 border-0 p-0",
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
        "group h-8 max-w-full cursor-pointer gap-1.5 rounded-md px-2.5 text-[13px] font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground active:translate-y-px",
        className,
      )}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      <span className="min-w-0 truncate">{children || suggestion}</span>
      <ArrowUpRight
        aria-hidden="true"
        className="size-3 shrink-0 opacity-35 transition-[opacity,transform] duration-150 group-hover:-translate-y-px group-hover:translate-x-px group-hover:opacity-70 group-focus-visible:-translate-y-px group-focus-visible:translate-x-px group-focus-visible:opacity-70 motion-reduce:transition-none"
      />
    </Button>
  );
};
