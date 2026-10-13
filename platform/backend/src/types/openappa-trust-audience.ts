import { z } from "zod";
import { ExternalConsultOutcomeSchema } from "@/types/openappa-external-consults";

/** A place in policy text: the root (`entry` null) or an included battery's file. */
const PolicyLineRefSchema = z.object({
  /** The include entry of the battery file; null for the root `appa.toml`. */
  entry: z.string().nullable(),
  /** The 1-based line, when it can be located. */
  line: z.number().int().nullable(),
});

/**
 * One `<source>:<selector>` an audience reads its members from, pointing at
 * the source's selector template that serves it. `declaredBy` is null when no
 * included battery declares the source.
 */
export const AudienceSelectorRefSchema = PolicyLineRefSchema.extend({
  source: z.string(),
  selector: z.string(),
  declaredBy: z
    .object({
      battery: z.string(),
      /** Whether the platform answers it in process or the battery's helper runs. */
      runBy: z.enum(["archestra", "helper"]),
      /** The organization's latest consult of this source; null when none or not visible to the caller. */
      lastConsult: z
        .object({ outcome: ExternalConsultOutcomeSchema, at: z.date() })
        .nullable(),
    })
    .nullable(),
});
export type AudienceSelectorRef = z.infer<typeof AudienceSelectorRefSchema>;

const AudienceLevelBase = z.object({
  /** As rules spell it: `public`, `internal`, `self`, or `@<group>`. */
  name: z.string(),
});

/**
 * One audience the policy can label data with. `builtin` needs no mapping
 * (`public`, or a runtime level nothing maps and no rule names), `mapped` is
 * read from audience sources, `unmapped` is named by rules but nothing in
 * `[policy.audience]` says who belongs to it.
 */
export const AudienceLevelSchema = z.discriminatedUnion("kind", [
  AudienceLevelBase.extend({ kind: z.literal("builtin") }),
  AudienceLevelBase.extend({
    kind: z.literal("mapped"),
    /** The line in the root `appa.toml` that maps it. */
    mappingLine: z.number().int().nullable(),
    from: z.array(AudienceSelectorRefSchema),
    /** For a group, the runtime level it is declared `within`. */
    within: z.string().nullable(),
  }),
  AudienceLevelBase.extend({ kind: z.literal("unmapped") }),
]);
export type AudienceLevel = z.infer<typeof AudienceLevelSchema>;

export const TrustAudienceViewSchema = z.object({
  /** Trust levels, least trusted first. */
  trust: z.array(z.string()),
  /** Widest audience first: `public`, `internal`, `self`, then groups. */
  audiences: z.array(AudienceLevelSchema),
});
export type TrustAudienceView = z.infer<typeof TrustAudienceViewSchema>;
