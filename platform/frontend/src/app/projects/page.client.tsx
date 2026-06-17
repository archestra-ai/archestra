"use client";

import { FolderKanban, Plus, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCreateProject, useProjects } from "@/lib/projects/projects.query";

export default function ProjectsPageClient() {
  return (
    <ErrorBoundary>
      <ProjectsList />
    </ErrorBoundary>
  );
}

function ProjectsList() {
  const { data, isPending } = useProjects();
  const [createOpen, setCreateOpen] = useState(false);
  const projects = data ?? [];

  return (
    <PageLayout
      title="Projects"
      description="Collections of chats with shared files. Share a project to let teammates follow along and start their own chats."
      actionButton={
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New project
        </Button>
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
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="rounded-lg border p-4 transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{project.name}</span>
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
                </span>
              </div>
              {project.description && (
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {project.description}
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                {project.conversationCount}{" "}
                {project.conversationCount === 1 ? "chat" : "chats"}
              </p>
            </Link>
          ))}
        </div>
      )}
    </PageLayout>
  );
}

// === internal components ===

function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm<{ name: string; description: string }>({
    defaultValues: { name: "", description: "" },
  });
  const createProject = useCreateProject();

  const onSubmit = form.handleSubmit(async ({ name, description }) => {
    const project = await createProject.mutateAsync({
      name: name.trim(),
      description: description.trim() || null,
    });
    if (project) {
      form.reset();
      onOpenChange(false);
      router.push(`/projects/${project.id}`);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Files the agent saves in this project are kept together and show
              up in your files. The name cannot be changed later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <Input
              autoFocus
              placeholder="Project name"
              {...form.register("name", { required: true, maxLength: 128 })}
            />
            <Textarea
              placeholder="Description (optional)"
              rows={3}
              {...form.register("description", { maxLength: 4096 })}
            />
          </div>
          <DialogFooter>
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
