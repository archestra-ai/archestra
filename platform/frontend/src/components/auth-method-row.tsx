"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type React from "react";

/**
 * One authentication method in a "how do callers authenticate here" list:
 * name and one-line description on the left, its actions on the right, extra
 * detail (a header snippet, a status line) beneath the description.
 *
 * Shared by the LLM Proxy overview and the MCP Gateway connect panel so the
 * two read as the same surface — a reader who has configured one recognises
 * the other. Stack these inside a `divide-y` container.
 */
export function AuthMethodRow({
  title,
  description,
  action,
  manageHref,
  manageLabel,
  children,
}: {
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
  manageHref?: string | null;
  manageLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-3 last:pb-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 max-w-2xl space-y-1.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
        {children}
      </div>
      {action || (manageHref && manageLabel) ? (
        <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
          {action}
          {manageHref && manageLabel ? (
            <p className="text-xs">
              <Link
                href={manageHref}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <span>{manageLabel}</span>
                <ArrowRight className="h-3 w-3" />
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
