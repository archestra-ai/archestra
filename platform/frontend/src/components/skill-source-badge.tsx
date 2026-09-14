import { Badge } from "@/components/ui/badge";

export type SkillSource = "native" | "external_mcp" | "plugin";

export function SkillSourceBadge({
  source,
  providerName,
}: {
  source: SkillSource;
  providerName: string | null;
}) {
  const sourceName = skillSourceLabel(source);
  const label = providerName ? `${providerName} · ${sourceName}` : sourceName;
  return (
    <Badge
      variant="secondary"
      title={label}
      className="inline-flex max-w-56 shrink items-center gap-1 overflow-hidden font-normal"
    >
      {providerName && <span className="truncate">{providerName}</span>}
      {providerName && (
        <span aria-hidden className="shrink-0 text-muted-foreground">
          ·
        </span>
      )}
      <span className="shrink-0">{sourceName}</span>
    </Badge>
  );
}

export function skillSourceLabel(source: SkillSource) {
  switch (source) {
    case "native":
      return "Skill library";
    case "external_mcp":
      return "MCP";
    case "plugin":
      return "Plugin";
  }
}
