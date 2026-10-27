import { randomUUID } from "node:crypto";
import db, { schema } from "@/database";
import {
  type RoutingDecisionFeatures,
  RoutingSessionKeySchema,
} from "@/types/auto-routing";
import { plannedDecision } from "./auto-routing";

/**
 * `sessions` scored sessions of `scorerVersionId` routed to `modelId`, spread
 * over a month and idle for over a day: history the next fit reads.
 * `session` overrides the i-th session's features and creation time.
 */
export async function seedFitHistory(params: {
  organizationId: string;
  modelId: string;
  scorerVersionId: string;
  sessions: number;
  session?: (i: number) => {
    features: RoutingDecisionFeatures;
    createdAt: Date;
  };
}) {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const decisions = await db
    .insert(schema.routingDecisionsTable)
    .values(
      Array.from({ length: params.sessions }, (_, i) => ({
        ...plannedDecision({
          ...params,
          sessionKey: RoutingSessionKeySchema.parse(randomUUID()),
        }),
        createdAt: new Date(now - (2 + (i % 30)) * day),
        ...params.session?.(i),
      })),
    )
    .returning();
  await db.insert(schema.routingUsageTable).values(
    decisions.map((decision, i) => ({
      interactionId: randomUUID(),
      decisionId: decision.id,
      createdAt: decision.createdAt,
      input: 1_000 + 37 * i,
      cacheRead: 20_000 + 101 * i,
      cacheWrite: 2_000,
      cacheWrite1h: 0,
      output: 500 + 11 * i,
      estimated: false,
    })),
  );
}
