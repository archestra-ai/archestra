"use client";

import { DocsPage, getDocsUrl } from "@shared";
import { ArrowUpRight, Database, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useHasPermissions } from "@/lib/auth/auth.query";

export function EmbeddingRequiredPlaceholder() {
  const router = useRouter();
  const { data: canAccessSettings } = useHasPermissions({
    knowledgeSettings: ["read"],
  });

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center max-w-md">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-background shadow-sm border">
          <Database className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-xl font-semibold mb-2">
          Connect your docs, drives, and repos so your agents answer from your
          knowledge
        </h2>
        <p className="text-sm text-muted-foreground mb-6">
          Configuration is needed to create your first knowledge base.
        </p>
        <div className="flex items-center justify-center gap-4">
          {canAccessSettings && (
            <Button onClick={() => router.push("/settings/knowledge")}>
              <Settings className="mr-2 h-4 w-4" />
              Configure now
            </Button>
          )}
          <a
            href={getDocsUrl(DocsPage.PlatformKnowledgeBases)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            Learn more
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
