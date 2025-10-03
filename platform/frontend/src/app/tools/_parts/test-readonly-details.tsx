import type { GetToolsResponses } from "shared/api-client";
import { Badge } from "@/components/ui/badge";
import { CardDescription, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";

export function ToolReadonlyDetails({
  tool,
}: {
  tool: GetToolsResponses["200"][number];
}) {
  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
    >
      <div>
        <CardTitle className="text-sm font-medium">Agent</CardTitle>
        <CardDescription>{tool.agentId}</CardDescription>
      </div>
      <div>
        <CardTitle className="text-sm font-medium">Created At</CardTitle>
        <CardDescription>
          {formatDate({ date: tool.createdAt })}
        </CardDescription>
      </div>
      <div>
        <CardTitle className="text-sm font-medium">Updated At</CardTitle>
        <CardDescription>
          {formatDate({ date: tool.updatedAt })}
        </CardDescription>
      </div>
      <div>
        <CardTitle className="text-sm font-medium">Parameters</CardTitle>
        {tool.parameters &&
        Object.keys(tool.parameters.properties || {}).length > 0 ? (
          <div className="flex flex-wrap gap-2 mt-2">
            {Object.entries(tool.parameters.properties || {}).map(
              ([key, value]) => {
                // @ts-expect-error
                const isRequired = tool.parameters?.required?.includes(key);
                return (
                  <div
                    key={key}
                    className="inline-flex items-center gap-1.5 bg-muted px-2 py-1 rounded border text-xs"
                  >
                    <code className="font-medium">{key}</code>
                    <Badge
                      variant={isRequired ? "default" : "outline"}
                      className="text-md h-3 p-2"
                    >
                      {value.type}
                    </Badge>
                    {isRequired && (
                      <Badge className="text-md h-3 p-2 bg-fuchsia-700 text-white">
                        required
                      </Badge>
                    )}
                  </div>
                );
              },
            )}
          </div>
        ) : (
          <CardDescription>None</CardDescription>
        )}
      </div>
    </div>
  );
}
