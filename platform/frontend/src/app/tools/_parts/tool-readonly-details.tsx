import type { GetToolsResponses } from "@/lib/clients/api";

export function ToolReadonlyDetails({
  tool,
}: {
  tool: GetToolsResponses["200"][number];
}) {
  return (
    <div className="border border-border rounded-lg p-6 bg-card">
      <div className="text-xs font-medium text-muted-foreground mb-4">
        PARAMETERS
      </div>
      {tool.parameters &&
      Object.keys(tool.parameters.properties || {}).length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(tool.parameters.properties || {}).map(
            ([key, value]) => {
              // @ts-expect-error
              const isRequired = tool.parameters?.required?.includes(key);
              return (
                <div
                  key={key}
                  className="inline-flex items-center gap-1.5 bg-muted px-2 py-1 rounded text-xs"
                >
                  <code className="font-medium text-foreground">{key}</code>
                  <span className="text-muted-foreground">{value.type}</span>
                  {isRequired && (
                    <span className="text-primary font-medium">*</span>
                  )}
                </div>
              );
            },
          )}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">None</div>
      )}
    </div>
  );
}
