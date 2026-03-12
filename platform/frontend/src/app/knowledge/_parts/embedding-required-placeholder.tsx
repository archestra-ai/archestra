"use client";

import { Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useHasPermissions } from "@/lib/auth.query";
import { useKnowledgeBaseConfigStatus } from "@/lib/knowledge-base.query";

export function EmbeddingRequiredPlaceholder() {
  const router = useRouter();
  const status = useKnowledgeBaseConfigStatus();
  const { data: canAccessSettings } = useHasPermissions({
    knowledgeSettings: ["read"],
  });

  const missing: string[] = [];
  if (!status.embedding) missing.push("embedding");
  if (!status.reranker) missing.push("reranking");

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center text-muted-foreground max-w-md">
        <Settings className="h-10 w-10 mx-auto mb-3 opacity-50" />
        <p className="font-medium mb-1">Knowledge base setup required</p>
        <p className="text-sm mb-4">
          {canAccessSettings
            ? `Configure ${missing.join(" and ")} API key${missing.length > 1 ? "s" : ""} and model${missing.length > 1 ? "s" : ""} in Knowledge Settings to start using knowledge bases and connectors.`
            : `The ${missing.join(" and ")} API key${missing.length > 1 ? "s" : ""} and model${missing.length > 1 ? "s" : ""} need to be configured by an administrator before you can use knowledge bases and connectors.`}
        </p>
        {canAccessSettings && (
          <Button
            variant="outline"
            onClick={() => router.push("/settings/knowledge")}
          >
            <Settings className="mr-2 h-4 w-4" />
            Go to Knowledge Settings
          </Button>
        )}
      </div>
    </div>
  );
}
