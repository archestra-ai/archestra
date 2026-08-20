/**
 * The eight text roles every entity surface is built from: agents, skills,
 * LLM proxies, MCP gateways, the MCP registry. Before this existed the
 * frontend carried 141 distinct typography signatures and 190 arbitrary
 * `text-[Npx]` sizes in twelve different sizes, which is what a page looks
 * like when each screen picks its own type.
 *
 * The scale is deliberately flat. Body text is 14px (`text-sm`) and so is
 * every title: a page title outranks a section title by WEIGHT, not by size.
 * Size is used for exactly two things, and both are documented exceptions:
 *
 *   12px (`text-xs`)   label, meta, code: support text that is read second
 *   16px (`text-base`) metric only: the one number a stat tile exists to show
 *
 * Rules that come with the scale (a role picked correctly still reads wrong
 * if these are broken):
 *
 *   1. Body copy is `text-foreground`, never `text-muted-foreground`. Muting
 *      body text to make a page look calm makes it look disabled instead.
 *      The only muted prose role is `page-description`.
 *   2. `meta` never carries a string the user must read to make a decision.
 *      If missing it would change what the user clicks, it is `body`. Meta is
 *      for provenance and timestamps, not for status, errors or counts that
 *      gate an action.
 *   3. `tabular-nums` on any number that updates live, which `metric` already
 *      carries. Proportional figures re-flow on every tick and the row jitters.
 *   4. At most three roles per card. A card using four is describing two
 *      things and should be two cards.
 *
 * Applied as a class string, the way the rest of the shared style in this
 * codebase is:
 *
 *   <h1 className={cn(typeRole({ role: "page-title" }), "truncate")}>
 */
const ROLE_CLASSES = {
  /** The single name of the thing this page is about. One per page. */
  "page-title": "text-sm font-semibold tracking-tight text-foreground",
  /**
   * The sentence under the page title saying what the thing does. The one
   * role that is muted prose, because it is orientation and not content.
   */
  "page-description": "text-sm font-normal text-muted-foreground",
  /** A card header or a heading inside the page body. */
  "section-title": "text-sm font-medium text-foreground",
  /** A field name, a column head, a key in a key/value pair. */
  label: "text-xs font-medium uppercase tracking-wide text-muted-foreground",
  /** Prose and values. Never muted. */
  body: "text-sm font-normal text-foreground",
  /** Provenance and timestamps. Never load-bearing (rule 2). */
  meta: "text-xs font-normal text-muted-foreground",
  /** A number a card exists to show. Tabular by construction (rule 3). */
  metric: "text-base font-semibold tabular-nums text-foreground",
  /** Identifiers the user may copy: ids, paths, commands, model names. */
  code: "font-mono text-xs font-normal text-foreground",
};

export type TypeRole = keyof typeof ROLE_CLASSES;

/** Every role in the scale, in the order the module documents them. */
export const TYPE_ROLES = Object.keys(ROLE_CLASSES) as TypeRole[];

/**
 * The role is required and has no default. A default would let `typeRole()`
 * compile, return a class string for some other role and style the element
 * with type nobody chose; picking wrong should be a type error at the call
 * site, not a silent guess at render time.
 */
export function typeRole({ role }: { role: TypeRole }): string {
  return ROLE_CLASSES[role];
}
