import type { MemoryPolicyFlag } from "@/types/memory-item";

export type SensitiveDataBlockReason = "secret" | "high_risk_pii";

export type SensitiveDataScreenResult = {
  blocked: boolean;
  blockReason: SensitiveDataBlockReason | null;
  policyFlags: MemoryPolicyFlag[];
  matchedDetectors: string[];
};

export function screenSensitiveData(params: {
  content: string;
}): SensitiveDataScreenResult {
  const normalizedContent = params.content.trim();
  const secretMatches = findRegexMatches(normalizedContent, SECRET_DETECTORS);

  if (secretMatches.length > 0) {
    return {
      blocked: true,
      blockReason: "secret",
      policyFlags: [],
      matchedDetectors: toSortedUniqueList(secretMatches),
    };
  }

  const piiMatches = findRegexMatches(
    normalizedContent,
    HIGH_RISK_PII_DETECTORS,
  );
  if (containsCreditCard(normalizedContent)) {
    piiMatches.push("credit_card");
  }

  if (piiMatches.length > 0) {
    return {
      blocked: true,
      blockReason: "high_risk_pii",
      policyFlags: [],
      matchedDetectors: toSortedUniqueList(piiMatches),
    };
  }

  const instructionLike = isInstructionLike(normalizedContent);
  return {
    blocked: false,
    blockReason: null,
    policyFlags: instructionLike ? ["instruction_like"] : [],
    matchedDetectors: instructionLike ? ["instruction_like"] : [],
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

type RegexDetector = {
  id: string;
  regex: RegExp;
};

function findRegexMatches(
  content: string,
  detectors: readonly RegexDetector[],
): string[] {
  const matches: string[] = [];

  for (const detector of detectors) {
    detector.regex.lastIndex = 0;
    if (detector.regex.test(content)) {
      matches.push(detector.id);
    }
  }

  return matches;
}

function containsCreditCard(content: string): boolean {
  const matches = content.match(/(?:\d[ -]*?){13,19}/g);
  if (!matches) {
    return false;
  }

  for (const candidate of matches) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) {
      continue;
    }

    if (passesLuhnCheck(digits)) {
      return true;
    }
  }

  return false;
}

function passesLuhnCheck(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number.parseInt(digits[index] ?? "", 10);
    if (!Number.isFinite(value)) {
      return false;
    }

    if (shouldDouble) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }

    sum += value;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function isInstructionLike(content: string): boolean {
  if (content.length === 0) {
    return false;
  }

  const normalized = content.toLowerCase();
  const startsWithImperative = INSTRUCTION_START_REGEX.test(normalized);
  const containsInstructionCue = INSTRUCTION_CUE_REGEX.test(normalized);

  return startsWithImperative && containsInstructionCue;
}

function toSortedUniqueList(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

const SECRET_DETECTORS: readonly RegexDetector[] = [
  {
    id: "aws_access_key",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: "openai_key",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: "github_token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  },
  {
    id: "google_api_key",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/,
  },
  {
    id: "jwt_like_token",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    id: "password_assignment",
    regex: /\b(password|secret|token|api[_\s-]?key)\b\s*[:=]\s*\S+/i,
  },
];

const HIGH_RISK_PII_DETECTORS: readonly RegexDetector[] = [
  {
    id: "ssn_like",
    regex: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    id: "government_id_keyword",
    regex:
      /\b(passport|driver(?:'s)?\s+license|national\s+id|government\s+id)\b/i,
  },
  {
    id: "financial_account_keyword",
    regex: /\b(bank\s+account|routing\s+number|iban|swift)\b/i,
  },
  {
    id: "minors_keyword",
    regex: /\b(minor|underage|child|kid)\b/i,
  },
  {
    id: "health_sensitive_keyword",
    regex: /\b(diagnosis|medical\s+record|prescription|therapy)\b/i,
  },
  {
    id: "legal_sensitive_keyword",
    regex: /\b(attorney-client|legal\s+dispute|lawsuit)\b/i,
  },
];

const INSTRUCTION_START_REGEX =
  /^(always|never|remember|follow|use|keep|avoid|ignore|answer|respond|do|don't|do not|please)\b/;
const INSTRUCTION_CUE_REGEX =
  /\b(always|never|you must|ignore previous|do not|don't|must)\b/;
