"use client";

import type { archestraApiTypes } from "@archestra/shared";
import Link from "next/link";
import { AgentIcon } from "@/components/agent-icon";
import { type PinnedTile, PinnedTiles } from "@/components/pinned-tiles";
import { Button } from "@/components/ui/button";
import { ProjectActionsMenu } from "./projects-table";

type ProjectListItem = archestraApiTypes.GetProjectsResponses["200"][number];

/**
 * The projects the viewer pinned, as tiles above the table. Each opens the
 * project, and its one action starts a new chat in it.
 */
export function ProjectPinnedTiles({
  projects,
  onUnpin,
  onEdit,
  onDelete,
}: {
  /** Pinned projects, newest pin first. */
  projects: ProjectListItem[];
  onUnpin: (project: ProjectListItem) => void;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
}) {
  const tiles: PinnedTile[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    href: `/projects/${project.id}`,
    icon: <AgentIcon icon={project.icon} fallbackType="project" size={18} />,
    status: describeProject(project),
    action: (
      <Button size="sm" asChild>
        <Link href={`/chat?project=${encodeURIComponent(project.id)}`}>
          New chat
        </Link>
      </Button>
    ),
    onUnpin: () => onUnpin(project),
    menu: (
      <ProjectActionsMenu
        project={project}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    ),
  }));

  return <PinnedTiles tiles={tiles} />;
}

function describeProject(project: ProjectListItem): string {
  const chats = `${project.conversationCount} ${
    project.conversationCount === 1 ? "chat" : "chats"
  }`;
  return project.description ? `${chats} · ${project.description}` : chats;
}
