import { Bot } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function AgentTilesEmptyState({
  providerLabel,
}: {
  providerLabel: string;
}) {
  return (
    <Card>
      <CardContent className="py-10 flex flex-col items-center gap-3">
        <Bot className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No agents have {providerLabel} enabled yet
        </p>
        <p className="text-xs text-muted-foreground">
          Use the <span className="font-medium">+ Add</span> button above to
          enable agents
        </p>
      </CardContent>
    </Card>
  );
}
