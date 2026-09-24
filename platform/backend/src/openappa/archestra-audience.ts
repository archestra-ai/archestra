import { z } from "zod";
import MemberModel from "@/models/member";
import TeamModel from "@/models/team";
import type { HelperConsultOutcome } from "./helper-bridge";

/**
 * The bundled `archestra` battery's audience source, answered by the platform
 * itself: the battery ships a helper that reads Archestra's membership over
 * HTTP, which the platform already holds. The install names the organization,
 * so the helper's credential is never needed.
 */
export const archestraAudience = {
  /** Whether the host answers this battery external in process. */
  serves(params: {
    batteryName: string;
    packageHash: string | null;
    externalName: string;
  }): boolean {
    return (
      servesBattery(params) && params.externalName === ARCHESTRA_AUDIENCE_NAME
    );
  },

  /** Whether the host answers every helper of this battery, so it binds no credential. */
  servesBattery(params: {
    batteryName: string;
    packageHash: string | null;
  }): boolean {
    return servesBattery(params);
  },

  async consult(params: {
    organizationId: string;
    request: string;
  }): Promise<HelperConsultOutcome> {
    const parsed = ConsultSchema.safeParse(parseJson(params.request));
    if (!parsed.success)
      return {
        kind: "failed",
        reason: "the consult is not an archestra audience request",
      };
    const { declaration, artifact } = parsed.data;
    if (
      declaration.templates.length !== SERVED_TEMPLATES.length ||
      declaration.templates.some(
        (template, i) => template !== SERVED_TEMPLATES[i],
      )
    )
      return {
        kind: "failed",
        reason: `the policy declares templates ${JSON.stringify(declaration.templates)}, the platform serves ${JSON.stringify(SERVED_TEMPLATES)}`,
      };
    const answer =
      "selector" in artifact
        ? await members(params.organizationId, artifact.selector)
        : await principal(params.organizationId, artifact.member);
    return answer.kind === "answered"
      ? { kind: "answered", answer: { version: 1, answer: answer.value } }
      : { kind: "failed", reason: answer.reason };
  },
};

// ===

const ARCHESTRA_AUDIENCE_NAME = "archestra";
const SERVED_TEMPLATES = ["members", "team/<team>", "user/<user>"];
const MEMBER_PREFIX = "archestra:";
const MAX_MEMBERS = 5000;

const ConsultSchema = z.object({
  version: z.literal(1),
  kind: z.literal("audience"),
  name: z.literal(ARCHESTRA_AUDIENCE_NAME),
  declaration: z.object({ templates: z.array(z.string()) }),
  artifact: z.union([
    z.object({ selector: z.string() }).strict(),
    z.object({ member: z.string() }).strict(),
  ]),
});

type Selector =
  | { kind: "members" }
  | { kind: "team"; idOrName: string }
  | { kind: "user"; idOrEmail: string };

type Answer =
  | { kind: "answered"; value: Record<string, unknown> }
  | { kind: "refused"; reason: string };

function servesBattery(params: {
  batteryName: string;
  packageHash: string | null;
}): boolean {
  // Only the bundled package: an uploaded one may reuse the name.
  return (
    params.batteryName === ARCHESTRA_AUDIENCE_NAME &&
    params.packageHash === null
  );
}

async function members(
  organizationId: string,
  selector: string,
): Promise<Answer> {
  const parsed = parseSelector(selector);
  if (!parsed)
    return {
      kind: "refused",
      reason: `${JSON.stringify(selector)} names no collection this source serves`,
    };
  let emails: string[];
  switch (parsed.kind) {
    case "members":
      emails = await MemberModel.findEmailsByOrganization({
        organizationId,
        limit: MAX_MEMBERS + 1,
      });
      break;
    case "team": {
      const team = await TeamModel.findSubtreeMemberEmails({
        organizationId,
        idOrName: parsed.idOrName,
        limit: MAX_MEMBERS + 1,
      });
      switch (team.kind) {
        case "found":
          emails = team.emails;
          break;
        case "missing":
          return {
            kind: "refused",
            reason: `no team ${JSON.stringify(parsed.idOrName)}`,
          };
        case "ambiguous":
          return {
            kind: "refused",
            reason: `several teams are named ${JSON.stringify(parsed.idOrName)}`,
          };
      }
      break;
    }
    case "user": {
      const member = await MemberModel.findByIdOrEmail(
        parsed.idOrEmail,
        organizationId,
      );
      if (!member)
        return {
          kind: "refused",
          reason: `no member ${JSON.stringify(parsed.idOrEmail)}`,
        };
      emails = [member.email];
      break;
    }
  }
  if (emails.length > MAX_MEMBERS)
    return {
      kind: "refused",
      reason: `${JSON.stringify(selector)} has more than ${MAX_MEMBERS} members`,
    };
  return { kind: "answered", value: { members: emails } };
}

/** An `archestra:<user-id>` member as that user's email; null when no such member exists. */
async function principal(
  organizationId: string,
  member: string,
): Promise<Answer> {
  const userId = member.startsWith(MEMBER_PREFIX)
    ? member.slice(MEMBER_PREFIX.length)
    : "";
  if (!userId)
    return {
      kind: "refused",
      reason: `${JSON.stringify(member)} is not an archestra-qualified member`,
    };
  const found = await MemberModel.findByIdOrEmail(userId, organizationId);
  return { kind: "answered", value: { principal: found?.email ?? null } };
}

function parseSelector(selector: string): Selector | null {
  const [head, name, ...rest] = selector.split("/");
  if (rest.length > 0) return null;
  switch (head) {
    case "members":
      return name === undefined ? { kind: "members" } : null;
    case "team":
      return name ? { kind: "team", idOrName: name } : null;
    case "user":
      return name ? { kind: "user", idOrEmail: name } : null;
    default:
      return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
