"use client";

import { useHasPermissions } from "@/lib/auth/auth.query";
import { EnvironmentsSection } from "../_parts/environments-section";

export default function EnvironmentsPageClient() {
  const { data: canEdit } = useHasPermissions({
    environment: ["create", "update", "delete"],
  });

  return (
    <div className="space-y-4">
      <div className="space-y-2 text-sm">
        <p>
          Environments are deployment targets for your MCP servers. Each catalog
          item belongs to exactly one environment, which sets the Kubernetes
          namespace its pods deploy into and controls who is allowed to deploy
          there.
        </p>

        <p>For example:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Run sandbox, staging, and production in separate namespaces (
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              sandbox
            </code>
            ,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              staging
            </code>
            ,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              prod-eu
            </code>
            ) so a sandbox MCP server can&rsquo;t reach production resources.
          </li>
          <li>
            Mark an environment{" "}
            <span className="font-semibold">&ldquo;Restricted&rdquo;</span>
            {" so "}
            only members with the &ldquo;Assign catalog items to restricted
            environments&rdquo; permission can deploy into it &mdash; anyone can
            experiment in a sandbox, while promoting to production stays
            admin-gated.
          </li>
        </ul>
      </div>

      <EnvironmentsSection canEdit={canEdit ?? false} />
    </div>
  );
}
