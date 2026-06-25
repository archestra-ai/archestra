"use client";

import { ArrowLeft, ArrowRight, FileText, Github } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { PageLayout } from "@/components/page-layout";
import { SearchInput } from "@/components/search-input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  type SkillCatalogResult,
  useSearchSkillCatalog,
} from "@/lib/skills/skill.query";
import {
  ImportSkillsDialog,
  type IndexedSkillSelection,
} from "../_parts/import-skills-dialog";
import { POPULAR_REPOS } from "../_parts/popular-repos";
import { SkillEditorDialog } from "../_parts/skill-editor-dialog";

export default function NewSkillPage() {
  return (
    <div className="h-full w-full">
      <ErrorBoundary>
        <NewSkillChooser />
      </ErrorBoundary>
    </div>
  );
}

function NewSkillChooser() {
  const router = useRouter();
  const [importState, setImportState] = useState<{
    repoUrl: string;
    autoDiscover: boolean;
    initialSkill?: IndexedSkillSelection;
  } | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [search, setSearch] = useState("");

  const openImport = () => setImportState({ repoUrl: "", autoDiscover: false });
  const importPopular = (repoUrl: string) =>
    setImportState({ repoUrl, autoDiscover: true });
  const importIndexedSkill = (skill: SkillCatalogResult) =>
    setImportState({
      repoUrl: skill.repo,
      autoDiscover: true,
      initialSkill: {
        skillPath: skill.skillPath,
        name: skill.name,
        description: skill.description,
        compatibility: skill.compatibility,
        fileCount: skill.fileCount,
      },
    });
  const goToSkills = () => router.push("/skills");

  const catalogSearch = useSearchSkillCatalog(search);
  const skillResults = catalogSearch.data?.results ?? [];
  const skillTotalCount = catalogSearch.data?.totalCount ?? null;

  const filteredRepos = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return POPULAR_REPOS;
    return POPULAR_REPOS.filter(
      (item) =>
        item.repo.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q),
    );
  }, [search]);

  const isSearchingSkills = search.trim().length > 0;

  return (
    <>
      <PageLayout
        title="Add a new skill"
        description="Import from a GitHub repo or start from a blank template."
        actionButton={
          <Button variant="outline" asChild>
            <Link href="/skills">
              <ArrowLeft className="h-4 w-4" />
              Back to skills
            </Link>
          </Button>
        }
      >
        <div className="mx-auto max-w-3xl space-y-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ActionCard
              icon={<Github className="size-5" />}
              title="Custom GitHub URL"
              description="Paste any repository with SKILL.md directories."
              onClick={openImport}
            />
            <ActionCard
              icon={<FileText className="size-5" />}
              title="Blank template"
              description="Write a SKILL.md manifest from scratch."
              onClick={() => setIsCreateOpen(true)}
            />
          </div>

          <Card className="gap-0 py-0">
            <CardHeader className="gap-3 border-b py-4">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">
                  {isSearchingSkills ? "Skill index" : "Popular repositories"}
                </CardTitle>
                <Badge variant="secondary" className="tabular-nums">
                  {isSearchingSkills
                    ? `${skillResults.length} / ${skillTotalCount ?? "…"}`
                    : POPULAR_REPOS.length}
                </Badge>
              </div>
              <SearchInput
                value={search}
                onSearchChange={setSearch}
                syncQueryParams={false}
                placeholder="Search skills by name, repo, or use case..."
                className="relative w-full"
              />
            </CardHeader>
            <CardContent className="p-0">
              {isSearchingSkills ? (
                catalogSearch.isLoading ? (
                  <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                    Searching the skill index…
                  </div>
                ) : catalogSearch.isError ? (
                  <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                    Could not search the skill index. Try again.
                  </div>
                ) : skillResults.length === 0 ? (
                  <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                    No indexed skills match “{search}”.
                  </div>
                ) : (
                  <ul>
                    {skillResults.map((skill, idx) => (
                      <li key={`${skill.repo}:${skill.skillPath}`}>
                        {idx > 0 && <Separator />}
                        <SkillIndexResult
                          skill={skill}
                          onClick={() => importIndexedSkill(skill)}
                        />
                      </li>
                    ))}
                  </ul>
                )
              ) : filteredRepos.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                  No repositories match “{search}”.
                </div>
              ) : (
                <ul>
                  {filteredRepos.map((item, idx) => {
                    const owner = item.repo.split("/")[0];
                    return (
                      <li key={item.repo}>
                        {idx > 0 && <Separator />}
                        <button
                          type="button"
                          onClick={() => importPopular(item.repo)}
                          className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                        >
                          <Avatar className="size-8">
                            <AvatarImage
                              src={`https://github.com/${owner}.png?size=64`}
                              alt=""
                            />
                            <AvatarFallback>
                              <Github className="size-4 text-muted-foreground" />
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-sm font-medium">
                              {item.repo}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {item.description}
                            </div>
                          </div>
                          <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </PageLayout>

      <ImportSkillsDialog
        open={importState !== null}
        initialRepoUrl={importState?.repoUrl ?? ""}
        initialSkill={importState?.initialSkill}
        autoDiscover={importState?.autoDiscover ?? false}
        onOpenChange={(open) => {
          if (!open) setImportState(null);
        }}
        onImported={goToSkills}
      />

      <SkillEditorDialog
        skillId={null}
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSaved={goToSkills}
      />
    </>
  );
}

function SkillIndexResult({
  skill,
  onClick,
}: {
  skill: SkillCatalogResult;
  onClick: () => void;
}) {
  const owner = skill.repo.split("/")[0];
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      aria-label={`Import ${skill.name} from ${skill.repo}`}
    >
      <Avatar className="size-8">
        <AvatarImage src={`https://github.com/${owner}.png?size=64`} alt="" />
        <AvatarFallback>
          <Github className="size-4 text-muted-foreground" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          <span className="shrink-0 rounded border px-1.5 py-px font-mono text-[10px] text-muted-foreground">
            {skill.repo}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {skill.description}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground/80">
          {skill.skillPath || "repo root"} · {skill.fileCount}{" "}
          {skill.fileCount === 1 ? "file" : "files"}
        </div>
      </div>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function ActionCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-3 rounded-xl border bg-card p-5 text-left text-card-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
        {icon}
      </div>
      <div className="space-y-1">
        <div className="font-medium leading-none">{title}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}
