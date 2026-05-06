"use client";

import type { CatalogItem } from "../../_seed/types";

export function K8sYamlSection({ cat }: { cat: CatalogItem }) {
  const yaml = `# Catalog-level deployment template for ${cat.name}
# Per-pod rendered manifests are available from each pod's row in Deployments.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-${cat.id}-template
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mcp-${cat.id}
  template:
    metadata:
      labels:
        app: mcp-${cat.id}
    spec:
      containers:
        - name: mcp
          image: ${cat.image ?? "<image>"}
          ${cat.command ? `command: [${cat.command}]\n          ` : ""}args: ${JSON.stringify(cat.args)}
          ${cat.transport === "streamable-http" ? `ports:\n            - containerPort: ${cat.httpPort ?? 8080}` : ""}
`;

  return (
    <div className="space-y-3 px-4 py-4">
      <p className="text-xs text-muted-foreground">
        Catalog-level deployment template. Per-pod rendered YAML is available
        from each pod's actions in Deployments.
      </p>
      <pre className="rounded-md border bg-muted/30 p-4 font-mono text-xs leading-relaxed overflow-x-auto">
        {yaml}
      </pre>
    </div>
  );
}
