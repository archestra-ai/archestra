"use client";

import { ExternalDocsLink } from "@/components/external-docs-link";

export function CatalogDocsLink({
  url,
  className,
}: {
  url: string;
  className?: string;
}) {
  return (
    <ExternalDocsLink href={url} className={className} iconClassName="size-3.5">
      Docs
    </ExternalDocsLink>
  );
}
