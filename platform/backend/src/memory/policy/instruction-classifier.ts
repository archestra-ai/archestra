export type InstructionLikeSeverity = "high" | "medium";

export type InstructionClassification = {
  severity: InstructionLikeSeverity;
  detectors: string[];
} | null;

export function classifyInstructionLike(
  content: string,
): InstructionClassification {
  const normalized = normalize(content);
  if (!normalized) {
    return null;
  }

  const highDetectors = INSTRUCTION_HIGH_DETECTORS.filter((detector) =>
    detector.regex.test(normalized),
  ).map((detector) => detector.id);
  if (highDetectors.length > 0) {
    return {
      severity: "high",
      detectors: dedupeSorted(highDetectors),
    };
  }

  const mediumDetectors = INSTRUCTION_MEDIUM_DETECTORS.filter((detector) =>
    detector.regex.test(normalized),
  ).map((detector) => detector.id);
  if (mediumDetectors.length > 0) {
    return {
      severity: "medium",
      detectors: dedupeSorted(mediumDetectors),
    };
  }

  if (
    INSTRUCTION_START_REGEX.test(normalized) &&
    INSTRUCTION_CUE_REGEX.test(normalized)
  ) {
    return {
      severity: "medium",
      detectors: ["instruction_imperative_cue_pair"],
    };
  }

  return null;
}

function normalize(content: string): string {
  return content.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

type RegexDetector = {
  id: string;
  regex: RegExp;
};

const INSTRUCTION_HIGH_DETECTORS: readonly RegexDetector[] = [
  {
    id: "instruction_ignore_previous",
    regex:
      /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior)\b.{0,20}\binstructions?\b/,
  },
  {
    id: "instruction_system_prompt",
    regex: /\bsystem\s+prompt\b/,
  },
  {
    id: "instruction_you_are_now",
    regex: /\byou\s+are\s+now\b/,
  },
  {
    id: "instruction_override_rules",
    regex: /\boverride\b.{0,20}\b(rules?|guardrails?|instructions?)\b/,
  },
];

const INSTRUCTION_MEDIUM_DETECTORS: readonly RegexDetector[] = [
  {
    id: "instruction_always_never",
    regex: /\b(always|never)\b.{0,40}\b(remember|follow|obey|must)\b/,
  },
  {
    id: "instruction_do_not",
    regex: /\b(do not|don't)\b.{0,40}\b(change|deviate|answer|respond|share)\b/,
  },
  {
    id: "instruction_role_priming",
    regex: /\bact as\b.{0,30}\b(system|developer|admin|root)\b/,
  },
];

const INSTRUCTION_START_REGEX =
  /^(always|never|remember|follow|use|keep|avoid|ignore|answer|respond|do|don't|do not|please)\b/;
const INSTRUCTION_CUE_REGEX =
  /\b(always|never|you must|ignore previous|do not|don't|must)\b/;
