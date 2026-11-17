import {
  severityRank,
  type TunerSeverity,
  type TunerSuggestionStatus,
} from "@/types/tuner";

const TUNER_SUPPRESSION_DAYS = 14;

/** What the suggestion history says about one fingerprint. */
export interface FingerprintHistory {
  /** The open or published suggestion, if any; at most one exists. */
  active: {
    id: string;
    status: "open" | "published";
    severity: TunerSeverity;
  } | null;
  /** The most recent suggestion an admin closed as done or rejected. */
  lastClosed: {
    status: "done" | "rejected";
    severity: TunerSeverity;
    statusChangedAt: Date;
  } | null;
}

export type SuppressionVerdict =
  | { type: "new" }
  | { type: "supersede"; activeId: string }
  | { type: "suppressed"; reason: SuppressionReason };

export type SuppressionReason =
  | "open_suggestion"
  | "change_in_flight"
  | "recently_closed";

export const EMPTY_FINGERPRINT_HISTORY: FingerprintHistory = {
  active: null,
  lastClosed: null,
};

/**
 * Whether a candidate of `severity` may become a suggestion. An open one is
 * superseded only by a higher severity; a published change blocks until it
 * settles; done/rejected silence the fingerprint for the suppression window
 * unless the severity rose since.
 */
export function suppressionVerdict(
  history: FingerprintHistory,
  severity: TunerSeverity,
  now: Date,
): SuppressionVerdict {
  const rank = severityRank(severity);
  switch (history.active?.status) {
    case "published":
      return { type: "suppressed", reason: "change_in_flight" };
    case "open":
      return rank > severityRank(history.active.severity)
        ? { type: "supersede", activeId: history.active.id }
        : { type: "suppressed", reason: "open_suggestion" };
    case undefined:
      break;
  }
  const closed = history.lastClosed;
  if (
    closed &&
    now.getTime() - closed.statusChangedAt.getTime() <
      TUNER_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000 &&
    rank <= severityRank(closed.severity)
  ) {
    return { type: "suppressed", reason: "recently_closed" };
  }
  return { type: "new" };
}

export function isClosedByAdmin(
  status: TunerSuggestionStatus,
): status is "done" | "rejected" {
  return status === "done" || status === "rejected";
}
