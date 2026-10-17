import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { type Transaction, withDbTransaction } from "@/database";
import { withTransactionRetry } from "@/database/retry";
import * as schema from "@/database/schemas";
import type { InteractionUserActivityState } from "@/types/interaction-user-activity";

export default class InteractionUserActivityModel {
  static async append(values: typeof schema.interactionsTable.$inferInsert) {
    const columns = getTableColumns(schema.interactionsTable);
    const payload: Record<string, string | null> = {};
    for (const [key, column] of Object.entries(columns)) {
      if (
        values[key as keyof typeof values] === undefined &&
        (column.defaultFn || (!column.default && column.onUpdateFn))
      ) {
        throw new Error(`Unsupported interaction runtime default: ${key}`);
      }
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (!Object.hasOwn(columns, key)) {
        throw new Error(`Unsupported interaction column: ${key}`);
      }
      const column = columns[key as keyof typeof columns];
      const encoded = value === null ? null : column.mapToDriverValue(value);
      if (
        encoded !== null &&
        typeof encoded !== "string" &&
        typeof encoded !== "number" &&
        typeof encoded !== "boolean" &&
        typeof encoded !== "bigint"
      ) {
        throw new Error(`Unsupported interaction encoding: ${key}`);
      }
      payload[column.name] = encoded === null ? null : String(encoded);
    }
    const selected = Object.fromEntries(
      Object.entries(columns).map(([key, column]) => [
        key,
        sql`${column}`.mapWith(column),
      ]),
    ) as {
      [Key in keyof typeof columns]: SQL<
        (typeof schema.interactionsTable.$inferSelect)[Key]
      >;
    };
    const [interaction] = await db
      .select(selected)
      .from(
        sql`interaction_user_activity_append(${JSON.stringify(payload)}::jsonb) AS interactions`,
      );
    return interaction;
  }

  static async state(): Promise<InteractionUserActivityState> {
    const [existing] = await db
      .select()
      .from(schema.interactionUserActivityStateTable);
    if (existing) return checkedState(existing);
    await db
      .insert(schema.interactionUserActivityStateTable)
      .values({ id: 1 })
      .onConflictDoNothing();
    const [state] = await db
      .select()
      .from(schema.interactionUserActivityStateTable);
    if (!state)
      throw new Error(
        "Activity summary state disappeared during initialization",
      );
    return checkedState(state);
  }

  static async mostActive(params: {
    organizationId: string;
    limit: number;
    generation: number;
  }) {
    const activity = schema.interactionUserActivityTable;
    const state = schema.interactionUserActivityStateTable;
    return db
      .select({ id: activity.userId, name: schema.usersTable.name })
      .from(activity)
      .innerJoin(schema.usersTable, eq(schema.usersTable.id, activity.userId))
      .innerJoin(
        state,
        and(
          eq(state.id, 1),
          eq(state.enabled, true),
          eq(state.ready, true),
          eq(state.generation, params.generation),
        ),
      )
      .where(eq(activity.organizationId, params.organizationId))
      .orderBy(
        desc(activity.activityCount),
        asc(schema.usersTable.name),
        asc(activity.userId),
      )
      .limit(params.limit);
  }

  static async mutate<Result>(params: {
    userIds: (string | null | undefined)[];
    run: (tx: Transaction) => Promise<{ result: Result; changes: Change[] }>;
  }): Promise<Result> {
    return withDbTransaction(async (tx) => {
      const { state, checkpoints } =
        await InteractionUserActivityModel.fenceAndLockUsers({
          tx,
          userIds: params.userIds,
        });
      const { result, changes } = await params.run(tx);
      await InteractionUserActivityModel.apply({
        tx,
        state,
        changes,
        initialized: checkpoints
          .filter((row) => row.generation === state.generation)
          .map((row) => row.userId),
      });
      return result;
    });
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  static async deleteExpiredBatch(params: {
    retentionDays: number;
    batchSize: number;
  }) {
    return withDbTransaction(async (tx) => {
      const state = await InteractionUserActivityModel.fence(tx);
      const selected = await tx.execute<{
        id: string;
        user_id: string | null;
      }>(sql`
        SELECT i.id, i.user_id FROM interactions i
        WHERE i.created_at < now()::timestamp - make_interval(days => ${params.retentionDays})
          AND NOT EXISTS (SELECT 1 FROM interactions c WHERE c.parent_id = i.id)
        LIMIT ${params.batchSize}
      `);
      if (!selected.rows.length) return 0;
      const checkpoints = await InteractionUserActivityModel.lockUsers({
        tx,
        state,
        userIds: selected.rows.map((row) => row.user_id),
      });
      const removed = await tx
        .delete(schema.interactionsTable)
        .where(
          and(
            inArray(
              schema.interactionsTable.id,
              selected.rows.map((row) => row.id),
            ),
            sql`EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(selected.rows)}::jsonb) AS selected(id uuid,user_id text) WHERE selected.id=${schema.interactionsTable.id} AND selected.user_id IS NOT DISTINCT FROM ${schema.interactionsTable.userId})`,
            sql`NOT EXISTS (SELECT 1 FROM interactions child WHERE child.parent_id=${schema.interactionsTable.id})`,
          ),
        )
        .returning({
          userId: schema.interactionsTable.userId,
          profileId: schema.interactionsTable.profileId,
          appId: schema.interactionsTable.appId,
          connectorId: schema.interactionsTable.connectorId,
        });
      await InteractionUserActivityModel.apply({
        tx,
        state,
        initialized: checkpoints
          .filter((row) => row.generation === state.generation)
          .map((row) => row.userId),
        changes: removed.map((row) => ({ ...row, delta: -1 })),
      });
      return removed.length;
    });
  }
  // SPDX-SnippetEnd

  static async invalidate() {
    await db.execute(
      sql`UPDATE interaction_user_activity_state SET generation=generation+1, ready=false WHERE id=1`,
    );
  }

  static async setEnabled(enabled: boolean) {
    await InteractionUserActivityModel.state();
    await db
      .update(schema.interactionUserActivityStateTable)
      .set({
        enabled,
        ready: false,
        generation: sql`generation+1`,
        revision: sql`revision+1`,
      })
      .where(
        and(
          eq(schema.interactionUserActivityStateTable.id, 1),
          eq(schema.interactionUserActivityStateTable.enabled, !enabled),
        ),
      );
  }

  static async updateAttribution(params: {
    id: string;
    attribution: Partial<
      Pick<
        typeof schema.interactionsTable.$inferInsert,
        "userId" | "profileId" | "appId" | "connectorId"
      >
    >;
  }) {
    const table = schema.interactionsTable;
    const columns = {
      id: table.id,
      userId: table.userId,
      profileId: table.profileId,
      appId: table.appId,
      connectorId: table.connectorId,
    };
    // Attribution rarely races; retry only when the selected checkpoint changed, with a bounded failure instead of starvation.
    for (let attempt = 0; attempt < 5; attempt++) {
      const [previous] = await db
        .select(columns)
        .from(table)
        .where(eq(table.id, params.id));
      if (!previous) return undefined;
      const outcome = await InteractionUserActivityModel.mutate<{
        retry: boolean;
        row: typeof previous | undefined;
      }>({
        userIds: [previous.userId, params.attribution.userId],
        run: async (tx) => {
          const [current] = await tx
            .select(columns)
            .from(table)
            .where(eq(table.id, params.id))
            .for("update");
          if (!current)
            return { result: { retry: false, row: undefined }, changes: [] };
          if (current.userId !== previous.userId)
            return { result: { retry: true, row: undefined }, changes: [] };
          const [updated] = await tx
            .update(table)
            .set(params.attribution)
            .where(eq(table.id, params.id))
            .returning(columns);
          return {
            result: { retry: false, row: updated },
            changes: [
              { ...current, delta: -1 },
              { ...updated, delta: 1 },
            ],
          };
        },
      });
      if (!outcome.retry) return outcome.row;
    }
    throw new Error(
      "Concurrent attribution updates did not settle; retry the operation",
    );
  }

  static async lifecycleFence(tx: Transaction) {
    await tx
      .insert(schema.interactionUserActivityStateTable)
      .values({ id: 1 })
      .onConflictDoNothing();
    await tx
      .select()
      .from(schema.interactionUserActivityStateTable)
      .where(eq(schema.interactionUserActivityStateTable.id, 1))
      .for("update");
  }

  static async rebuildBatch(params: { batchSize?: number } = {}) {
    if (!(await InteractionUserActivityModel.state()).enabled)
      return { processed: 0, ready: false, restarted: false };
    const batchSize = params.batchSize ?? 100;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
      throw new Error("Batch size must be 1..1000");
    const snapshot = await withTransactionRetry(() =>
      db.transaction(
        async (tx) => {
          const [state] = await tx
            .select()
            .from(schema.interactionUserActivityStateTable);
          if (!state)
            throw new Error("Activity summary migration is not installed");
          checkedState(state);
          const pending = await tx.execute<{ id: string }>(sql`
        SELECT u.id FROM "user" u LEFT JOIN interaction_user_activity_users checkpoint ON checkpoint.user_id=u.id
        WHERE checkpoint.generation IS DISTINCT FROM ${state.generation}
        ORDER BY u.id LIMIT ${batchSize}
      `);
          const userIds = pending.rows.map((row) => row.id);
          if (!userIds.length)
            return {
              state,
              userIds,
              counts: [] as Delta[],
              balances: [] as Delta[],
              missing: [] as { kind: string; ownerId: string }[],
            };
          const counts = await tx.execute<DeltaRow>(
            aggregate(
              sql`(SELECT user_id, profile_id, app_id, connector_id, 1::bigint AS delta FROM interactions WHERE user_id=ANY(${sql.param(userIds)}::text[])) AS input`,
            ),
          );
          const balances = await tx
            .select()
            .from(schema.interactionUserActivityDeltasTable)
            .where(
              and(
                inArray(
                  schema.interactionUserActivityDeltasTable.userId,
                  userIds,
                ),
                eq(
                  schema.interactionUserActivityDeltasTable.generation,
                  state.generation,
                ),
              ),
            );
          const missing = await tx.execute<{
            kind: string;
            owner_id: string;
          }>(sql`
        SELECT DISTINCT 'app' AS kind, i.app_id::text AS owner_id FROM interactions i LEFT JOIN apps owner ON owner.id=i.app_id WHERE i.user_id=ANY(${sql.param(userIds)}::text[]) AND i.app_id IS NOT NULL AND owner.id IS NULL
        UNION SELECT DISTINCT 'connector', i.connector_id::text FROM interactions i LEFT JOIN knowledge_base_connectors owner ON owner.id=i.connector_id WHERE i.user_id=ANY(${sql.param(userIds)}::text[]) AND i.connector_id IS NOT NULL AND owner.id IS NULL
      `);
          return {
            state,
            userIds,
            counts: counts.rows.map(deltaRow),
            balances: balances.map((row) => ({ ...row, delta: row.balance })),
            missing: missing.rows.map((row) => ({
              kind: row.kind,
              ownerId: row.owner_id,
            })),
          };
        },
        { isolationLevel: "repeatable read" },
      ),
    );
    return withDbTransaction(async (tx) => {
      const state = await InteractionUserActivityModel.fence(tx);
      if (
        state.generation !== snapshot.state.generation ||
        state.revision !== snapshot.state.revision
      )
        return { processed: 0, ready: false, restarted: true };
      if (snapshot.missing.length)
        await tx
          .insert(schema.interactionUserActivityMissingOwnersTable)
          .values(snapshot.missing)
          .onConflictDoNothing();
      const checkpoints = await InteractionUserActivityModel.lockUsers({
        tx,
        state: { ...state, ready: false },
        userIds: snapshot.userIds,
      });
      const pending = checkpoints
        .filter((row) => row.generation !== state.generation)
        .map((row) => row.userId);
      if (pending.length) {
        const live = await tx
          .select()
          .from(schema.interactionUserActivityDeltasTable)
          .where(
            and(
              inArray(
                schema.interactionUserActivityDeltasTable.userId,
                pending,
              ),
              eq(
                schema.interactionUserActivityDeltasTable.generation,
                state.generation,
              ),
            ),
          );
        const totals = new Map<string, Delta>();
        const add = (row: Delta, sign = 1) => {
          if (!pending.includes(row.userId)) return;
          const key = JSON.stringify([row.organizationId, row.userId]);
          const previous = totals.get(key)?.delta ?? 0;
          totals.set(key, {
            ...row,
            delta: safeInteger(previous + sign * safeInteger(row.delta)),
          });
        };
        for (const row of snapshot.counts) add(row);
        for (const row of snapshot.balances) add(row, -1);
        for (const row of live) add({ ...row, delta: row.balance });
        const values = [...totals.values()];
        if (values.some((row) => row.delta < 0))
          throw new Error(
            "Activity summary reconciliation produced a negative count",
          );
        await tx
          .delete(schema.interactionUserActivityTable)
          .where(inArray(schema.interactionUserActivityTable.userId, pending));
        const positive = values.filter((row) => row.delta > 0);
        if (positive.length)
          await tx.insert(schema.interactionUserActivityTable).values(
            positive.map((row) => ({
              organizationId: row.organizationId,
              userId: row.userId,
              activityCount: row.delta,
            })),
          );
        await tx
          .update(schema.interactionUserActivityUsersTable)
          .set({ generation: state.generation })
          .where(
            inArray(schema.interactionUserActivityUsersTable.userId, pending),
          );
      }
      return {
        processed: pending.length,
        ready: state.ready,
        restarted: false,
      };
    }).then(async (result) => ({
      ...result,
      ready: await InteractionUserActivityModel.finish(),
    }));
  }

  private static async finish() {
    return withDbTransaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(schema.interactionUserActivityStateTable)
        .where(eq(schema.interactionUserActivityStateTable.id, 1))
        .for("update");
      if (!state)
        throw new Error("Activity summary migration is not installed");
      checkedState(state);
      if (!state.enabled) return false;
      const pending = await tx.execute(
        sql`SELECT 1 FROM "user" u LEFT JOIN interaction_user_activity_users checkpoint ON checkpoint.user_id=u.id WHERE checkpoint.generation IS DISTINCT FROM ${state.generation} LIMIT 1`,
      );
      if (pending.rows.length) return false;
      await tx
        .update(schema.interactionUserActivityStateTable)
        .set({ ready: true })
        .where(eq(schema.interactionUserActivityStateTable.id, 1));
      return true;
    });
  }

  private static async fence(
    tx: Transaction,
  ): Promise<InteractionUserActivityState> {
    const [state] = await tx
      .select()
      .from(schema.interactionUserActivityStateTable)
      .where(eq(schema.interactionUserActivityStateTable.id, 1))
      .for("share");
    if (!state) {
      await tx
        .insert(schema.interactionUserActivityStateTable)
        .values({ id: 1 })
        .onConflictDoNothing();
      return InteractionUserActivityModel.fence(tx);
    }
    return checkedState(state);
  }

  private static async fenceAndLockUsers(params: {
    tx: Transaction;
    userIds: (string | null | undefined)[];
  }) {
    const userIds = [
      ...new Set(params.userIds.filter((id): id is string => id != null)),
    ];
    if (userIds.length === 1) {
      const result = await params.tx.execute<
        InteractionUserActivityState & {
          checkpointUserId: string | null;
          checkpointGeneration: number | null;
        }
      >(sql`
        WITH fence AS MATERIALIZED (
          SELECT * FROM interaction_user_activity_state WHERE id=1 FOR SHARE
        )
        SELECT fence.*, checkpoint.user_id AS "checkpointUserId", checkpoint.generation AS "checkpointGeneration"
        FROM fence LEFT JOIN LATERAL (
          SELECT * FROM interaction_user_activity_users WHERE user_id=${userIds[0]}
          LIMIT CASE WHEN fence.enabled THEN 1 ELSE 0 END FOR UPDATE
        ) checkpoint ON true
      `);
      const row = result.rows[0];
      if (row) {
        const state: InteractionUserActivityState = {
          id: row.id,
          enabled: row.enabled,
          ready: row.ready,
          generation: safeInteger(row.generation),
          revision: safeInteger(row.revision),
        };
        if (!state.enabled) return { state, checkpoints: [] };
        if (row.checkpointUserId !== null)
          return {
            state,
            checkpoints: [
              {
                userId: row.checkpointUserId,
                generation: safeInteger(row.checkpointGeneration),
              },
            ],
          };
        return {
          state,
          checkpoints: await InteractionUserActivityModel.lockUsers({
            ...params,
            state,
          }),
        };
      }
    }
    const state = await InteractionUserActivityModel.fence(params.tx);
    return {
      state,
      checkpoints: await InteractionUserActivityModel.lockUsers({
        ...params,
        state,
      }),
    };
  }

  private static async lockUsers(params: {
    tx: Transaction;
    state: InteractionUserActivityState;
    userIds: (string | null | undefined)[];
  }) {
    if (!params.state.enabled) return [];
    const userIds = [
      ...new Set(params.userIds.filter((id): id is string => id != null)),
    ].sort();
    if (!userIds.length) return [];
    const table = schema.interactionUserActivityUsersTable;
    if (userIds.length === 1) {
      const existing = await params.tx
        .select()
        .from(table)
        .where(eq(table.userId, userIds[0]))
        .for("update");
      if (existing.length) {
        for (const row of existing) safeInteger(row.generation);
        return existing;
      }
    }
    await params.tx.execute(
      sql`INSERT INTO interaction_user_activity_users(user_id,generation) SELECT id, ${params.state.ready ? params.state.generation : 0} FROM "user" WHERE id=ANY(${sql.param(userIds)}::text[]) ORDER BY id ON CONFLICT DO NOTHING`,
    );
    const checkpoints = await params.tx
      .select()
      .from(table)
      .where(inArray(table.userId, userIds))
      .orderBy(table.userId)
      .for("update");
    for (const row of checkpoints) safeInteger(row.generation);
    return checkpoints;
  }

  private static async apply(params: {
    tx: Transaction;
    state: InteractionUserActivityState;
    changes: Change[];
    initialized: string[];
  }) {
    if (!params.state.enabled) return;
    if (!params.changes.some((row) => row.userId)) return;
    const rows = params.changes.map((row) => ({
      user_id: row.userId,
      profile_id: row.profileId ?? null,
      app_id: row.appId ?? null,
      connector_id: row.connectorId ?? null,
      delta: row.delta,
    }));
    if (rows.some((row) => row.app_id || row.connector_id))
      await params.tx.execute(sql`
      WITH changed AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS input(app_id uuid,connector_id uuid))
      INSERT INTO interaction_user_activity_missing_owners(kind,owner_id)
      SELECT DISTINCT 'app',changed.app_id::text FROM changed LEFT JOIN apps owner ON owner.id=changed.app_id WHERE changed.app_id IS NOT NULL AND owner.id IS NULL
      UNION SELECT DISTINCT 'connector',changed.connector_id::text FROM changed LEFT JOIN knowledge_base_connectors owner ON owner.id=changed.connector_id WHERE changed.connector_id IS NOT NULL AND owner.id IS NULL
      ON CONFLICT DO NOTHING
    `);
    await params.tx.execute(sql`
      WITH grouped AS (${aggregate(sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS input(user_id text,profile_id uuid,app_id uuid,connector_id uuid,delta bigint)`)}),
      deltas AS (SELECT organization_id,user_id,delta::bigint AS delta FROM grouped WHERE delta::bigint<>0),
      targets AS (
        SELECT deltas.organization_id,deltas.user_id,COALESCE(activity.activity_count,0)+deltas.delta AS activity_count
        FROM deltas LEFT JOIN interaction_user_activity activity USING(organization_id,user_id)
        WHERE deltas.user_id=ANY(${sql.param(params.initialized)}::text[])
      ),
      removed AS (
        DELETE FROM interaction_user_activity activity USING targets
        WHERE activity.organization_id=targets.organization_id AND activity.user_id=targets.user_id AND targets.activity_count=0
      ),
      counted AS (
        INSERT INTO interaction_user_activity(organization_id,user_id,activity_count)
        SELECT organization_id,user_id,activity_count FROM targets WHERE activity_count<>0
        ON CONFLICT(organization_id,user_id) DO UPDATE SET activity_count=excluded.activity_count
      )
      INSERT INTO interaction_user_activity_deltas(organization_id,user_id,generation,balance)
      SELECT organization_id,user_id,${params.state.generation},delta FROM deltas
      ON CONFLICT(organization_id,user_id) DO UPDATE SET generation=excluded.generation,
        balance=CASE WHEN interaction_user_activity_deltas.generation=excluded.generation
          THEN interaction_user_activity_deltas.balance+excluded.balance ELSE excluded.balance END
    `);
  }
}

type Change = {
  userId?: string | null;
  profileId?: string | null;
  appId?: string | null;
  connectorId?: string | null;
  delta: number;
};
type Delta = { organizationId: string; userId: string; delta: number };
type DeltaRow = { organization_id: string; user_id: string; delta: string };

function deltaRow(row: DeltaRow): Delta {
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    delta: safeInteger(row.delta),
  };
}

function safeInteger(value: string | number | null): number {
  const number = value === null ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(
      "Activity summary value exceeds JavaScript safe integer range",
    );
  return number;
}

function checkedState(
  state: InteractionUserActivityState,
): InteractionUserActivityState {
  safeInteger(state.generation);
  safeInteger(state.revision);
  return state;
}

function aggregate(source: SQL) {
  return sql`
    SELECT COALESCE(agent.organization_id, connector.organization_id, app.organization_id) AS organization_id,
      input.user_id, sum(input.delta)::text AS delta
    FROM ${source}
    LEFT JOIN agents agent ON agent.id=input.profile_id
    LEFT JOIN knowledge_base_connectors connector ON connector.id=input.connector_id
    LEFT JOIN apps app ON app.id=input.app_id
    WHERE input.user_id IS NOT NULL
      AND COALESCE(agent.organization_id,connector.organization_id,app.organization_id) IS NOT NULL
      AND (input.profile_id IS NULL OR agent.organization_id=COALESCE(agent.organization_id,connector.organization_id,app.organization_id))
      AND (input.connector_id IS NULL OR connector.organization_id=COALESCE(agent.organization_id,connector.organization_id,app.organization_id))
      AND (input.app_id IS NULL OR app.organization_id=COALESCE(agent.organization_id,connector.organization_id,app.organization_id))
    GROUP BY 1,input.user_id ORDER BY 1,input.user_id
  `;
}
