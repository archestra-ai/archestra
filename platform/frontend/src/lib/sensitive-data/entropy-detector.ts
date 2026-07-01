import {
  type Detector,
  type DetectorContext,
  detectorId,
  type Finding,
} from "./types";

const ENTROPY_DETECTOR_ID = detectorId("entropy");
const INTERNAL_LABEL = "high-entropy-token";

const CANDIDATE_PATTERN = /\S{20,}/g;
// matches RFC 3986 scheme followed by "://" — skip these to avoid false
// positives on URLs (e.g. Google Docs URLs contain high-entropy document IDs).
const URL_LIKE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

// fraction of the theoretical max entropy a token must reach. an absolute
// threshold (e.g. 4.5 bits) is unreachable for shorter random tokens because
// max entropy is capped by log2(min(len, alphabet)). a ratio works uniformly
// across lengths.
const ENTROPY_RATIO_THRESHOLD = 0.85;
// every token is scored against this single reference alphabet (base64-sized).
// scoring hex against a 16-symbol alphabet would make any uniform hex string
// (git SHAs, sha256/md5 digests) reach ratio ~1.0 and flag — but a hash and a
// hex secret are entropy-identical, so that branch only ever produced false
// positives on content hashes. against the 64-symbol alphabet hex under-fills
// and falls below threshold, while genuine base64/base62 keys still clear it.
const REFERENCE_ALPHABET_SIZE = 64;

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }

  const len = s.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export const entropyDetector: Detector = {
  id: ENTROPY_DETECTOR_ID,
  scan(text: string, context?: DetectorContext): Finding[] {
    const findings: Finding[] = [];
    const existing = context?.existingFindings ?? [];

    const pattern = new RegExp(
      CANDIDATE_PATTERN.source,
      CANDIDATE_PATTERN.flags,
    );
    let match = pattern.exec(text);
    while (match !== null) {
      const token = match[0];
      if (token.length === 0) {
        pattern.lastIndex += 1;
        match = pattern.exec(text);
        continue;
      }
      const startIndex = match.index;
      const endIndex = startIndex + token.length;

      if (
        !URL_LIKE_PATTERN.test(token) &&
        !overlapsExisting(startIndex, endIndex, existing) &&
        isHighEntropy(token)
      ) {
        findings.push({
          detectorId: ENTROPY_DETECTOR_ID,
          internalLabel: INTERNAL_LABEL,
          startIndex,
          endIndex,
        });
      }
      match = pattern.exec(text);
    }

    return findings;
  },
};

function isHighEntropy(token: string): boolean {
  const maxEntropy = Math.log2(Math.min(token.length, REFERENCE_ALPHABET_SIZE));
  if (maxEntropy === 0) return false;
  return shannonEntropy(token) / maxEntropy >= ENTROPY_RATIO_THRESHOLD;
}

function overlapsExisting(
  start: number,
  end: number,
  existing: Finding[],
): boolean {
  for (const finding of existing) {
    if (start < finding.endIndex && end > finding.startIndex) return true;
  }
  return false;
}
