const CONNECTOR_ICON_MAP: Record<string, string> = {
  jira: "/icons/jira.png",
  confluence: "/icons/confluence.png",
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
  const src = CONNECTOR_ICON_MAP[type];
  if (!src) return null;

  return <img src={src} alt={type} className={className} />;
}
