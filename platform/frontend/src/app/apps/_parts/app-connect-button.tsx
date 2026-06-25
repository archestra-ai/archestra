"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Plug } from "lucide-react";
import { CopyableCode } from "@/components/copyable-code";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { usePublicBaseUrl } from "@/lib/config/config.query";

type App = archestraApiTypes.GetAppResponses["200"];

export function AppConnectButton({ app }: { app: App }) {
  const baseUrl = usePublicBaseUrl();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <Plug className="h-4 w-4" />
          Connect
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-1.5">
        <Label>Connector URL</Label>
        <p className="text-xs text-muted-foreground">
          Add this app to an external MCP client by pasting this URL. Whoever
          connects authenticates as themselves.
        </p>
        {baseUrl ? (
          <CopyableCode
            value={`${baseUrl}/api/mcp/app/${app.id}`}
            toastMessage="Connector URL copied"
            variant="primary"
          />
        ) : (
          <Skeleton className="h-10 w-full" />
        )}
      </PopoverContent>
    </Popover>
  );
}
