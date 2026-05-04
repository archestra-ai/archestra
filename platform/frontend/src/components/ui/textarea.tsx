import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Enhanced Textarea Component
 * Designed for high-visibility data entry and professional code/argument editing.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // Layout & Sizing: Increased minimum height and spacious padding
        "flex w-full min-h-[350px] rounded-xl border border-input bg-background px-5 py-4 text-base shadow-md transition-all duration-300",
        
        // Typography: Mono font for better readability of JSON/Arguments
        "font-mono leading-relaxed placeholder:text-muted-foreground/60",
        
        // Interactive States: Premium focus ring and hover effects
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "hover:border-accent-foreground/20",
        
        // Status States
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/40",
        
        // Responsive Font Size
        "md:text-sm",
        
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
