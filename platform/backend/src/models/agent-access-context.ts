import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentAccessContext } from "@/types";

export async function findAgentAccessContextById(
  agentId: string,
): Promise<AgentAccessContext | null> {
  const [agent] = await db
    .select({
      id: schema.agentsTable.id,
      organizationId: schema.agentsTable.organizationId,
      scope: schema.agentsTable.scope,
      authorId: schema.agentsTable.authorId,
    })
    .from(schema.agentsTable)
    .where(eq(schema.agentsTable.id, agentId))
    .limit(1);

  return agent ?? null;
}
