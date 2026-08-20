import { Database } from "lucide-react";
import {
  ConnectorTypeIcon,
  hasConnectorIcon,
} from "@/app/knowledge/knowledge-bases/_parts/connector-icons";

/**
 * A knowledge source's glyph: the connector's own logo where there is one,
 * otherwise the generic store icon. `ConnectorTypeIcon` renders nothing for a
 * type it has no logo for (uploaded files, for one), so calling it unguarded
 * leaves a chip with a hole where its neighbours have an icon.
 */
export function KnowledgeSourceIcon({
  connectorType,
  className = "size-3.5",
}: {
  connectorType?: string | null;
  className?: string;
}) {
  if (connectorType && hasConnectorIcon(connectorType)) {
    return <ConnectorTypeIcon type={connectorType} className={className} />;
  }
  return <Database className={`${className} text-muted-foreground`} />;
}
