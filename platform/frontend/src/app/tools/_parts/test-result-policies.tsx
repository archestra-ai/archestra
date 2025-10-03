import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardDescription, CardTitle } from "@/components/ui/card";
import { PolicyCard } from "./policy-card";

export function ToolResultPolicies() {
  return (
    <div className="mt-4">
      <CardTitle className="flex flex-row items-center justify-between">
        <span>Tool Result Policies (after call)</span>
        <Button variant="outline" size="sm" className="bg-accent">
          <Plus /> Add
        </Button>
      </CardTitle>
      <CardDescription className="mb-4">
        Decide when to mark tool output as trusted or untrusted and whether to
        block it from further processing
      </CardDescription>
      <PolicyCard>
        <div className="flex flex-row items-center gap-4">
          <Badge
            variant="secondary"
            className="bg-blue-500 text-white dark:bg-blue-600"
          >
            Default
          </Badge>
          <span>TBD</span>
        </div>
      </PolicyCard>
    </div>
  );
}
