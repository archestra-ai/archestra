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
        "inline-flex items-center gap-1 text-primary hover:underline",
        className,
      )}
    >
      {children}
      {showIcon ? (
        <ExternalLink className={cn("h-3 w-3", iconClassName)} />
      ) : null}
    </Link>
  );
}
