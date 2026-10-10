"use client";

import { Mail, Monitor, Share2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * How a mention in a channel turns into work, said once above the channel
 * picker so the reader knows what assigning a channel buys them. The thread
 * beside it is an illustration, not data.
 */
export function AgentChannelHowItWorks({
  hasRuntime,
}: {
  hasRuntime: boolean;
}) {
  const appName = useAppName();
  return (
    <div className="flex flex-wrap gap-4 rounded-xl bg-muted p-4">
      <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
        <p className="text-sm font-semibold">How it works in a channel</p>
        <p className="text-[13px] leading-normal text-muted-foreground">
          {hasRuntime
            ? `Someone mentions @${appName} with a task. The agent starts a run, posts a link to the live terminal, and answers in the thread when done. Replies in that thread go to the same run, with its files still there.`
            : `Someone mentions @${appName} with a question or a task. The agent answers in the thread, and keeps answering replies there.`}
        </p>
      </div>
      <div
        aria-hidden="true"
        className="flex min-w-0 flex-[1_1_280px] flex-col gap-2 rounded-[10px] bg-card p-3 text-[13px] leading-[1.45]"
      >
        <p>
          <span className="font-semibold">Dana</span>{" "}
          <span className="text-sky-700 dark:text-sky-400">@{appName}</span> the
          checkout tests are flaky on main, fix it?
        </p>
        <p>
          <span className="font-semibold">{appName}</span> On it.{" "}
          <span className="text-primary underline">Watch the run</span>
        </p>
        <p>
          <span className="font-semibold">{appName}</span> Shared cart fixture
          raced. Fixed, 20/20 green.{" "}
          <span className="text-primary underline">PR #123</span>
        </p>
      </div>
    </div>
  );
}

/** Ways to give this agent work that need nothing set up on this step. */
export function AgentOtherTaskSources({ hasRuntime }: { hasRuntime: boolean }) {
  const appName = useAppName();
  return (
    <div className="flex flex-col gap-3">
      {hasRuntime && (
        <TaskSource
          icon={<Monitor className="size-[18px]" />}
          title="Hand off from your laptop"
          highlighted
        >
          <p>
            Started something in Claude Code or Codex locally? Say &quot;hand
            this over to {appName}&quot;. Your repo changes and context move
            into this agent&apos;s container, and the task keeps going after you
            close the laptop. Say &quot;bring it back&quot; to get the result as
            a patch.
          </p>
          <div
            role="img"
            aria-label={`Example: hand this over to ${appName}`}
            className="rounded-[10px] bg-[#16130F] px-3 py-2.5 font-mono text-xs leading-[1.6] text-[#D9D4CE]"
          >
            <p>&gt; hand this over to {appName}, use Claude Code</p>
            <p className="text-[#9CC59F]">
              Handed off to Claude Code · run started · live terminal ready
            </p>
          </div>
          <p>
            Set up once: add the {appName} MCP gateway to your local agent from
            the{" "}
            <Link
              href="/connection"
              className="text-primary underline underline-offset-2"
            >
              Connect page
            </Link>
            . It gives your agent tools to start and follow runs, and to move
            files and credentials to and from the run securely.
          </p>
        </TaskSource>
      )}
      <TaskSource
        icon={<Share2 className="size-[18px]" />}
        title="From another agent"
      >
        <p>
          {hasRuntime
            ? "Any agent that has this one as a subagent can send it work and keep chatting while it runs."
            : "Any agent that has this one as a subagent can send it work."}
        </p>
      </TaskSource>
      <TaskSource
        icon={<Mail className="size-[18px]" />}
        title="By email or A2A"
      >
        <p>
          It gets its own email address and A2A endpoint. Find both on the agent
          after creating it.
        </p>
      </TaskSource>
    </div>
  );
}

function TaskSource({
  icon,
  title,
  highlighted = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  highlighted?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        highlighted
          ? "flex gap-3.5 rounded-xl border border-primary/25 bg-card p-4"
          : "flex gap-3.5 rounded-xl border bg-card p-4"
      }
    >
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-muted"
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-[15px] font-medium">{title}</p>
        <div className="flex flex-col gap-2 text-[13px] leading-normal text-muted-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}
