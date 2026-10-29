"use client";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

type AgentRunHeaderProps = {
  title: string;
  status: ReactNode;
  agentName: string;
  agentHref: string;
  agentImage: ReactNode;
  started: string;
  startedTitle: string;
  actions: ReactNode;
};

export function AgentRunHeader({
  title,
  status,
  agentName,
  agentHref,
  agentImage,
  started,
  startedTitle,
  actions,
}: AgentRunHeaderProps) {
  return (
    <header
      style={{
        display: "grid",
        gridTemplateColumns: "2.25rem minmax(0, 1fr) auto",
        alignItems: "center",
        gap: "0.75rem",
      }}
      className="shrink-0 border-b px-4 py-2.5"
    >
      <Link
        href={agentHref}
        aria-label={`View Agent ${agentName}`}
        className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {agentImage}
      </Link>
      <div className="min-w-0 space-y-1">
        <nav
          aria-label="Session context"
          className="hidden min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:flex"
        >
          <Link
            href={agentHref}
            className="min-w-0 truncate rounded hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {agentName}
          </Link>
          <ChevronRight aria-hidden className="size-3 shrink-0 opacity-60" />
          <span>Session</span>
          <span aria-hidden className="mx-1 h-3 border-l" />
          <time title={startedTitle}>{started}</time>
        </nav>
        <div className="flex min-w-0 items-center gap-2">
          <h1
            className="min-w-0 truncate text-sm font-medium leading-5"
            title={title}
          >
            {title}
          </h1>
          <span className="hidden shrink-0 items-center text-xs [&_span]:text-xs sm:inline-flex">
            {status}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground sm:hidden">
          <Link
            href={agentHref}
            className="min-w-0 flex-1 truncate rounded hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {agentName}
          </Link>
          <span className="inline-flex shrink-0 text-xs [&_span]:text-xs">
            {status}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end">{actions}</div>
    </header>
  );
}
