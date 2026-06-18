import type { archestraApiTypes } from "@archestra/shared";
import { FolderGit2, Github, Globe, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type ConnectorType =
  archestraApiTypes.CreateConnectorData["body"]["connectorType"];
type ConnectorIcon =
  | { kind: "img"; src: string }
  | { kind: "element"; render: (className?: string) => ReactNode };

const CONNECTOR_ICON_MAP: Partial<Record<ConnectorType, ConnectorIcon>> = {
  jira: { kind: "img", src: "/icons/jira.png" },
  confluence: { kind: "img", src: "/icons/confluence.png" },
  github: {
    kind: "element",
    render: (className) => <Github className={className} />,
  },
  gitlab: { kind: "img", src: "/icons/gitlab.png" },
  servicenow: { kind: "img", src: "/icons/servicenow.png" },
  notion: { kind: "img", src: "/icons/notion.png" },
  sharepoint: { kind: "img", src: "/icons/sharepoint.png" },
  gdrive: { kind: "img", src: "/icons/gdrive.png" },
  file_upload: {
    kind: "element",
    render: (className) => <Upload className={className} />,
  },
  linear: { kind: "img", src: "/icons/linear.png" },
  dropbox: { kind: "img", src: "/icons/dropbox.png" },
  onedrive: { kind: "img", src: "/icons/onedrive.png" },
  asana: { kind: "img", src: "/icons/asana.png" },
  salesforce: { kind: "img", src: "/icons/salesforce.png" },
  outline: { kind: "img", src: "/icons/getoutline.png" },
  web_crawler: {
    kind: "element",
    render: (className) => <Globe className={className} />,
  },
  perforce: {
    kind: "element",
    render: (className) => <FolderGit2 className={className} />,
  },
};

export function hasConnectorIcon(type: string): boolean {
  return type in CONNECTOR_ICON_MAP;
}

export function ConnectorTypeIcon({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  const icon = CONNECTOR_ICON_MAP[type as ConnectorType];
  if (!icon) return null;

  if (icon.kind === "element") {
    return <>{icon.render(className)}</>;
  }

  return (
    <img
      src={icon.src}
      alt={type}
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
