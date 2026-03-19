"use client";

import { ExternalLink } from "lucide-react";

export function CatalogDocsLink({
  url,
  className,
}: {
  url: string;
  className?: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      Docs
      <ExternalLink className="size-3.5" />
    </a>
  );
}
