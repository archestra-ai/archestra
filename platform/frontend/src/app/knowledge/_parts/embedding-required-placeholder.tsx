"use client";

import { Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function EmbeddingRequiredPlaceholder() {
  const router = useRouter();

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center text-muted-foreground max-w-md">
        <Settings className="h-10 w-10 mx-auto mb-3 opacity-50" />
        <p className="font-medium mb-1">Embedding configuration required</p>
        <p className="text-sm mb-4">
          Configure an embedding API key and model to start using knowledge
          bases and connectors.
        </p>
        <Button
          variant="outline"
          onClick={() => router.push("/settings/knowledge")}
        >
          <Settings className="mr-2 h-4 w-4" />
          Go to Knowledge Settings
        </Button>
      </div>
    </div>
  );
}
