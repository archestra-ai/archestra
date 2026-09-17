"use client";

import type { AgentRuntimeError } from "@archestra/shared";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function AgentRunDiagnostic({
  diagnostic,
  agentId,
  failed,
}: {
  diagnostic: AgentRuntimeError;
  agentId: string;
  failed: boolean;
}) {
  return (
    <Alert variant={failed ? "destructive" : "warning"}>
      <AlertTriangle aria-hidden className="size-4" />
      <AlertTitle className="line-clamp-none">{diagnostic.message}</AlertTitle>
      <AlertDescription>
        <p>{diagnostic.resolution}</p>
        {(diagnostic.phase === "credentials" ||
          diagnostic.phase === "provider") && (
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href={`/agents/${agentId}`}>
              <span>Agent settings</span>
            </Link>
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
