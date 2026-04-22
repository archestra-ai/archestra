"use client";

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface UserMessageTextProps extends HTMLAttributes<HTMLDivElement> {
  text: string;
}

export function UserMessageText({
  className,
  text,
  ...props
}: UserMessageTextProps) {
  return (
    <div
      className={cn("whitespace-pre-wrap break-words", className)}
      {...props}
    >
      {text}
    </div>
  );
}
