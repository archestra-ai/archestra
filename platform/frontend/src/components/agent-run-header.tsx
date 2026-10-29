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
    <header className="grid shrink-0 grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-3 border-b px-4 py-2.5 lg:grid-cols-[2.25rem_minmax(0,1fr)_auto]">
      <Link
        href={agentHref}
        aria-label={`View Agent ${agentName}`}
        className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {agentImage}
      </Link>
      <div className="grid min-w-0 grid-cols-[minmax(0,max-content)_auto] items-center gap-x-2 gap-y-1">
        <nav
          aria-label="Session context"
          className="col-span-2 hidden min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground lg:flex"
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
        <h1
          className="col-span-2 row-start-1 min-w-0 truncate text-sm font-medium leading-5 lg:col-span-1 lg:row-start-2"
          title={title}
        >
          {title}
        </h1>
        <Link
          href={agentHref}
          className="col-span-2 col-start-1 row-start-2 min-w-0 truncate rounded text-xs text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring lg:hidden"
        >
          {agentName}
        </Link>
        <span className="col-span-2 col-start-1 row-start-3 inline-flex shrink-0 text-xs lg:col-span-1 lg:col-start-2 lg:row-start-2 [&_span]:text-xs">
          {status}
        </span>
      </div>
      <div className="col-span-2 flex shrink-0 items-center justify-end lg:col-span-1">{actions}</div>
    </header>
  );
}
