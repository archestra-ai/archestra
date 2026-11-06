import {
  createSeededSubagentRandom,
  DEFAULT_SUBAGENT_LOAD_BALANCER_SCOPE_KEY,
  normalizeSubagentLoadBalancingConfig,
  normalizeSubagentWeight,
  orderSubagentsByLoadBalancing,
  resolveSubagentLoadBalancerScopeKey,
  type SubagentLoadBalancerScopeInput,
  type SubagentLoadBalancingConfig,
  stepSmoothWeightedRoundRobin,
  TimeInMs,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import { type AllowedCacheKey, CacheKey } from "@/cache-manager";
import db from "@/database";
import logger from "@/logging";

const SUBAGENT_LOAD_BALANCER_STATE_TTL_MS = 7 * TimeInMs.Day;

export interface SubagentLoadBalancerState {
  /**
   * Subagent IDs ordered from least-recently claimed (front) to
   * most-recently claimed (back).
   */
  queue: string[];
  /**
   * Monotonically increasing count of dispatches for this caller agent and scope.
   */
  dispatchCount: number;
  /**
   * Smooth weighted round-robin current counters keyed by subagent ID.
   */
  weightedCurrent?: Record<string, number>;
  /**
   * Last smooth weighted round-robin counter delta applied when each subagent
   * was claimed (`{ [claimedAgentId]: { [subagentId]: delta } }`), so
   * `releaseUnlaunchedClaim` can subtract the refused claim's own step even if
   * another plan in the same scope ran concurrently afterwards.
   */
  weightedDeltaByAgent?: Record<string, Record<string, number>>;
}

export interface PlannedSubagentCandidates {
  candidateIds: string[];
  claimedPrimaryAgentId: string | null;
  dispatchCount: number | null;
}

class SubagentLoadBalancer {
  private readonly knownScopeExpiresAt = new Map<string, number>();

  /**
   * Plans the ordered candidate subagent list for a delegation request.
   * Atomically advances the caller's per-scope (`user` / `team` / `org`)
   * distributed state in PostgreSQL `keyv_cache`:
   * - `round_robin` and `weighted` seed each new scope's starting phase from an
   *   atomic per-(caller, algorithm) counter so first runs across principals
   *   spread across workers in round-robin / weight order without lockstep
   *   collisions.
   * - `random` selects the primary in SQL via `hashtext(caller:scope:dispatchCount)`
   *   and orders the fallback tail with `createSeededSubagentRandom`.
   */
  async planCandidates(params: {
    callerAgentId: string;
    assignedAgentIds: readonly string[];
    excludedAgentIds?: ReadonlySet<string>;
    config: SubagentLoadBalancingConfig | null;
    scopeKey?: SubagentLoadBalancerScopeInput | string | null;
  }): Promise<PlannedSubagentCandidates> {
    const assignedList = deduplicateAgentIds(params.assignedAgentIds);
    const availableIds = assignedList.filter(
      (id) => !params.excludedAgentIds?.has(id),
    );
    if (availableIds.length === 0) {
      return {
        candidateIds: [],
        claimedPrimaryAgentId: null,
        dispatchCount: null,
      };
    }

    const normalizedConfig = normalizeSubagentLoadBalancingConfig(
      params.config,
    );
    if (!normalizedConfig || !normalizedConfig.enabled) {
      return {
        candidateIds: availableIds,
        claimedPrimaryAgentId: null,
        dispatchCount: null,
      };
    }

    const effectiveScopeKey = resolveSubagentLoadBalancerScopeKey(
      params.scopeKey,
    );
    const keyvKey = stateKeyvKey(params.callerAgentId, effectiveScopeKey);
    const now = Date.now();
    const expires = now + SUBAGENT_LOAD_BALANCER_STATE_TTL_MS;

    const weightsMap: Record<string, number> = {};
    for (const id of assignedList) {
      weightsMap[id] = normalizeSubagentWeight(normalizedConfig.weights?.[id]);
    }

    const assignedJson = JSON.stringify(assignedList);
    const availableJson = JSON.stringify(availableIds);
    const weightsJson = JSON.stringify(weightsMap);
    const randomSeedPrefix = `${params.callerAgentId}:${effectiveScopeKey}:`;

    try {
      await ensureKeyvCacheTable();

      const knownExpiry = this.knownScopeExpiresAt.get(keyvKey) ?? 0;
      const scopeOffset =
        knownExpiry <= now &&
        effectiveScopeKey !== DEFAULT_SUBAGENT_LOAD_BALANCER_SCOPE_KEY &&
        normalizedConfig.algorithm !== "random"
          ? await claimInitialScopeOffset({
              callerAgentId: params.callerAgentId,
              algorithm: normalizedConfig.algorithm,
              keyvKey,
              now,
              expires,
            })
          : 0;

      const seededAssignedList = rotateArray(assignedList, scopeOffset);
      const seededAvailableIds = seededAssignedList.filter(
        (id) => !params.excludedAgentIds?.has(id),
      );

      let initialPrimaryId = seededAvailableIds[0] ?? availableIds[0] ?? null;
      let initialQueue = initialPrimaryId
        ? moveAgentToBack(seededAssignedList, initialPrimaryId)
        : seededAssignedList;
      let initialWeightedCurrent: Record<string, number> | undefined;
      let initialWeightedDeltaByAgent:
        | Record<string, Record<string, number>>
        | undefined;

      if (normalizedConfig.algorithm === "weighted") {
        const totalWeight = assignedList.reduce(
          (sum, id) => sum + (weightsMap[id] ?? 1),
          0,
        );
        const warmupSteps = totalWeight > 0 ? scopeOffset % totalWeight : 0;
        let startingCurrentWeights: Record<string, number> = {};
        let startingTieBreakOrder = [...assignedList];
        for (let s = 0; s < warmupSteps; s++) {
          const warmup = stepSmoothWeightedRoundRobin({
            availableIds: assignedList,
            weights: weightsMap,
            currentWeights: startingCurrentWeights,
            tieBreakOrder: startingTieBreakOrder,
          });
          startingCurrentWeights = warmup.nextCurrentWeights;
          if (warmup.chosenId) {
            startingTieBreakOrder = moveAgentToBack(
              startingTieBreakOrder,
              warmup.chosenId,
            );
          }
        }
        const initialStep = stepSmoothWeightedRoundRobin({
          availableIds,
          weights: weightsMap,
          currentWeights: startingCurrentWeights,
          tieBreakOrder: startingTieBreakOrder,
        });
        initialPrimaryId = initialStep.chosenId ?? initialPrimaryId;
        initialWeightedCurrent = initialStep.nextCurrentWeights;
        const initialDelta: Record<string, number> = {};
        for (const id of assignedList) {
          initialDelta[id] =
            (initialWeightedCurrent[id] ?? 0) -
            (startingCurrentWeights[id] ?? 0);
        }
        initialWeightedDeltaByAgent = initialPrimaryId
          ? { [initialPrimaryId]: initialDelta }
          : {};
        initialQueue = initialPrimaryId
          ? moveAgentToBack(startingTieBreakOrder, initialPrimaryId)
          : startingTieBreakOrder;
      }

      const initialEnvelope = JSON.stringify({
        value: {
          queue: initialQueue,
          dispatchCount: 1,
          ...(initialWeightedCurrent
            ? {
                weightedCurrent: initialWeightedCurrent,
                weightedDeltaByAgent: initialWeightedDeltaByAgent ?? {},
              }
            : {}),
        } satisfies SubagentLoadBalancerState,
        expires,
      });

      const result =
        normalizedConfig.algorithm === "weighted"
          ? await db.execute<{ value: string }>(sql`
              INSERT INTO keyv_cache (key, value)
              VALUES (${keyvKey}, ${initialEnvelope})
              ON CONFLICT (key) DO UPDATE SET value = CASE
                WHEN (
                  jsonb_typeof(keyv_cache.value::jsonb -> 'expires') IS DISTINCT FROM 'number'
                  OR (keyv_cache.value::jsonb ->> 'expires')::numeric > ${now}
                )
                AND jsonb_typeof(keyv_cache.value::jsonb #> '{value,queue}') = 'array'
                THEN (
                  WITH existing_queue AS (
                    SELECT elem, ord
                    FROM jsonb_array_elements_text(keyv_cache.value::jsonb #> '{value,queue}')
                      WITH ORDINALITY AS e(elem, ord)
                  ),
                  reconciled AS (
                    SELECT elem, row_number() OVER (ORDER BY grp, ord) AS r_ord
                    FROM (
                      SELECT elem, 1 AS grp, ord
                      FROM existing_queue
                      WHERE ${assignedJson}::jsonb ? elem
                      UNION ALL
                      SELECT a.elem, 2 AS grp, a.ord
                      FROM jsonb_array_elements_text(${assignedJson}::jsonb)
                        WITH ORDINALITY AS a(elem, ord)
                      WHERE NOT ((keyv_cache.value::jsonb #> '{value,queue}') ? a.elem)
                    ) combined
                  ),
                  existing_cw AS (
                    SELECT COALESCE(
                      CASE
                        WHEN jsonb_typeof(keyv_cache.value::jsonb #> '{value,weightedCurrent}') = 'object'
                        THEN keyv_cache.value::jsonb #> '{value,weightedCurrent}'
                        ELSE '{}'::jsonb
                      END,
                      '{}'::jsonb
                    ) AS cw
                  ),
                  existing_deltas AS (
                    SELECT COALESCE(
                      CASE
                        WHEN jsonb_typeof(keyv_cache.value::jsonb #> '{value,weightedDeltaByAgent}') = 'object'
                        THEN keyv_cache.value::jsonb #> '{value,weightedDeltaByAgent}'
                        ELSE '{}'::jsonb
                      END,
                      '{}'::jsonb
                    ) AS deltas
                  ),
                  avail_scored AS (
                    SELECT
                      r.elem,
                      r.r_ord,
                      (${availableJson}::jsonb ? r.elem) AS is_avail,
                      COALESCE((${weightsJson}::jsonb ->> r.elem)::bigint, 1) AS w,
                      COALESCE(((SELECT cw FROM existing_cw) ->> r.elem)::bigint, 0) AS prev_cw,
                      CASE
                        WHEN (${availableJson}::jsonb ? r.elem)
                        THEN COALESCE(((SELECT cw FROM existing_cw) ->> r.elem)::bigint, 0)
                          + COALESCE((${weightsJson}::jsonb ->> r.elem)::bigint, 1)
                        ELSE COALESCE(((SELECT cw FROM existing_cw) ->> r.elem)::bigint, 0)
                      END AS next_cw
                    FROM reconciled r
                  ),
                  total_avail_weight AS (
                    SELECT COALESCE(SUM(w), 0) AS total_w
                    FROM avail_scored
                    WHERE is_avail
                  ),
                  chosen AS (
                    SELECT elem AS primary_id
                    FROM avail_scored
                    WHERE is_avail
                    ORDER BY next_cw DESC, r_ord ASC
                    LIMIT 1
                  ),
                  updated_cw AS (
                    SELECT COALESCE(
                      jsonb_object_agg(
                        s.elem,
                        CASE
                          WHEN s.elem = (SELECT primary_id FROM chosen)
                          THEN s.next_cw - (SELECT total_w FROM total_avail_weight)
                          ELSE s.next_cw
                        END
                      ),
                      '{}'::jsonb
                    ) AS cw_map
                    FROM avail_scored s
                  ),
                  claim_delta AS (
                    SELECT COALESCE(
                      jsonb_object_agg(
                        s.elem,
                        CASE
                          WHEN s.elem = (SELECT primary_id FROM chosen)
                          THEN (s.next_cw - (SELECT total_w FROM total_avail_weight)) - s.prev_cw
                          ELSE s.next_cw - s.prev_cw
                        END
                      ),
                      '{}'::jsonb
                    ) AS delta_map
                    FROM avail_scored s
                  ),
                  rotated AS (
                    SELECT COALESCE(
                      jsonb_agg(
                        r.elem
                        ORDER BY (r.elem = (SELECT primary_id FROM chosen)), r.r_ord
                      ),
                      '[]'::jsonb
                    ) AS next_queue
                    FROM reconciled r
                  )
                  SELECT jsonb_build_object(
                    'value', jsonb_build_object(
                      'queue', (SELECT next_queue FROM rotated),
                      'dispatchCount', COALESCE((keyv_cache.value::jsonb #>> '{value,dispatchCount}')::bigint, 0) + 1,
                      'weightedCurrent', (SELECT cw_map FROM updated_cw),
                      'weightedDeltaByAgent', CASE
                        WHEN (SELECT primary_id FROM chosen) IS NOT NULL
                        THEN (SELECT deltas FROM existing_deltas) || jsonb_build_object((SELECT primary_id FROM chosen), (SELECT delta_map FROM claim_delta))
                        ELSE (SELECT deltas FROM existing_deltas)
                      END
                    ),
                    'expires', ${expires}::bigint
                  )::text
                )
                ELSE EXCLUDED.value
              END
              RETURNING value
            `)
          : normalizedConfig.algorithm === "random"
            ? await db.execute<{ value: string }>(sql`
                INSERT INTO keyv_cache (key, value)
                SELECT
                  ${keyvKey},
                  (
                    WITH avail_indexed AS (
                      SELECT
                        elem,
                        ord - 1 AS avail_idx,
                        count(*) OVER () AS avail_cnt
                      FROM jsonb_array_elements_text(${availableJson}::jsonb)
                        WITH ORDINALITY AS a(elem, ord)
                    ),
                    chosen AS (
                      SELECT elem AS primary_id
                      FROM avail_indexed
                      WHERE avail_idx = (
                        abs(
                          hashtext(${randomSeedPrefix} || '1')::bigint
                        ) % GREATEST(1, avail_cnt)
                      )
                      LIMIT 1
                    ),
                    rotated AS (
                      SELECT COALESCE(
                        jsonb_agg(
                          a.elem
                          ORDER BY (a.elem = (SELECT primary_id FROM chosen)), a.ord
                        ),
                        '[]'::jsonb
                      ) AS next_queue
                      FROM jsonb_array_elements_text(${assignedJson}::jsonb)
                        WITH ORDINALITY AS a(elem, ord)
                    )
                    SELECT jsonb_build_object(
                      'value', jsonb_build_object(
                        'queue', (SELECT next_queue FROM rotated),
                        'dispatchCount', 1
                      ),
                      'expires', ${expires}::bigint
                    )::text
                  )
                ON CONFLICT (key) DO UPDATE SET value = CASE
                  WHEN (
                    jsonb_typeof(keyv_cache.value::jsonb -> 'expires') IS DISTINCT FROM 'number'
                    OR (keyv_cache.value::jsonb ->> 'expires')::numeric > ${now}
                  )
                  AND jsonb_typeof(keyv_cache.value::jsonb #> '{value,queue}') = 'array'
                  THEN (
                    WITH existing_queue AS (
                      SELECT elem, ord
                      FROM jsonb_array_elements_text(keyv_cache.value::jsonb #> '{value,queue}')
                        WITH ORDINALITY AS e(elem, ord)
                    ),
                    reconciled AS (
                      SELECT elem, row_number() OVER (ORDER BY grp, ord) AS r_ord
                      FROM (
                        SELECT elem, 1 AS grp, ord
                        FROM existing_queue
                        WHERE ${assignedJson}::jsonb ? elem
                        UNION ALL
                        SELECT a.elem, 2 AS grp, a.ord
                        FROM jsonb_array_elements_text(${assignedJson}::jsonb)
                          WITH ORDINALITY AS a(elem, ord)
                        WHERE NOT ((keyv_cache.value::jsonb #> '{value,queue}') ? a.elem)
                      ) combined
                    ),
                    avail_indexed AS (
                      SELECT
                        elem,
                        row_number() OVER (ORDER BY r_ord) - 1 AS avail_idx,
                        count(*) OVER () AS avail_cnt
                      FROM reconciled
                      WHERE ${availableJson}::jsonb ? elem
                    ),
                    chosen AS (
                      SELECT elem AS primary_id
                      FROM avail_indexed
                      WHERE avail_idx = (
                        abs(
                          hashtext(
                            ${randomSeedPrefix} || (
                              COALESCE((keyv_cache.value::jsonb #>> '{value,dispatchCount}')::bigint, 0) + 1
                            )::text
                          )::bigint
                        ) % GREATEST(1, avail_cnt)
                      )
                      LIMIT 1
                    ),
                    rotated AS (
                      SELECT COALESCE(
                        jsonb_agg(
                          r.elem
                          ORDER BY (r.elem = (SELECT primary_id FROM chosen)), r.r_ord
                        ),
                        '[]'::jsonb
                      ) AS next_queue
                      FROM reconciled r
                    )
                    SELECT jsonb_build_object(
                      'value', jsonb_build_object(
                        'queue', (SELECT next_queue FROM rotated),
                        'dispatchCount', COALESCE((keyv_cache.value::jsonb #>> '{value,dispatchCount}')::bigint, 0) + 1
                      ),
                      'expires', ${expires}::bigint
                    )::text
                  )
                  ELSE EXCLUDED.value
                END
                RETURNING value
              `)
            : await db.execute<{ value: string }>(sql`
                INSERT INTO keyv_cache (key, value)
                VALUES (${keyvKey}, ${initialEnvelope})
                ON CONFLICT (key) DO UPDATE SET value = CASE
                  WHEN (
                    jsonb_typeof(keyv_cache.value::jsonb -> 'expires') IS DISTINCT FROM 'number'
                    OR (keyv_cache.value::jsonb ->> 'expires')::numeric > ${now}
                  )
                  AND jsonb_typeof(keyv_cache.value::jsonb #> '{value,queue}') = 'array'
                  THEN (
                    WITH existing_queue AS (
                      SELECT elem, ord
                      FROM jsonb_array_elements_text(keyv_cache.value::jsonb #> '{value,queue}')
                        WITH ORDINALITY AS e(elem, ord)
                    ),
                    reconciled AS (
                      SELECT elem, row_number() OVER (ORDER BY grp, ord) AS r_ord
                      FROM (
                        SELECT elem, 1 AS grp, ord
                        FROM existing_queue
                        WHERE ${assignedJson}::jsonb ? elem
                        UNION ALL
                        SELECT a.elem, 2 AS grp, a.ord
                        FROM jsonb_array_elements_text(${assignedJson}::jsonb)
                          WITH ORDINALITY AS a(elem, ord)
                        WHERE NOT ((keyv_cache.value::jsonb #> '{value,queue}') ? a.elem)
                      ) combined
                    ),
                    chosen AS (
                      SELECT elem AS primary_id
                      FROM reconciled
                      WHERE ${availableJson}::jsonb ? elem
                      ORDER BY r_ord
                      LIMIT 1
                    ),
                    rotated AS (
                      SELECT COALESCE(
                        jsonb_agg(
                          r.elem
                          ORDER BY (r.elem = (SELECT primary_id FROM chosen)), r.r_ord
                        ),
                        '[]'::jsonb
                      ) AS next_queue
                      FROM reconciled r
                    )
                    SELECT jsonb_build_object(
                      'value', jsonb_build_object(
                        'queue', (SELECT next_queue FROM rotated),
                        'dispatchCount', COALESCE((keyv_cache.value::jsonb #>> '{value,dispatchCount}')::bigint, 0) + 1
                      ),
                      'expires', ${expires}::bigint
                    )::text
                  )
                  ELSE EXCLUDED.value
                END
                RETURNING value
              `);

      const state = parseKeyvState(result.rows[0]?.value, now);
      this.knownScopeExpiresAt.set(keyvKey, expires);
      const nextQueue = state?.queue ?? initialQueue;
      const dispatchCount = state?.dispatchCount ?? 1;
      const availableSet = new Set(availableIds);
      const availableInNextQueue = nextQueue.filter((id) =>
        availableSet.has(id),
      );
      const claimedPrimary =
        availableInNextQueue[availableInNextQueue.length - 1] ??
        initialPrimaryId;
      const rawTail = claimedPrimary
        ? availableInNextQueue.filter((id) => id !== claimedPrimary)
        : availableInNextQueue;

      let candidateIds: string[];
      if (normalizedConfig.algorithm === "weighted") {
        const fallbackStep = stepSmoothWeightedRoundRobin({
          availableIds: rawTail,
          weights: weightsMap,
          currentWeights: state?.weightedCurrent ?? initialWeightedCurrent,
          tieBreakOrder: nextQueue,
        });
        candidateIds = claimedPrimary
          ? [claimedPrimary, ...fallbackStep.orderedIds]
          : availableIds;
      } else if (normalizedConfig.algorithm === "random") {
        const prng = createSeededSubagentRandom(
          `${params.callerAgentId}:${effectiveScopeKey}:${dispatchCount}`,
        );
        const shuffledTail = [...rawTail];
        for (let i = shuffledTail.length - 1; i > 0; i--) {
          const j = Math.floor(prng() * (i + 1));
          [shuffledTail[i], shuffledTail[j]] = [
            shuffledTail[j] ?? "",
            shuffledTail[i] ?? "",
          ];
        }
        candidateIds = claimedPrimary
          ? [claimedPrimary, ...shuffledTail]
          : availableIds;
      } else {
        const poolSize = Math.max(1, assignedList.length);
        const round = Math.floor(Math.max(0, dispatchCount - 1) / poolSize);
        const rotatedTail =
          rawTail.length > 1
            ? [
                ...rawTail.slice(round % rawTail.length),
                ...rawTail.slice(0, round % rawTail.length),
              ]
            : rawTail;
        candidateIds = claimedPrimary
          ? [claimedPrimary, ...rotatedTail]
          : availableIds;
      }

      return {
        candidateIds,
        claimedPrimaryAgentId: claimedPrimary,
        dispatchCount,
      };
    } catch (error) {
      logger.warn(
        {
          error,
          callerAgentId: params.callerAgentId,
          scopeKey: effectiveScopeKey,
        },
        "SubagentLoadBalancer: Failed to plan candidates in keyv_cache, falling back to local ordering",
      );
      const fallbackOrdered = orderSubagentsByLoadBalancing(
        availableIds,
        normalizedConfig,
        {
          scopeKey: `${params.callerAgentId}:${effectiveScopeKey}`,
          random: Math.random,
        },
      );
      return {
        candidateIds: fallbackOrdered,
        claimedPrimaryAgentId: fallbackOrdered[0] ?? null,
        dispatchCount: null,
      };
    }
  }

  /**
   * Atomically selects and rotates the next fallback candidate in a single
   * `INSERT ... ON CONFLICT DO UPDATE RETURNING` statement.
   *
   * When `failedAgentId` is provided, places `failedAgentId` at the very back
   * of the queue AFTER `claimedAgentId` so the failed candidate is demoted
   * behind all healthy candidates instead of advancing ahead of the rescuing
   * fallback worker.
   */
  async claimNextFallbackCandidate(params: {
    callerAgentId?: string;
    remainingCandidateIds: readonly string[];
    assignedAgentIds?: readonly string[];
    plannedDispatchCount?: number | null;
    scopeKey?: SubagentLoadBalancerScopeInput | string | null;
    failedAgentId?: string | null;
  }): Promise<{
    claimedAgentId: string | null;
    remainingCandidateIds: string[];
    dispatchCount: number | null;
  }> {
    const remaining = deduplicateAgentIds(params.remainingCandidateIds);
    if (remaining.length === 0) {
      return {
        claimedAgentId: null,
        remainingCandidateIds: [],
        dispatchCount: params.plannedDispatchCount ?? null,
      };
    }
    if (!params.callerAgentId) {
      return {
        claimedAgentId: remaining[0] ?? null,
        remainingCandidateIds: remaining.slice(1),
        dispatchCount: params.plannedDispatchCount ?? null,
      };
    }

    const effectiveScopeKey = resolveSubagentLoadBalancerScopeKey(
      params.scopeKey,
    );
    const preferredId = remaining[0];
    const failedId = params.failedAgentId?.trim() || null;
    const assignedList = deduplicateAgentIds(
      params.assignedAgentIds && params.assignedAgentIds.length > 0
        ? params.assignedAgentIds
        : remaining,
    );
    const baseAssigned = assignedList.includes(preferredId)
      ? assignedList
      : [...assignedList, ...remaining];
    const initialQueue =
      failedId && failedId !== preferredId && baseAssigned.includes(failedId)
        ? moveAgentToBack(moveAgentToBack(baseAssigned, preferredId), failedId)
        : moveAgentToBack(baseAssigned, preferredId);
    const keyvKey = stateKeyvKey(params.callerAgentId, effectiveScopeKey);
    const now = Date.now();
    const expires = now + SUBAGENT_LOAD_BALANCER_STATE_TTL_MS;
    const initialEnvelope = JSON.stringify({
      value: {
        queue: initialQueue,
        dispatchCount: 1,
      } satisfies SubagentLoadBalancerState,
      expires,
    });
    const assignedJson = JSON.stringify(baseAssigned);
    const remainingJson = JSON.stringify(remaining);
    const hasAssignedList = Boolean(
      params.assignedAgentIds && params.assignedAgentIds.length > 0,
    );
    const expectedDispatchCount =
      typeof params.plannedDispatchCount === "number"
        ? params.plannedDispatchCount
        : -1;

    try {
      await ensureKeyvCacheTable();
      const result = await db.execute<{ value: string }>(sql`
        INSERT INTO keyv_cache (key, value)
        VALUES (${keyvKey}, ${initialEnvelope})
        ON CONFLICT (key) DO UPDATE SET value = CASE
          WHEN (
            jsonb_typeof(keyv_cache.value::jsonb -> 'expires') IS DISTINCT FROM 'number'
            OR (keyv_cache.value::jsonb ->> 'expires')::numeric > ${now}
          )
          AND jsonb_typeof(keyv_cache.value::jsonb #> '{value,queue}') = 'array'
          THEN (
            WITH existing_queue AS (
              SELECT elem, ord
              FROM jsonb_array_elements_text(keyv_cache.value::jsonb #> '{value,queue}')
                WITH ORDINALITY AS e(elem, ord)
            ),
            reconciled AS (
              SELECT elem, row_number() OVER (ORDER BY grp, ord) AS r_ord
              FROM (
                SELECT elem, 1 AS grp, ord
                FROM existing_queue
                WHERE NOT ${hasAssignedList} OR (${assignedJson}::jsonb ? elem)
                UNION ALL
                SELECT a.elem, 2 AS grp, a.ord
                FROM jsonb_array_elements_text(${assignedJson}::jsonb)
                  WITH ORDINALITY AS a(elem, ord)
                WHERE NOT ((keyv_cache.value::jsonb #> '{value,queue}') ? a.elem)
              ) combined
            ),
            chosen AS (
              SELECT CASE
                WHEN COALESCE((keyv_cache.value::jsonb #>> '{value,dispatchCount}')::bigint, 0) = ${expectedDispatchCount}::bigint
                  AND EXISTS (SELECT 1 FROM reconciled WHERE elem = ${preferredId})
                THEN ${preferredId}::text
                ELSE (
                  SELECT elem
                  FROM reconciled
                  WHERE ${remainingJson}::jsonb ? elem
                  ORDER BY r_ord
                  LIMIT 1
                )
              END AS primary_id
            ),
            rotated AS (
              SELECT COALESCE(
                jsonb_agg(
                  r.elem
                  ORDER BY
                    CASE
                      WHEN ${failedId}::text IS NOT NULL
                        AND r.elem = ${failedId}::text
                        AND r.elem <> (SELECT primary_id FROM chosen)
                      THEN 2
                      WHEN r.elem = (SELECT primary_id FROM chosen)
                      THEN 1
                      ELSE 0
                    END,
                    r.r_ord
                ),
                '[]'::jsonb
              ) AS next_queue
              FROM reconciled r
            )
            SELECT jsonb_build_object(
              'value', jsonb_build_object(
                'queue', (SELECT next_queue FROM rotated),
                'dispatchCount', COALESCE((keyv_cache.value::jsonb #>> '{value,dispatchCount}')::bigint, 0) + 1,
                'weightedCurrent', COALESCE(
                  CASE
                    WHEN jsonb_typeof(keyv_cache.value::jsonb #> '{value,weightedCurrent}') = 'object'
                    THEN keyv_cache.value::jsonb #> '{value,weightedCurrent}'
                    ELSE '{}'::jsonb
                  END,
                  '{}'::jsonb
                ),
                'weightedDeltaByAgent', COALESCE(
                  CASE
                    WHEN jsonb_typeof(keyv_cache.value::jsonb #> '{value,weightedDeltaByAgent}') = 'object'
                    THEN keyv_cache.value::jsonb #> '{value,weightedDeltaByAgent}'
                    ELSE '{}'::jsonb
                  END,
                  '{}'::jsonb
                )
              ),
              'expires', ${expires}::bigint
            )::text
          )
          ELSE EXCLUDED.value
        END
        RETURNING value
      `);

      const state = parseKeyvState(result.rows[0]?.value, now);
      this.knownScopeExpiresAt.set(keyvKey, expires);
      const nextQueue = state?.queue ?? initialQueue;
      const nextDispatchCount = state?.dispatchCount ?? 1;
      const remainingSet = new Set(remaining);
      const remainingInNextQueue = nextQueue.filter((id) =>
        remainingSet.has(id),
      );
      const claimedAgentId =
        remainingInNextQueue[remainingInNextQueue.length - 1] ?? preferredId;
      const noInterveningClaims =
        expectedDispatchCount >= 0 &&
        nextDispatchCount === expectedDispatchCount + 1;
      const nextRemaining = noInterveningClaims
        ? remaining.filter((id) => id !== claimedAgentId)
        : remainingInNextQueue.filter((id) => id !== claimedAgentId);

      return {
        claimedAgentId,
        remainingCandidateIds: nextRemaining,
        dispatchCount: nextDispatchCount,
      };
    } catch (error) {
      logger.warn(
        {
          error,
          callerAgentId: params.callerAgentId,
          scopeKey: effectiveScopeKey,
        },
        "SubagentLoadBalancer: Failed to claim fallback candidate in keyv_cache, falling back to local order",
      );
      return {
        claimedAgentId: preferredId,
        remainingCandidateIds: remaining.slice(1),
        dispatchCount: params.plannedDispatchCount ?? null,
      };
    }
  }

  /**
   * Records that a specific subagent took a run, atomically rotating that
   * subagent to the back of the distributed queue in PostgreSQL `keyv_cache`.
   */
  async recordCandidateClaimed(params: {
    callerAgentId: string;
    claimedAgentId: string;
    assignedAgentIds?: readonly string[];
    scopeKey?: SubagentLoadBalancerScopeInput | string | null;
  }): Promise<void> {
    await this.claimNextFallbackCandidate({
      callerAgentId: params.callerAgentId,
      remainingCandidateIds: [params.claimedAgentId],
      assignedAgentIds: params.assignedAgentIds,
      plannedDispatchCount: -1,
      scopeKey: params.scopeKey,
    });
  }

  /**
   * Releases a primary claim when a caller-error refusal (`reason === "refused"`,
   * e.g., invalid tier request) prevented the run from launching. Candidate-specific
   * failures (`credentials_misconfigured`, `agent_not_found`, etc.) must NOT
   * call this method so unhealthy workers rotate to the back of the queue
   * instead of pinning subsequent calls.
   */
  async releaseUnlaunchedClaim(params: {
    callerAgentId: string;
    claimedAgentId: string | null;
    scopeKey?: SubagentLoadBalancerScopeInput | string | null;
  }): Promise<void> {
    const claimedAgentId = params.claimedAgentId?.trim();
    if (!claimedAgentId) return;

    const effectiveScopeKey = resolveSubagentLoadBalancerScopeKey(
      params.scopeKey,
    );
    const keyvKey = stateKeyvKey(params.callerAgentId, effectiveScopeKey);
    const now = Date.now();
    const expires = now + SUBAGENT_LOAD_BALANCER_STATE_TTL_MS;

    try {
      await ensureKeyvCacheTable();
      await db.execute(sql`
        UPDATE keyv_cache
        SET value = (
          WITH existing_queue AS (
            SELECT elem, ord
            FROM jsonb_array_elements_text(keyv_cache.value::jsonb #> '{value,queue}')
              WITH ORDINALITY AS e(elem, ord)
          ),
          restored AS (
            SELECT COALESCE(
              jsonb_agg(
                e.elem
                ORDER BY (e.elem <> ${claimedAgentId}), e.ord
              ),
              '[]'::jsonb
            ) AS next_queue
            FROM existing_queue e
          ),
          existing_cw AS (
            SELECT COALESCE(
              CASE
                WHEN jsonb_typeof(keyv_cache.value::jsonb #> '{value,weightedCurrent}') = 'object'
                THEN keyv_cache.value::jsonb #> '{value,weightedCurrent}'
                ELSE '{}'::jsonb
              END,
              '{}'::jsonb
            ) AS cw
          ),
          existing_deltas AS (
            SELECT COALESCE(
              CASE
                WHEN jsonb_typeof(keyv_cache.value::jsonb #> '{value,weightedDeltaByAgent}') = 'object'
                THEN keyv_cache.value::jsonb #> '{value,weightedDeltaByAgent}'
                ELSE '{}'::jsonb
              END,
              '{}'::jsonb
            ) AS deltas
          ),
          agent_delta AS (
            SELECT COALESCE(
              CASE
                WHEN jsonb_typeof((SELECT deltas FROM existing_deltas) -> ${claimedAgentId}::text) = 'object'
                THEN (SELECT deltas FROM existing_deltas) -> ${claimedAgentId}::text
                ELSE '{}'::jsonb
              END,
              '{}'::jsonb
            ) AS delta
          ),
          restored_cw AS (
            SELECT COALESCE(
              jsonb_object_agg(
                e.key,
                (e.value #>> '{}')::bigint - COALESCE(((SELECT delta FROM agent_delta) ->> e.key)::bigint, 0)
              ),
              '{}'::jsonb
            ) AS cw_map
            FROM jsonb_each((SELECT cw FROM existing_cw)) AS e(key, value)
          )
          SELECT jsonb_build_object(
            'value', jsonb_build_object(
              'queue', (SELECT next_queue FROM restored),
              'dispatchCount', GREATEST(0, COALESCE((keyv_cache.value::jsonb #>> '{value,dispatchCount}')::bigint, 1) - 1),
              'weightedCurrent', (SELECT cw_map FROM restored_cw),
              'weightedDeltaByAgent', (SELECT deltas FROM existing_deltas) - ${claimedAgentId}::text
            ),
            'expires', ${expires}::bigint
          )::text
        )
        WHERE key = ${keyvKey}
          AND (
            jsonb_typeof(keyv_cache.value::jsonb -> 'expires') IS DISTINCT FROM 'number'
            OR (keyv_cache.value::jsonb ->> 'expires')::numeric > ${now}
          )
          AND jsonb_typeof(keyv_cache.value::jsonb #> '{value,queue}') = 'array'
      `);
    } catch (error) {
      logger.warn(
        {
          error,
          callerAgentId: params.callerAgentId,
          claimedAgentId,
          scopeKey: effectiveScopeKey,
        },
        "SubagentLoadBalancer: Failed to release unlaunched claim in keyv_cache",
      );
    }
  }

  async getState(
    callerAgentId: string,
    scopeKey?: SubagentLoadBalancerScopeInput | string | null,
  ): Promise<SubagentLoadBalancerState | undefined> {
    const now = Date.now();
    await ensureKeyvCacheTable();
    const keyvKey = stateKeyvKey(
      callerAgentId,
      resolveSubagentLoadBalancerScopeKey(scopeKey),
    );
    const result = await db.execute<{ value: string }>(sql`
      SELECT value FROM keyv_cache WHERE key = ${keyvKey}
    `);
    return parseKeyvState(result.rows[0]?.value, now);
  }
}

export const subagentLoadBalancer = new SubagentLoadBalancer();

// ===== Internal helpers =====

let keyvTableEnsured = false;

async function ensureKeyvCacheTable(): Promise<void> {
  if (keyvTableEnsured) return;
  await db.execute(sql`
    CREATE UNLOGGED TABLE IF NOT EXISTS keyv_cache (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  keyvTableEnsured = true;
}

async function claimInitialScopeOffset(params: {
  callerAgentId: string;
  algorithm: string;
  keyvKey: string;
  now: number;
  expires: number;
}): Promise<number> {
  const seedKeyvKey = `keyv:${CacheKey.SubagentLoadBalancer}-${params.callerAgentId}:seed:${params.algorithm}`;
  const result = await db.execute<{ scope_offset: number | string }>(sql`
    WITH target_exists AS (
      SELECT 1 AS ok
      FROM keyv_cache
      WHERE key = ${params.keyvKey}
        AND (
          jsonb_typeof(value::jsonb -> 'expires') IS DISTINCT FROM 'number'
          OR (value::jsonb ->> 'expires')::numeric > ${params.now}
        )
        AND jsonb_typeof(value::jsonb #> '{value,queue}') = 'array'
    ),
    bumped_seed AS (
      INSERT INTO keyv_cache (key, value)
      SELECT
        ${seedKeyvKey},
        jsonb_build_object(
          'value',
          jsonb_build_object('count', 1),
          'expires',
          ${params.expires}::bigint
        )::text
      WHERE NOT EXISTS (SELECT 1 FROM target_exists)
      ON CONFLICT (key) DO UPDATE SET value = CASE
        WHEN (
          jsonb_typeof(keyv_cache.value::jsonb -> 'expires') IS DISTINCT FROM 'number'
          OR (keyv_cache.value::jsonb ->> 'expires')::numeric > ${params.now}
        )
        THEN jsonb_build_object(
          'value',
          jsonb_build_object(
            'count',
            COALESCE((keyv_cache.value::jsonb #>> '{value,count}')::bigint, 0) + 1
          ),
          'expires',
          ${params.expires}::bigint
        )::text
        ELSE EXCLUDED.value
      END
      RETURNING COALESCE((value::jsonb #>> '{value,count}')::bigint, 1) - 1 AS scope_offset
    )
    SELECT scope_offset FROM bumped_seed
  `);
  const raw = result.rows[0]?.scope_offset;
  const parsed = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function rotateArray<T>(items: readonly T[], offset: number): T[] {
  const n = items.length;
  if (n <= 1) return [...items];
  const shift = ((Math.trunc(offset) % n) + n) % n;
  if (shift === 0) return [...items];
  return [...items.slice(shift), ...items.slice(0, shift)];
}

function stateCacheKey(
  callerAgentId: string,
  scopeKey: string,
): AllowedCacheKey {
  if (!scopeKey || scopeKey === DEFAULT_SUBAGENT_LOAD_BALANCER_SCOPE_KEY) {
    return `${CacheKey.SubagentLoadBalancer}-${callerAgentId}`;
  }
  return `${CacheKey.SubagentLoadBalancer}-${callerAgentId}:${scopeKey}`;
}

function stateKeyvKey(callerAgentId: string, scopeKey: string): string {
  return `keyv:${stateCacheKey(callerAgentId, scopeKey)}`;
}

function parseKeyvState(
  rawValue: string | undefined,
  now: number,
): SubagentLoadBalancerState | undefined {
  if (!rawValue) return undefined;
  try {
    const parsed = JSON.parse(rawValue) as {
      value?: SubagentLoadBalancerState;
      expires?: number;
    };
    if (typeof parsed.expires === "number" && now >= parsed.expires) {
      return undefined;
    }
    if (
      !parsed.value ||
      !Array.isArray(parsed.value.queue) ||
      typeof parsed.value.dispatchCount !== "number"
    ) {
      return undefined;
    }
    return parsed.value;
  } catch {
    return undefined;
  }
}

function deduplicateAgentIds(agentIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawId of agentIds) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function moveAgentToBack(queue: readonly string[], agentId: string): string[] {
  return [...queue.filter((id) => id !== agentId), agentId];
}
