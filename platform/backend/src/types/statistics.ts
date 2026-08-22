import { z } from "zod";

export const StatisticsTimeSeriesPointSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
});

export const TeamStatisticsSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  members: z.number(),
  agents: z.number(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

export const AgentStatisticsSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  agentType: z.string(),
  teamName: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cost: z.number(),
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

export const ModelStatisticsSchema = z.object({
  model: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cost: z.number(),
  percentage: z.number(),
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

/**
 * One model's slice of a single user's usage. Present only when the caller asks
 * for the per-model cut (`includeModels`), since it costs an extra aggregation.
 */
export const UserModelUsageSchema = z.object({
  model: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  billedCost: z.number(),
  subscriptionCost: z.number(),
});

/**
 * Per-user usage, for adoption reporting ("who is using AI, how much, on which
 * models") rather than spend reporting.
 *
 * Tokens and requests are the primary metrics on purpose. Cost alone is
 * misleading here: subscription-fulfilled traffic (e.g. a coding agent on a
 * flat-rate plan) incurs no per-token charge, so a cost-keyed view reports 0
 * for exactly the heaviest users. `billedCost` and `subscriptionCost` are kept
 * separate so neither is mistaken for the other.
 */
export const UserStatisticsSchema = z.object({
  userId: z.string(),
  userName: z.string(),
  /** Included so callers can join to an external roster without a second request. */
  userEmail: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
  /** Billed spend: list-price `cost` of metered rows only. */
  billedCost: z.number(),
  /** Would-be list-price cost of subscription-covered rows — not billed. */
  subscriptionCost: z.number(),
  /** Distinct UTC days with at least one request in the timeframe. */
  activeDays: z.number(),
  lastActiveAt: z.string().nullable(),
  /** Present only when `includeModels` is set. */
  models: z.array(UserModelUsageSchema).optional(),
  /** Present only when `includeTimeSeries` is set. */
  timeSeries: z.array(StatisticsTimeSeriesPointSchema).optional(),
});

/**
 * The caller's own cost and usage — the personal summary that leads the Costs
 * page.
 *
 * Deliberately a separate shape from {@link UserStatisticsSchema} rather than a
 * one-row page of it: this is the only statistics view that carries no
 * permission over other people's data, so it names no other user, exposes no
 * organization totals, and cannot be widened by a query parameter.
 *
 * Cost is split the same way as everywhere else — `billedCost` is money spent,
 * `subscriptionCost` is the list-price estimate of flat-rate-covered traffic
 * that was never billed — so a heavy subscription user is not reported as
 * costing nothing.
 */
export const MyStatisticsSchema = z.object({
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
  /** Billed spend: list-price `cost` of metered rows only. */
  billedCost: z.number(),
  /** Would-be list-price cost of subscription-covered rows — not billed. */
  subscriptionCost: z.number(),
  /** Distinct UTC days with at least one request in the timeframe. */
  activeDays: z.number(),
  lastActiveAt: z.string().nullable(),
  /** The caller's model mix, heaviest first. */
  models: z.array(UserModelUsageSchema),
  /** Billed spend over the timeframe, bucketed like the other cost charts. */
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

/**
 * Where the caller's tokens actually went, by the price band each kind is
 * charged at.
 *
 * This is the cut that explains a surprising bill, which the headline totals
 * cannot: the four kinds are charged at wildly different rates — a cache read
 * is a tenth of fresh input, a cache write is a *premium* over it — so two
 * users with identical token counts can differ several-fold in cost purely by
 * how well their context is being reused.
 *
 * `cacheSavings` is the platform's stored net figure (read savings minus write
 * surcharge) and is deliberately allowed to go negative: a session that keeps
 * re-writing a cache it never reads back costs more than not caching at all,
 * and reporting that as zero would hide the single most actionable problem a
 * heavy agentic user can have.
 */
export const MyTokenMixSchema = z.object({
  /** Uncached prompt tokens, charged at the full input rate. */
  freshInputTokens: z.number(),
  /** Tokens served from cache, charged at roughly a tenth of the input rate. */
  cacheReadTokens: z.number(),
  /** Tokens written into the cache, charged at a premium over the input rate. */
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
  /** List-price cost of the cache read+write tokens alone. */
  cacheCost: z.number(),
  /**
   * Net list-price effect of caching versus paying full input price for the
   * same tokens. Negative means caching cost more than it saved.
   */
  cacheSavings: z.number(),
});

/**
 * One context-size band and the share of usage that happened inside it.
 *
 * Context size is `input_tokens + cache_read_tokens` — what the model was
 * actually asked to read on that turn, cached or not. Long agentic sessions
 * spend most of their money at the top band without it being visible anywhere
 * in a per-request view, because no single request looks unusual; only the
 * distribution does.
 */
export const MyContextBucketSchema = z.object({
  /** Stable identifier for the band, ascending. */
  bucket: z.enum(["under32k", "under128k", "under256k", "over256k"]),
  requests: z.number(),
  tokens: z.number(),
  /** List-price cost of the requests in this band, both billing modes. */
  cost: z.number(),
});

/**
 * One of the caller's sessions, costed.
 *
 * A session is the unit people actually recognise ("that refactor I ran on
 * Tuesday"), and agentic spend concentrates in a handful of them, so naming the
 * expensive ones is the most directly actionable thing this endpoint returns.
 */
export const MySessionCostSchema = z.object({
  sessionId: z.string(),
  requests: z.number(),
  tokens: z.number(),
  /** List-price cost, both billing modes — this is a consumption view. */
  cost: z.number(),
  /** Portion of `cost` that was actually billed (metered rows only). */
  billedCost: z.number(),
  startedAt: z.string(),
  lastActiveAt: z.string(),
  /** Wall-clock minutes from first to last request in the session. */
  durationMinutes: z.number(),
  /** Heaviest model in the session, by request count. */
  model: z.string().nullable(),
  /** Client attribution (`external_agent_id`), when the caller supplied one. */
  client: z.string().nullable(),
});

/**
 * The diagnostic cuts behind {@link MyStatisticsSchema}: not "how much did I
 * spend" but "what shape of work produced it".
 *
 * Split from the headline summary into its own endpoint on purpose. These are
 * three more aggregations over `interactions` — the platform's largest table —
 * and the headline card is on a page many people load without ever scrolling to
 * the detail, so it should not pay for them.
 */
export const MyUsageBreakdownSchema = z.object({
  tokenMix: MyTokenMixSchema,
  /** Ascending by band; bands with no activity are omitted. */
  contextBuckets: z.array(MyContextBucketSchema),
  /** The caller's costliest sessions in the timeframe, heaviest first. */
  topSessions: z.array(MySessionCostSchema),
  /**
   * Total list-price cost of every request in the timeframe, including those in
   * sessions that did not make `topSessions` and those with no session id at
   * all. The denominator for "these sessions were N% of your usage" — computing
   * it from the returned rows alone would silently overstate their share.
   */
  totalCost: z.number(),
  /** Requests in the timeframe carrying no session id, so attributable to none. */
  unsessionedRequests: z.number(),
});

/**
 * Sortable columns for the per-user view. Defaults to `totalTokens` because
 * adoption is measured in usage, not spend.
 */
export const USER_STATISTICS_SORT_BY = [
  "totalTokens",
  "requests",
  "billedCost",
  "lastActiveAt",
  "userName",
] as const;

export const UserStatisticsSortBySchema = z.enum(USER_STATISTICS_SORT_BY);

/**
 * Per-MCP-App cost, split the two ways an app actually spends money.
 *
 * `build*` is the one-off spend of authoring the app: the LLM turns of the
 * session recorded on `apps.authoring_session_id`. `runtime*` is the recurring
 * spend of running it — `archestra.llm.complete()` calls the app makes, which
 * carry `interactions.app_id`. Apps are usually presented as a saving because
 * the second number is normally far smaller than a chat doing the same work
 * repeatedly, but it is emphatically not always zero, so both are reported.
 */
export const AppStatisticsSchema = z.object({
  appId: z.string(),
  appName: z.string(),
  /** Author's display name, or null when the authoring user is gone. */
  authorName: z.string().nullable(),
  createdAt: z.string(),
  /** LLM requests made while authoring the app (the build session's turns). */
  buildRequests: z.number(),
  buildInputTokens: z.number(),
  buildOutputTokens: z.number(),
  /** Billed spend of the authoring session — the app's build cost. */
  buildCost: z.number(),
  /**
   * How many apps were authored in the same session, this one included. The
   * build figures above are that whole session's spend, so anything above 1
   * means they are shared rather than exclusive to this app — the reader is told
   * instead of the number being silently divided.
   */
  buildSessionAppCount: z.number(),
  /** Whether a build session is recorded at all; false for apps created outside chat. */
  hasBuildSession: z.boolean(),
  /** `archestra.llm.complete()` calls this app's runtime made. */
  runtimeLlmRequests: z.number(),
  runtimeInputTokens: z.number(),
  runtimeOutputTokens: z.number(),
  /** Billed spend of this app's own runtime LLM calls. */
  runtimeCost: z.number(),
  /**
   * Times the app was opened, counted as the runtime's MCP `tools/list`
   * handshakes — one per host opening the app.
   */
  runs: z.number(),
  /**
   * MCP tool calls the app's runtime made (its non-LLM work). Includes tool
   * previews run while authoring the app, so an app under active development
   * reads a little high. Nothing derived from it feeds a cost figure.
   */
  toolCalls: z.number(),
  /**
   * What the same work would plausibly have cost as chat, estimated as
   * `runs × the org's measured average cost per chat session` over the same
   * timeframe. An estimate, and labelled as one: it assumes one app run replaces
   * one chat session, which is the assumption the whole "apps save money" story
   * rests on. The baseline it multiplies is returned alongside
   * (`chatBaselineCostPerSession`) so the arithmetic is auditable.
   */
  estimatedChatEquivalentCost: z.number(),
  /** `estimatedChatEquivalentCost` minus build and runtime spend. Can be negative. */
  estimatedNetSavings: z.number(),
});

export const APP_STATISTICS_SORT_BY = [
  "totalCost",
  "buildCost",
  "runtimeCost",
  "runs",
  "estimatedNetSavings",
  "appName",
] as const;

export const AppStatisticsSortBySchema = z.enum(APP_STATISTICS_SORT_BY);

/**
 * The chat baseline behind every row's `estimatedChatEquivalentCost`, returned
 * with the page so a reader can judge the counterfactual rather than trust it.
 */
export const ChatCostBaselineSchema = z.object({
  /**
   * Measured average billed cost of one chat session in this timeframe (chat
   * interactions grouped by session). Zero when the timeframe contains no chat
   * sessions, which makes every estimate zero rather than inventing a rate.
   */
  chatBaselineCostPerSession: z.number(),
  /** Chat sessions the baseline was averaged over. */
  chatBaselineSessions: z.number(),
});

/**
 * Per-skill cost. A skill's mechanism is injecting instructions into the model's
 * context, so it has two honest cost figures and they answer different questions.
 *
 * `contextTokens` is the skill's own footprint: tokens its activation blocks
 * added, measured at injection time. It belongs to the skill alone.
 *
 * `attributed*` is the spend of the turns that ran with the skill in context —
 * every interaction in an activation's session at or after the activation.
 * That spend is shared with everything else in those turns, so it is an upper
 * bound on the skill's influence, not a bill: two skills active in one session
 * are each attributed the same turns.
 */
export const SkillStatisticsSchema = z.object({
  skillId: z.string(),
  skillName: z.string(),
  /** Activations in the timeframe (slash command, `load_skill`, or agent dispatch). */
  activations: z.number(),
  /** Distinct users who activated it; unattributed activations are not counted. */
  distinctUsers: z.number(),
  /**
   * Tokens the skill's activation blocks added to the context, summed over
   * measured activations. Null-measured activations contribute nothing.
   */
  contextTokens: z.number(),
  /** Activations that recorded a measured context size, of `activations`. */
  measuredActivations: z.number(),
  /** Distinct sessions the skill was activated in and whose spend is attributed. */
  attributedSessions: z.number(),
  /** LLM requests that ran with this skill in context. */
  attributedRequests: z.number(),
  attributedInputTokens: z.number(),
  attributedOutputTokens: z.number(),
  /** Billed spend of those requests. Shared with anything else in the same turns. */
  attributedCost: z.number(),
  lastActivatedAt: z.string().nullable(),
});

/**
 * Sortable columns for the per-skill view. `attributedCost` is deliberately
 * absent: it is computed by joining each activation's session to the
 * interactions that followed it, which happens only for the page that has
 * already been selected — offering it as a sort would silently rank within a
 * page chosen by something else. Defaults to `contextTokens`, which is both
 * SQL-sortable and the figure that is genuinely the skill's own.
 */
export const SKILL_STATISTICS_SORT_BY = [
  "contextTokens",
  "activations",
  "lastActivatedAt",
  "skillName",
] as const;

export const SkillStatisticsSortBySchema = z.enum(SKILL_STATISTICS_SORT_BY);

export const OverviewStatisticsSchema = z.object({
  totalRequests: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  topTeam: z.string(),
  topAgent: z.string(),
  topModel: z.string(),
});

export const CostSavingsStatisticsSchema = z.object({
  totalBaselineCost: z.number(),
  /** Billed spend: metered `cost` only (subscription traffic excluded). */
  totalActualCost: z.number(),
  totalSavings: z.number(),
  /**
   * Would-be list-price cost of subscription-covered traffic (Claude Code on a
   * Max/Pro plan, etc.) — not billed. Reported separately from realized savings
   * so it is never conflated with money actually saved.
   */
  totalSubscriptionCost: z.number(),
  totalToonSavings: z.number(),
  totalCacheSavings: z.number(),
  timeSeries: z.array(
    z.object({
      timestamp: z.string(),
      baselineCost: z.number(),
      actualCost: z.number(),
      toonSavings: z.number(),
      cacheSavings: z.number(),
      subscriptionCost: z.number(),
    }),
  ),
});

const BaseTimeSeriesDataSchema = z.object({
  timeBucket: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(), // Stored cost from interactions (already calculated per-model)
});

export const StatisticsTeamTimeSeriesDataSchema =
  BaseTimeSeriesDataSchema.extend({
    teamId: z.string(),
    teamName: z.string(),
  });

export const StatisticsAgentTimeSeriesDataSchema =
  BaseTimeSeriesDataSchema.extend({
    agentId: z.string(),
    agentName: z.string(),
    agentType: z.string(),
    teamName: z.string().nullable(),
  });

export const StatisticsModelTimeSeriesDataSchema =
  BaseTimeSeriesDataSchema.extend({
    model: z.string().nullable(),
  });

export const StatisticsUserTimeSeriesDataSchema =
  BaseTimeSeriesDataSchema.extend({
    userId: z.string(),
  });

export const StatisticsTimeSeriesDataSchema = z.union([
  StatisticsTeamTimeSeriesDataSchema,
  StatisticsAgentTimeSeriesDataSchema,
  StatisticsModelTimeSeriesDataSchema,
  StatisticsUserTimeSeriesDataSchema,
]);

export type StatisticsTimeSeriesPoint = z.infer<
  typeof StatisticsTimeSeriesPointSchema
>;
export type TeamStatistics = z.infer<typeof TeamStatisticsSchema>;
export type AgentStatistics = z.infer<typeof AgentStatisticsSchema>;
export type ModelStatistics = z.infer<typeof ModelStatisticsSchema>;
export type UserStatistics = z.infer<typeof UserStatisticsSchema>;
export type UserModelUsage = z.infer<typeof UserModelUsageSchema>;
export type MyStatistics = z.infer<typeof MyStatisticsSchema>;
export type MyContextBucketId = z.infer<typeof MyContextBucketSchema>["bucket"];
export type MyUsageBreakdown = z.infer<typeof MyUsageBreakdownSchema>;
export type UserStatisticsSortBy = z.infer<typeof UserStatisticsSortBySchema>;
export type AppStatistics = z.infer<typeof AppStatisticsSchema>;
export type AppStatisticsSortBy = z.infer<typeof AppStatisticsSortBySchema>;
export type ChatCostBaseline = z.infer<typeof ChatCostBaselineSchema>;
export type SkillStatistics = z.infer<typeof SkillStatisticsSchema>;
export type SkillStatisticsSortBy = z.infer<typeof SkillStatisticsSortBySchema>;
export type OverviewStatistics = z.infer<typeof OverviewStatisticsSchema>;
export type CostSavingsStatistics = z.infer<typeof CostSavingsStatisticsSchema>;

export type StatisticsTeamTimeSeriesData = z.infer<
  typeof StatisticsTeamTimeSeriesDataSchema
>;
export type StatisticsAgentTimeSeriesData = z.infer<
  typeof StatisticsAgentTimeSeriesDataSchema
>;
export type StatisticsModelTimeSeriesData = z.infer<
  typeof StatisticsModelTimeSeriesDataSchema
>;
export type StatisticsUserTimeSeriesData = z.infer<
  typeof StatisticsUserTimeSeriesDataSchema
>;
export type StatisticsTimeSeriesData = z.infer<
  typeof StatisticsTimeSeriesDataSchema
>;
