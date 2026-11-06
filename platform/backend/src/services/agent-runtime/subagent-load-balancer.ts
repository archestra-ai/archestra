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
}

export interface PlannedSubagentCandidates {
  candidateIds: string[];
  claimedPrimaryAgentId: string | null;
  dispatchCount: number | null;
}

class SubagentLoadBalancer {
  /**
   * Plans the ordered candidate subagent list for a delegation request.
   * Atomically advances the caller's per-scope (`user` / `team` / `org`)
   * distributed state in PostgreSQL `keyv_cache` for `round_robin`, `weighted`,
   * and `random`.
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

    let initialPrimaryId = availableIds[0] ?? null;
    let initialWeightedCurrent: Record<string, number> | undefined;
    if (normalizedConfig.algorithm === "weighted") {
      const initialStep = stepSmoothWeightedRoundRobin({
        availableIds,
        weights: weightsMap,
        currentWeights: {},
        tieBreakOrder: assignedList,
      });
      initialPrimaryId = initialStep.chosenId ?? initialPrimaryId;
      initialWeightedCurrent = initialStep.nextCurrentWeights;
    } else if (normalizedConfig.algorithm === "random") {
      const initialRandom = createSeededSubagentRandom(
        `${params.callerAgentId}:${effectiveScopeKey}:1`,
      );
      const initialIndex = Math.floor(initialRandom() * availableIds.length);
      initialPrimaryId = availableIds[initialIndex] ?? initialPrimaryId;
    }

    const initialQueue = initialPrimaryId
      ? moveAgentToBack(assignedList, initialPrimaryId)
      : assignedList;
    const initialEnvelope = JSON.stringify({
      value: {
        queue: initialQueue,
        dispatchCount: 1,
        ...(initialWeightedCurrent
          ? { weightedCurrent: initialWeightedCurrent }
          : {}),
      } satisfies SubagentLoadBalancerState,
      expires,
    });
    const assignedJson = JSON.stringify(assignedList);
    const availableJson = JSON.stringify(availableIds);
    const weightsJson = JSON.stringify(weightsMap);
    const randomSeedPrefix = `${params.callerAgentId}:${effectiveScopeKey}:`;

    try {
      await ensureKeyvCacheTable();

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
                      'weightedCurrent', (SELECT cw_map FROM updated_cw)
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
          )
          SELECT jsonb_build_object(
            'value', jsonb_build_object(
              'queue', (SELECT next_queue FROM restored),
              'dispatchCount', GREATEST(0, COALESCE((keyv_cache.value::jsonb #>> '{value,dispatchCount}')::bigint, 1) - 1),
              'weightedCurrent', COALESCE(
                CASE
                  WHEN jsonb_typeof(keyv_cache.value::jsonb #> '{value,weightedCurrent}') = 'object'
                  THEN keyv_cache.value::jsonb #> '{value,weightedCurrent}'
                  ELSE '{}'::jsonb
                END,
                '{}'::jsonb
              )
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
