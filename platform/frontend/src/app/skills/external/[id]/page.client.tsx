"use client";

import { Radio } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { composeManifest } from "@/lib/skills/manifest-compose";
import { useExternalMcpSkill } from "@/lib/skills/skill.query";
import { SkillContentEditor } from "../../_parts/skill-content-editor";
import {
  SkillBackLink,
  SkillNotFound,
  SkillPageLoading,
} from "../../_parts/skill-page-shell";

export function ExternalMcpSkillPage({ id }: { id: string }) {
  const search = useSearchParams();
  const mcpServerId = search.get("mcpServerId");
  const { data: skill, isPending } = useExternalMcpSkill({ id, mcpServerId });
  const manifest = useMemo(
    () =>
      skill
        ? composeManifest({
            name: skill.name,
            description: skill.description,
            license: null,
            compatibility: null,
            allowedTools: null,
            agentName: null,
            templated: false,
            metadata: {},
            content: skill.content,
          })
        : "",
    [skill],
  );

  if (isPending) return <SkillPageLoading />;
  if (!skill) return <SkillNotFound />;

  return (
    <PageLayout
      title={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate">{skill.name}</span>
          <AgentBadge type={skill.scope} />
          <Badge variant="outline" className="gap-1">
            <Radio className="size-3" />
            Live
          </Badge>
        </div>
      }
      description={skill.description || "Skill served by an MCP server"}
      backLink={<SkillBackLink href="/skills" label="Skills" />}
    >
      <div className="mb-4 flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2.5 text-sm text-muted-foreground">
        <Radio className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <p>
          This skill is read live from{" "}
          <Link
            href={`/mcp/registry/${skill.catalogId}`}
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
          >
            {skill.serverName}
          </Link>
          . Its content is not copied or versioned in Archestra; reload this
          page to read the latest source bytes.
        </p>
      </div>
      <div className="rounded-lg border p-6">
        <SkillContentEditor
          manifest={manifest}
          files={skill.files}
          onManifestChange={() => undefined}
          onFilesChange={() => undefined}
          readOnly
          className="h-[calc(100vh-20rem)] min-h-[32rem]"
        />
      </div>
    </PageLayout>
  );
}
