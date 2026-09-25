"use client";

import { Puzzle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AgentBadge } from "@/components/agent-badge";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { usePluginSkill } from "@/lib/skills/skill.query";
import { SkillContentEditor } from "../../_parts/skill-content-editor";
import {
  SkillBackLink,
  SkillNotFound,
  SkillPageLoading,
} from "../../_parts/skill-page-shell";

export function PluginSkillPage({ pluginId }: { pluginId: string }) {
  const search = useSearchParams();
  const skillPath = search.get("skillPath") ?? "";
  const { data: canManagePlugin } = useHasPermissions(
    { plugin: ["update"] },
    "*",
  );
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
      <InlineNotice variant="info" className="mb-4">
        <Puzzle />
        <InlineNoticeText>
          <span>This skill comes from </span>
          {canManagePlugin ? (
            <Link
              href={`/plugins/${skill.pluginId}`}
              className="font-medium underline decoration-border underline-offset-4 hover:decoration-current"
            >
              {skill.pluginName}
            </Link>
          ) : (
            <span className="font-medium">{skill.pluginName}</span>
          )}
          <span>
            , a plugin for {skill.clientType}. The plugin still owns these
            files.
          </span>
        </InlineNoticeText>
      </InlineNotice>
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
