import { z } from "zod";
import { ExternalConsultOutcomeSchema } from "@/types/openappa-external-consults";

/** Where a remedy is declared: the root (`battery` null) or an included battery's file. */
const RemedySourceSchema = z.object({
  /** The include entry of the battery file; null for the root `appa.toml`. */
  entry: z.string().nullable(),
  battery: z.string().nullable(),
  /** The 1-based line of its `[[policy.*]]` header, when it can be located. */
  line: z.number().int().nullable(),
});

/**
 * Who answers when the remedy is consulted, from its `[externals.*]` entry.
 * `detail` is the built-in or module name, the URL host, or the program.
 */
export const RemedyImplementationSchema = z.object({
  kind: z.enum([
    "hitl",
    "approve",
    "llm",
    "claude_code",
    "builtin",
    "module",
    "url",
    "command",
  ]),
  detail: z.string().nullable(),
});
export type RemedyImplementation = z.infer<typeof RemedyImplementationSchema>;

const RemedyBase = z.object({
  name: z.string(),
  source: RemedySourceSchema,
  /** Null when no `[externals.*]` entry names it: declared but never offered. */
  implementation: RemedyImplementationSchema.nullable(),
  /** The tool rules it may act on share one of these; empty means any tool. */
  tags: z.array(z.string()),
  /** The organization's latest consult of it; null when none or not visible to the caller. */
  lastConsult: z
    .object({ outcome: ExternalConsultOutcomeSchema, at: z.date() })
    .nullable(),
});

/** What an authority may approve, one list per kind of block. */
export const AuthorityPermitsSchema = z.object({
  /** Approval marks; `["*"]` is every declared mark except `blocked`. */
  attention: z.array(z.string()),
  audienceMissing: z.array(z.string()),
  trustBelow: z.string().nullable(),
  effectsContaining: z.array(z.string()),
});
export type AuthorityPermits = z.infer<typeof AuthorityPermitsSchema>;

export const AuthoritySchema = RemedyBase.extend({
  kind: z.literal("authority"),
  permits: AuthorityPermitsSchema,
});
export type Authority = z.infer<typeof AuthoritySchema>;

/** The one transition a sanitizer's `permits` declares. */
export const SanitizerPermitsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("audience"),
    from: z.array(z.string()),
    to: z.array(z.string()),
  }),
  z.object({ kind: z.literal("trust"), from: z.string(), to: z.string() }),
]);
export type SanitizerPermits = z.infer<typeof SanitizerPermitsSchema>;

export const SanitizerSchema = RemedyBase.extend({
  kind: z.literal("sanitizer"),
  on: z.array(z.enum(["tool_output", "tool_input"])),
  /** Null when the declaration carries no readable `permits`. */
  permits: SanitizerPermitsSchema.nullable(),
});
export type Sanitizer = z.infer<typeof SanitizerSchema>;

export const BlockKindSchema = z.enum([
  "trust",
  "audience",
  "effects",
  "approvals",
]);
export type BlockKind = z.infer<typeof BlockKindSchema>;

/**
 * One way a rule can block a call, with how many rules can cause it and
 * which wired remedies can lift it. `unservedMarks` is for `approvals`: the
 * marks rules require that no wired authority may give.
 */
export const BlockCoverageSchema = z.object({
  kind: BlockKindSchema,
  rules: z.number().int().nonnegative(),
  approvers: z.number().int().nonnegative(),
  cleaners: z.number().int().nonnegative(),
  unservedMarks: z.array(z.string()),
  /** False when some rule can cause it and nothing wired can lift it. */
  covered: z.boolean(),
});
export type BlockCoverage = z.infer<typeof BlockCoverageSchema>;

export const RemediesViewSchema = z.object({
  authorities: z.array(AuthoritySchema),
  sanitizers: z.array(SanitizerSchema),
  /** Every block kind, in the order the page shows them. */
  blocks: z.array(BlockCoverageSchema),
});
export type RemediesView = z.infer<typeof RemediesViewSchema>;

/**
 * One calendar day of the activity window, in the caller's time zone: the
 * tool calls the runtime denied that day, by how each ended.
 */
export const ActivityDaySchema = z.object({
  /** `YYYY-MM-DD` in the requested time zone. */
  date: z.string(),
  /** Denied calls nothing lifted. */
  blocked: z.number().int().nonnegative(),
  /** Denied calls an authority then approved. */
  approved: z.number().int().nonnegative(),
  /** Denied calls a sanitizer then cleaned. */
  cleaned: z.number().int().nonnegative(),
});
export type ActivityDay = z.infer<typeof ActivityDaySchema>;

export const RemediesActivitySchema = z.object({
  timeZone: z.string(),
  /** Oldest day first, ending today. */
  days: z.array(ActivityDaySchema),
});
export type RemediesActivity = z.infer<typeof RemediesActivitySchema>;
