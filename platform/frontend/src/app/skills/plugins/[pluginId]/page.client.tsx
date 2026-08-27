"use client";

import { Puzzle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AgentBadge } from "@/components/agent-badge";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { usePluginSkill } from "@/lib/skills/skill.query";
import { SkillContentEditor } from "../../_parts/skill-content-editor";
import {
  SkillBackLink,
  SkillNotFound,
  SkillPageLoading,
} from "../../_parts/skill-page-shell";

export function PluginSkillPage({ pluginId }: { pluginId: string }) {
  const appName = useAppName();
  const search = useSearchParams();
  const skillPath = search.get("skillPath") ?? "";
  const { data: canManagePlugin } = useHasPermissions({ plugin: ["admin"] });
  const { data: skill, isPending } = usePluginSkill({ pluginId, skillPath });

  if (isPending) return <SkillPageLoading />;
  if (!skill) return <SkillNotFound />;

  return (
    <PageLayout
      title={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate">{skill.name}</span>
          <AgentBadge type={skill.scope} />
          <Badge variant="secondary">Beta</Badge>
        </div>
      }
      description={skill.description}
      backLink={<SkillBackLink href="/skills" label="Skills" />}
    >
      <div className="mb-4 flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2.5 text-sm text-muted-foreground">
        <Puzzle className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <p>
          <span>This portable skill comes from </span>
          {canManagePlugin ? (
            <Link
              href={`/plugins/${skill.pluginId}`}
              className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
            >
              {skill.pluginName}
            </Link>
          ) : (
            <span className="font-medium text-foreground">
              {skill.pluginName}
            </span>
          )}
          <span>
            , a plugin for {skill.clientType}. Its source bytes remain managed
            by the plugin and are not copied or versioned as a standalone{" "}
            {appName} skill.
          </span>
        </p>
      </div>
      <div className="rounded-lg border p-6">
        <SkillContentEditor
          manifest={skill.manifest}
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
