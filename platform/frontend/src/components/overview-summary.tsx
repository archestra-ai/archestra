"use client";

import {
  type DetailFact,
  DetailFacts,
  type MaybeDetailFact,
  presentFacts,
} from "@/components/detail-facts";
import { SettingsSection } from "@/components/settings-section";

/** One key configuration value of the record, as `label` over `value`. */
export type OverviewFact = DetailFact;

/** An {@link OverviewFact} the record may have nothing to state, then dropped. */
export type MaybeOverviewFact = MaybeDetailFact;

/**
 * The Overview of a detail page: the record's key configuration on one row,
 * always visible.
 *
 * It used to be a collapsible holding a read-only mirror of every step of the
 * record's edit wizard. That cost a click before the page said anything at
 * all, and what the click revealed was a second copy of the form the header's
 * Edit already opens. The handful of values a reader scans a detail page for
 * fit on one row; everything else is behind the header's Edit.
 */
export function OverviewSummary({ facts }: { facts: MaybeOverviewFact[] }) {
  // Counted after the absent facts fall out: an Overview whose every fact
  // turned out to have nothing to say is a heading over an empty section.
  const present = presentFacts(facts);
  if (present.length === 0) return null;

  // No link to the full configuration: the page header's Edit already goes
  // there, one glance up.
  return (
    <SettingsSection title="Overview">
      {/* One row, wrapping rather than scrolling: a narrow window gets two
          short rows instead of a value cut off at the edge. */}
      <DetailFacts facts={present} className="gap-x-8 gap-y-3" />
    </SettingsSection>
  );
}
