"use client";

import { type ReactNode, useEffect } from "react";
import { Version } from "@/components/version";
import { cn } from "@/lib/utils";
import { ViewTransition } from "@/lib/view-transition";

/** Shared viewport, header, thread and composer frames for every Chat transport. */
export function ChatShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add("hide-version");
    return () => document.body.classList.remove("hide-version");
  }, []);
  return <div className="flex flex-col h-full w-full min-h-0">{children}</div>;
}

export function ChatShellHeader({
  children,
  hidden = false,
}: {
  children: ReactNode;
  hidden?: boolean;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 bg-background border-b p-2",
        hidden && "hidden",
      )}
    >
      <div className="relative flex min-h-8 items-center justify-between gap-2">
        {children}
      </div>
    </div>
  );
}

export function ChatThread({
  children,
  hiddenOnMobile = false,
}: {
  children: ReactNode;
  hiddenOnMobile?: boolean;
}) {
  return (
    <ViewTransition enter="chat-thread-enter" default="none">
      <div
        className={cn(
          "flex-1 min-h-0 relative",
          hiddenOnMobile && "hidden md:block",
        )}
      >
        {children}
      </div>
    </ViewTransition>
  );
}

export function ChatComposer({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 bg-background border-t p-4">
      <ViewTransition
        name="chat-composer"
        share="chat-composer-morph"
        default="none"
      >
        <div className="max-w-4xl mx-auto space-y-3">
          {children}
          <div className="text-center">
            <Version inline />
          </div>
        </div>
      </ViewTransition>
    </div>
  );
}
