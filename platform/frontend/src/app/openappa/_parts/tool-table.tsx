"use client";

export type ToolTableProps = {
  /** Only this server's tools; the Server column and facet are then hidden with `hideServer`. */
  catalogId?: string;
  hideServer?: boolean;
  /** The Server facet's starting value, from a link that opened the Tools tab filtered to a server. */
  initialServer?: string;
};

/**
 * Every tool the policy covers, with the rule that governs it and what that
 * rule does. Used unscoped on the Tools tab and scoped to one server in the
 * server dialog. Self-contained: its own coverage query and its own filter
 * and page state.
 *
 * Scaffold placeholder; WP3 replaces the body.
 */
export function ToolTable({
  catalogId,
  hideServer,
  initialServer,
}: ToolTableProps) {
  return (
    <div
      data-testid="tool-table"
      data-catalog-id={catalogId}
      data-hide-server={hideServer ? "true" : undefined}
      data-initial-server={initialServer}
      className="rounded-lg border p-4 text-sm text-muted-foreground"
    >
      <span>The tools table is not built yet.</span>
    </div>
  );
}
