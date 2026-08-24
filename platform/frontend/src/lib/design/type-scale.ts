/**
 * The text roles every entity surface is built from: agents, skills,
 * MCP gateways, the MCP registry. Before this existed the
 * frontend carried 141 distinct typography signatures and 190 arbitrary
 * `text-[Npx]` sizes in twelve different sizes, which is what a page looks
 * like when each screen picks its own type.
 *
 * The scale is deliberately flat. Body text is 14px (`text-sm`) and so is
 * every title: a page title outranks a section title by WEIGHT, not by size.
 * Labels and metadata use 12px (`text-xs`) support text that is read second.
 *
 * Rules that come with the scale (a role picked correctly still reads wrong
 * if these are broken):
 *
 *   1. Body copy is `text-foreground`, never `text-muted-foreground`. Muting
 *      body text to make a page look calm makes it look disabled instead.
 *   2. `meta` never carries a string the user must read to make a decision.
 *      If missing it would change what the user clicks, it is `body`. Meta is
 *      for provenance and timestamps, not for status, errors or counts that
 *      gate an action.
 *   3. At most three roles per card. A card using four is describing two
 *      things and should be two cards.
 *
 * Applied as a class string, the way the rest of the shared style in this
 * codebase is:
 *
 *   <p className={typeRole({ role: "body" })}>
 */
const ROLE_CLASSES = {
  /** A card header or a heading inside the page body. */
  "section-title": "text-sm font-medium text-foreground",
  /** A field name, a column head, a key in a key/value pair. Sentence case:
      all-caps eyebrow labels add a ninth style and shout at field names. */
  label: "text-xs font-medium text-muted-foreground",
  /** Prose and values. Never muted. */
  body: "text-sm font-normal text-foreground",
  /** Provenance and timestamps. Never load-bearing (rule 2). */
  meta: "text-xs font-normal text-muted-foreground",
};

export type TypeRole = keyof typeof ROLE_CLASSES;

/**
 * The role is required and has no default. A default would let `typeRole()`
 * compile, return a class string for some other role and style the element
 * with type nobody chose; picking wrong should be a type error at the call
 * site, not a silent guess at render time.
 */
export function typeRole({ role }: { role: TypeRole }): string {
  return ROLE_CLASSES[role];
}
