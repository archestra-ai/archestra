"use client";

import {
  FolderKanban,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentIcon } from "@/components/agent-icon";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import { NoApiKeySetup } from "@/components/no-api-key-setup";
import { PageLayout } from "@/components/page-layout";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useHasAnyApiKey } from "@/lib/llm-provider-api-keys.query";
import { sortProjectsPinnedFirst } from "@/lib/projects/project-sort";
import {
  useCreateProject,
  usePinProject,
  useProjects,
} from "@/lib/projects/projects.query";

export default function ProjectsPageClient() {
  return (
    <ErrorBoundary>
      <ProjectsList />
    </ErrorBoundary>
  );
}

const PROJECTS_DESCRIPTION =
  "Collections of chats with shared files. Share a project to let teammates follow along and start their own chats.";

function ProjectsList() {
  const { data, isPending } = useProjects();
  const { hasAnyApiKey, isLoading: isApiKeyLoading } = useHasAnyApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const projects = useMemo(() => sortProjectsPinnedFirst(data ?? []), [data]);
  const pinProjectMutation = usePinProject();

  // Mirror the new-chat screen: with no usable LLM key there's nothing to run a
  // project on, so prompt to add one instead of offering project creation.
  if (!isApiKeyLoading && !hasAnyApiKey) {
    return (
      <PageLayout title="Projects" description={PROJECTS_DESCRIPTION}>
        <NoApiKeySetup description="Connect an LLM provider to start a project" />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Projects"
      description={PROJECTS_DESCRIPTION}
      actionButton={
        hasAnyApiKey ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New project
          </Button>
        ) : undefined
      }
    >
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
      {projects.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
          <FolderKanban className="h-8 w-8 opacity-50" />
          <p>{isPending ? "Loading…" : "No projects yet"}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <div
              key={project.id}
              className="rounded-lg border p-4 transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center justify-between gap-2">
                <Link
                  href={`/projects/${project.id}`}
                  className="flex min-w-0 items-center gap-2"
                >
                  <span className="shrink-0">
                    <AgentIcon
                      icon={project.icon}
                      fallbackType="project"
                      size={18}
                    />
                  </span>
                  <span className="min-w-0 truncate font-medium">
                    {project.name}
                  </span>
                  {project.pinnedAt && (
                    <Pin
                      className="h-3.5 w-3.5 shrink-0 fill-muted-foreground text-muted-foreground"
                      aria-label="Pinned project"
                    />
                  )}
                </Link>
                <span className="flex shrink-0 items-center gap-1">
                  {!project.isOwner && (
                    <Badge variant="secondary">Shared with you</Badge>
                  )}
                  {project.isOwner && project.visibility && (
                    <Badge variant="outline" className="gap-1">
                      <Users className="h-3 w-3" />
                      {project.visibility === "organization" ? "Org" : "Teams"}
                    </Badge>
                  )}
                  <ProjectCardActions
                    pinned={!!project.pinnedAt}
                    onTogglePin={() =>
                      pinProjectMutation.mutate({
                        id: project.id,
                        pinned: !project.pinnedAt,
                      })
                    }
                  />
                </span>
              </div>
              {project.description && (
                <Link
                  href={`/projects/${project.id}`}
                  className="mt-1 block line-clamp-2 text-sm text-muted-foreground"
                >
                  {project.description}
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </PageLayout>
  );
}

// === internal components ===

function ProjectCardActions({
  pinned,
  onTogglePin,
}: {
  pinned: boolean;
  onTogglePin: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Project actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onTogglePin}>
          {pinned ? (
            <PinOff className="h-4 w-4" />
          ) : (
            <Pin className="h-4 w-4" />
          )}
          {pinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type CreateProjectForm = {
  name: string;
  description: string;
  icon: string | null;
};

function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm<CreateProjectForm>({
    defaultValues: { name: "", description: "", icon: null },
  });
  const createProject = useCreateProject();
  const icon = form.watch("icon");

  const onSubmit = form.handleSubmit(async ({ name, description, icon }) => {
    const project = await createProject.mutateAsync({
      name: name.trim(),
      description: description.trim() || null,
      icon,
    });
    if (project) {
      form.reset();
      onOpenChange(false);
      router.push(`/projects/${project.id}`);
    }
  });

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="Files the agent saves in this project are kept together and show up in your files."
      size="small"
      onSubmit={onSubmit}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              createProject.isPending || !form.watch("name").trim().length
            }
          >
            Create
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <AgentIconPicker
          value={icon}
          onChange={(next) => form.setValue("icon", next)}
          fallbackType="project"
        />
        <div className="flex-1 space-y-3">
          <Input
            autoFocus
            placeholder="Project name"
            {...form.register("name", { required: true, maxLength: 256 })}
          />
          <Textarea
            placeholder="Description (optional)"
            rows={3}
            {...form.register("description", { maxLength: 4096 })}
          />
        </div>
      </div>
    </StandardFormDialog>
  );
}
