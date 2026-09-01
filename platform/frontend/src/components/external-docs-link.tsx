"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { getVisibleDocsUrl } from "@/lib/docs/docs";
import { cn } from "@/lib/utils";

interface ExternalDocsLinkProps {
  href: string | null | undefined;
  children: React.ReactNode;
  className?: string;
  iconClassName?: string;
  showIcon?: boolean;
}

export function ExternalDocsLink({
  href,
  children,
  className,
  iconClassName,
  showIcon = true,
}: ExternalDocsLinkProps) {
  const visibleHref = getVisibleDocsUrl(href);

  if (!visibleHref) {
    return null;
  }

  return (
    <Link
      href={visibleHref}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        // With the trailing icon the anchor lays text + icon out as one unit,
        // so it has to be a flex box. Without the icon it must stay a plain
        // inline box: `inline-flex` makes the anchor an *atomic* inline, which
        // cannot wrap mid-phrase and leaves a line-break opportunity directly
        // after it. In prose that strands whatever follows the link — most
        // visibly a trailing period, which lands alone on the next line.
        showIcon ? "inline-flex items-center gap-1" : "inline",
        "text-primary hover:underline",
        className,
      )}
    >
      {children}
      <span className="sr-only">(opens in new tab)</span>
      {showIcon ? (
        <ExternalLink aria-hidden className={cn("h-3 w-3", iconClassName)} />
      ) : null}
    </Link>
  );
}
