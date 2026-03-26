"use client";

import { ExternalLink } from "lucide-react";
import { getVisibleDocsUrl } from "@/lib/docs/docs";

export function CatalogDocsLink({
  url,
  className,
}: {
  url: string;
  className?: string;
}) {
  const visibleUrl = getVisibleDocsUrl(url);
  if (!visibleUrl) {
    return null;
  }

  return (
    <a
      href={visibleUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      Docs
      <ExternalLink className="size-3.5" />
    </a>
  );
}
