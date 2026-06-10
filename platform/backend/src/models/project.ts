import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  Conversation,
  InsertProject,
  Message,
  Project,
  ProjectScope,
  UpdateProject,
} from "@/types";
import { escapeLikePattern } from "@/utils/sql-search";
import ProjectKnowledgeBaseModel from "./project-knowledge-base";
import ProjectTeamModel from "./project-team";

class ProjectModel {
  static async findByOrganization(params: {
    organizationId: string;
    userId: string;
    isProjectAdmin: boolean;
    limit: number;
    offset: number;
    search?: string;
    scope?: ProjectScope;
  }): Promise<PaginatedResult<Project>> {
    const filters = buildProjectFilters(params);
    const [rows, total] = await Promise.all([
      db
        .select({
          project: getTableColumns(schema.projectsTable),
          author: {
            name: schema.usersTable.name,
            email: schema.usersTable.email,
          },
        })
        .from(schema.projectsTable)
        .leftJoin(
          schema.usersTable,
          eq(schema.projectsTable.authorId, schema.usersTable.id),
        )
        .where(and(...filters))
        .orderBy(desc(schema.projectsTable.updatedAt))
        .limit(params.limit)
        .offset(params.offset),
      db
        .select({ count: count() })
        .from(schema.projectsTable)
        .where(and(...filters)),
    ]);

    const projects = await hydrateProjects(
      rows.map((row) => ({
        ...row.project,
        authorName: row.author?.name ?? null,
        authorEmail: row.author?.email ?? null,
      })),
    );

    return createPaginatedResult(projects, total[0]?.count ?? 0, {
      limit: params.limit,
      offset: params.offset,
    });
  }

  static async findById(params: {
    id: string;
    organizationId: string;
  }): Promise<Project | null> {
    const [row] = await db
      .select({
        project: getTableColumns(schema.projectsTable),
        author: {
          name: schema.usersTable.name,
          email: schema.usersTable.email,
        },
      })
      .from(schema.projectsTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.projectsTable.authorId, schema.usersTable.id),
      )
      .where(
        and(
          eq(schema.projectsTable.id, params.id),
          eq(schema.projectsTable.organizationId, params.organizationId),
        ),
      );

    if (!row) return null;

    const [project] = await hydrateProjects([
      {
        ...row.project,
        authorName: row.author?.name ?? null,
        authorEmail: row.author?.email ?? null,
      },
    ]);

    return project ?? null;
  }

  static async findDetailById(params: {
    id: string;
    organizationId: string;
  }): Promise<Project | null> {
    const project = await ProjectModel.findById(params);
    if (!project) return null;

    const [recentConversations, scheduledTriggers] = await Promise.all([
      findRecentConversationsForProject(project.id),
      findScheduleTriggersForProject(project.id),
    ]);

    return {
      ...project,
      recentConversations,
      scheduledTriggers,
    };
  }

  static async create(params: {
    organizationId: string;
    authorId: string;
    data: InsertProject;
  }): Promise<Project> {
    const { teamIds, knowledgeBaseIds, ...project } = params.data;
    const [created] = await db
      .insert(schema.projectsTable)
      .values({
        ...project,
        organizationId: params.organizationId,
        authorId: params.authorId,
      })
      .returning();

    await Promise.all([
      ProjectTeamModel.syncProjectTeams(
        created.id,
        project.scope === "team" ? teamIds : [],
      ),
      ProjectKnowledgeBaseModel.syncForProject(created.id, knowledgeBaseIds),
    ]);

    const hydrated = await ProjectModel.findById({
      id: created.id,
      organizationId: params.organizationId,
    });
    if (!hydrated) {
      throw new Error("Failed to load created project");
    }
    return hydrated;
  }

  static async update(params: {
    id: string;
    organizationId: string;
    data: UpdateProject;
  }): Promise<Project | null> {
    const { teamIds, knowledgeBaseIds, ...project } = params.data;

    const updated = await withDbTransaction(async (tx) => {
      const [row] = await tx
        .update(schema.projectsTable)
        .set(project)
        .where(
          and(
            eq(schema.projectsTable.id, params.id),
            eq(schema.projectsTable.organizationId, params.organizationId),
          ),
        )
        .returning();

      if (!row) return null;

      if (teamIds !== undefined || project.scope !== undefined) {
        await tx
          .delete(schema.projectTeamsTable)
          .where(eq(schema.projectTeamsTable.projectId, params.id));
        const nextTeamIds = project.scope === "team" ? (teamIds ?? []) : [];
        if (nextTeamIds.length > 0) {
          await tx.insert(schema.projectTeamsTable).values(
            nextTeamIds.map((teamId) => ({
              projectId: params.id,
              teamId,
            })),
          );
        }
      }

      if (knowledgeBaseIds !== undefined) {
        await tx
          .delete(schema.projectKnowledgeBasesTable)
          .where(eq(schema.projectKnowledgeBasesTable.projectId, params.id));
        if (knowledgeBaseIds.length > 0) {
          await tx.insert(schema.projectKnowledgeBasesTable).values(
            knowledgeBaseIds.map((knowledgeBaseId) => ({
              projectId: params.id,
              knowledgeBaseId,
            })),
          );
        }
      }

      return row;
    });

    if (!updated) return null;

    return await ProjectModel.findById({
      id: params.id,
      organizationId: params.organizationId,
    });
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const [deleted] = await db
      .delete(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.id, params.id),
          eq(schema.projectsTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.projectsTable.id });

    return deleted !== undefined;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const project = await ProjectModel.findById({ id, organizationId });
    if (!project) return null;

    return {
      id: project.id,
      organizationId: project.organizationId,
      authorId: project.authorId,
      name: project.name,
      description: project.description,
      scope: project.scope,
      teamIds: project.teams.map((team) => team.id),
      knowledgeBaseIds: project.knowledgeBaseIds,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  static async userCanAccessProject(params: {
    projectId: string;
    organizationId: string;
    userId: string;
    isProjectAdmin: boolean;
  }): Promise<boolean> {
    if (params.isProjectAdmin) {
      const [row] = await db
        .select({ id: schema.projectsTable.id })
        .from(schema.projectsTable)
        .where(
          and(
            eq(schema.projectsTable.id, params.projectId),
            eq(schema.projectsTable.organizationId, params.organizationId),
          ),
        )
        .limit(1);
      return row !== undefined;
    }

    const [row] = await db
      .select({ id: schema.projectsTable.id })
      .from(schema.projectsTable)
      .leftJoin(
        schema.projectTeamsTable,
        eq(schema.projectsTable.id, schema.projectTeamsTable.projectId),
      )
      .leftJoin(
        schema.teamMembersTable,
        and(
          eq(schema.projectTeamsTable.teamId, schema.teamMembersTable.teamId),
          eq(schema.teamMembersTable.userId, params.userId),
        ),
      )
      .where(
        and(
          eq(schema.projectsTable.id, params.projectId),
          eq(schema.projectsTable.organizationId, params.organizationId),
          projectAccessPredicate(params.userId),
        ),
      )
      .limit(1);

    return row !== undefined;
  }
}

export default ProjectModel;

async function hydrateProjects<
  T extends typeof schema.projectsTable.$inferSelect & {
    authorName?: string | null;
    authorEmail?: string | null;
  },
>(projects: T[]): Promise<Project[]> {
  const projectIds = projects.map((project) => project.id);
  const [teamsByProject, knowledgeBasesByProject] = await Promise.all([
    ProjectTeamModel.getTeamDetailsForProjects(projectIds),
    ProjectKnowledgeBaseModel.getKnowledgeBasesForProjects(projectIds),
  ]);

  return projects.map((project) => {
    const knowledgeBases = knowledgeBasesByProject.get(project.id) ?? [];
    return {
      ...project,
      teams: teamsByProject.get(project.id) ?? [],
      knowledgeBases,
      knowledgeBaseIds: knowledgeBases.map((knowledgeBase) => knowledgeBase.id),
    };
  });
}

function buildProjectFilters(params: {
  organizationId: string;
  userId: string;
  isProjectAdmin: boolean;
  search?: string;
  scope?: ProjectScope;
}): SQL[] {
  const filters: SQL[] = [
    eq(schema.projectsTable.organizationId, params.organizationId),
  ];

  if (!params.isProjectAdmin) {
    filters.push(projectAccessPredicate(params.userId));
  }

  if (params.scope) {
    filters.push(eq(schema.projectsTable.scope, params.scope));
  }

  const trimmedSearch = params.search?.trim();
  if (trimmedSearch) {
    const searchPattern = `%${escapeLikePattern(trimmedSearch)}%`;
    const searchFilter = or(
      ilike(schema.projectsTable.name, searchPattern),
      ilike(schema.projectsTable.description, searchPattern),
    );
    if (searchFilter) filters.push(searchFilter);
  }

  return filters;
}

function projectAccessPredicate(userId: string): SQL {
  return or(
    eq(schema.projectsTable.scope, "org"),
    and(
      eq(schema.projectsTable.scope, "personal"),
      eq(schema.projectsTable.authorId, userId),
    ),
    and(
      eq(schema.projectsTable.scope, "team"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.projectTeamsTable}
        INNER JOIN ${schema.teamMembersTable}
          ON ${schema.projectTeamsTable.teamId} = ${schema.teamMembersTable.teamId}
        WHERE ${schema.projectTeamsTable.projectId} = ${schema.projectsTable.id}
          AND ${schema.teamMembersTable.userId} = ${userId}
      )`,
    ),
  ) as SQL;
}

async function findRecentConversationsForProject(
  projectId: string,
): Promise<Conversation[]> {
  const rows = await db
    .select({
      conversation: getTableColumns(schema.conversationsTable),
      share: {
        id: schema.conversationSharesTable.id,
        visibility: schema.conversationSharesTable.visibility,
      },
      agent: {
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        systemPrompt: schema.agentsTable.systemPrompt,
        agentType: schema.agentsTable.agentType,
        toolExposureMode: schema.agentsTable.toolExposureMode,
        llmApiKeyId: schema.agentsTable.llmApiKeyId,
        deletedAt: schema.agentsTable.deletedAt,
      },
    })
    .from(schema.conversationsTable)
    .leftJoin(
      schema.agentsTable,
      eq(schema.conversationsTable.agentId, schema.agentsTable.id),
    )
    .leftJoin(
      schema.conversationSharesTable,
      eq(
        schema.conversationsTable.id,
        schema.conversationSharesTable.conversationId,
      ),
    )
    .where(eq(schema.conversationsTable.projectId, projectId))
    .orderBy(desc(schema.conversationsTable.lastMessageAt))
    .limit(10);

  const messagesByConversation = await findFirstUserMessagesForConversations(
    rows.map((row) => row.conversation.id),
  );

  return rows.map((row) => ({
    ...row.conversation,
    project: null,
    agent: row.agent?.id
      ? {
          id: row.agent.id,
          name: row.agent.name ?? "",
          systemPrompt: row.agent.systemPrompt,
          agentType: row.agent.agentType ?? "agent",
          toolExposureMode: row.agent.toolExposureMode ?? "full",
          llmApiKeyId: row.agent.llmApiKeyId,
        }
      : null,
    share: row.share?.id ? row.share : null,
    messages: messagesByConversation.get(row.conversation.id) ?? [],
    chatErrors: [],
    compactions: [],
  }));
}

async function findFirstUserMessagesForConversations(
  conversationIds: string[],
): Promise<Map<string, Message["content"][]>> {
  if (conversationIds.length === 0) return new Map();

  const rows = await db
    .select({
      conversationId: schema.messagesTable.conversationId,
      content: schema.messagesTable.content,
      createdAt: schema.messagesTable.createdAt,
    })
    .from(schema.messagesTable)
    .where(
      and(
        inArray(schema.messagesTable.conversationId, conversationIds),
        eq(schema.messagesTable.role, "user"),
      ),
    )
    .orderBy(asc(schema.messagesTable.createdAt));

  const messagesByConversation = new Map<string, Message["content"][]>();
  for (const row of rows) {
    if (messagesByConversation.has(row.conversationId)) continue;
    messagesByConversation.set(row.conversationId, [row.content]);
  }
  return messagesByConversation;
}

async function findScheduleTriggersForProject(projectId: string) {
  return await db
    .select()
    .from(schema.scheduleTriggersTable)
    .where(eq(schema.scheduleTriggersTable.projectId, projectId))
    .orderBy(asc(schema.scheduleTriggersTable.createdAt));
}
