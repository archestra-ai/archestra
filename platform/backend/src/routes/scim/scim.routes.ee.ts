import { RouteId } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { scimProvisioningService } from "@/services/scim-provisioning.ee";
import { ApiError } from "@/types";

/**
 * SCIM 2.0 `/Users` endpoints for identity-provider provisioning. The
 * identity provider authenticates with a service-account token
 * (`Authorization: Bearer <token>`); its base URL is
 * `<archestra>/api/scim/v2`. See `scimProvisioningService` for what a pushed
 * user becomes.
 */
const scimRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // No licence check here, like ChatOps auto-provisioning: users the identity
  // provider pushes are always created. Past the small-team tier without a
  // licence they cannot sign in yet, because Single Sign-On is off, and they
  // can as soon as the licence is set.
  // Every response is SCIM's media type, and every error body is a SCIM error
  // (RFC 7644 section 3.12). The app's error handler still picks the status
  // and logs; this only reshapes its `{ error }` body, including errors raised
  // before the handler runs (authentication, licence, validation).
  fastify.addHook("preSerialization", async (_request, reply, payload) => {
    reply.type(SCIM_CONTENT_TYPE);
    return reply.statusCode >= 400
      ? toScimError(reply.statusCode, payload)
      : payload;
  });

  // Identity providers send SCIM bodies as `application/scim+json`, and may
  // send that content type, or JSON's, on a DELETE with no body.
  const parseJson = fastify.getDefaultJsonParser("error", "error");
  fastify.removeContentTypeParser("application/json");
  fastify.addContentTypeParser(
    ["application/json", "application/scim+json"],
    { parseAs: "string" },
    (request, body, done) => {
      const text = typeof body === "string" ? body : body.toString();
      if (text.trim() === "") done(null, undefined);
      else parseJson(request, text, done);
    },
  );

  fastify.get(
    `${SCIM_BASE}/ServiceProviderConfig`,
    {
      schema: {
        operationId: RouteId.ScimGetServiceProviderConfig,
        description: "SCIM 2.0: the features this SCIM service supports",
        tags: ["SCIM"],
        response: scimResponses(200, z.record(z.string(), z.unknown())),
      },
    },
    async (_request, reply) =>
      reply.send({
        schemas: [
          "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
        ],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: MAX_COUNT },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [
          {
            type: "oauthbearertoken",
            name: "OAuth Bearer Token",
            description: "An Archestra service-account token",
          },
        ],
      }),
  );

  fastify.get(
    `${SCIM_BASE}/Users`,
    {
      schema: {
        operationId: RouteId.ScimListUsers,
        description:
          'SCIM 2.0: list users. Supports only the filter `userName eq "<email>"`.',
        tags: ["SCIM"],
        querystring: z.object({
          filter: z.string().optional(),
          startIndex: z.coerce.number().int().min(1).default(1),
          // A larger count is answered with `MAX_COUNT` users, not an error
          // (RFC 7644 section 3.4.2.4).
          count: z.coerce.number().int().min(0).default(100),
        }),
        response: scimResponses(200, ScimListResponseSchema),
      },
    },
    async ({ query, organizationId }, reply) => {
      const userName =
        query.filter === undefined ? undefined : parseFilter(query.filter);
      return reply.send(
        await scimProvisioningService.listUsers({
          organizationId,
          userName,
          startIndex: query.startIndex,
          count: Math.min(query.count, MAX_COUNT),
        }),
      );
    },
  );

  fastify.get(
    `${SCIM_BASE}/Users/:id`,
    {
      schema: {
        operationId: RouteId.ScimGetUser,
        description: "SCIM 2.0: get one user",
        tags: ["SCIM"],
        params: UserIdParamsSchema,
        response: scimResponses(200, ScimUserSchema),
      },
    },
    async ({ params, organizationId }, reply) =>
      reply.send(await getUserOrThrow({ organizationId, userId: params.id })),
  );

  fastify.post(
    `${SCIM_BASE}/Users`,
    {
      schema: {
        operationId: RouteId.ScimCreateUser,
        description:
          "SCIM 2.0: create a user. The user becomes a member who has not signed up yet and can be added to teams before their first SSO sign-in. `active: false` creates the user soft-deleted.",
        tags: ["SCIM"],
        body: ScimUserInputSchema,
        response: scimResponses(201, ScimUserSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      const email = emailOf(body);
      const result = await scimProvisioningService.createUser({
        organizationId,
        userName: email,
        name: displayNameOf(body) ?? email,
        active: body.active !== false,
      });
      if (result.status === "exists")
        throw new ApiError(
          409,
          "A user with this userName already exists",
          "uniqueness",
        );
      return reply.code(201).send(result.user);
    },
  );

  fastify.put(
    `${SCIM_BASE}/Users/:id`,
    {
      schema: {
        operationId: RouteId.ScimReplaceUser,
        description:
          "SCIM 2.0: replace a user. `active: false` soft-deletes the user (no sign-in, data kept), `active: true` restores them, and `userName` and `displayName` change the email and name of a user who has not signed in yet.",
        tags: ["SCIM"],
        params: UserIdParamsSchema,
        body: ScimUserInputSchema,
        response: scimResponses(200, ScimUserSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await applyChanges(request, {
          userId: request.params.id,
          active: request.body.active,
          userName: emailIn(request.body),
          displayName: displayNameOf(request.body),
        }),
      ),
  );

  fastify.patch(
    `${SCIM_BASE}/Users/:id`,
    {
      schema: {
        operationId: RouteId.ScimPatchUser,
        description:
          "SCIM 2.0: patch a user. `active: false` soft-deletes the user (no sign-in, data kept), `active: true` restores them, and `userName` and `displayName` change the email and name of a user who has not signed in yet.",
        tags: ["SCIM"],
        params: UserIdParamsSchema,
        body: ScimPatchSchema,
        response: scimResponses(200, ScimUserSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await applyChanges(request, {
          userId: request.params.id,
          active: activeFromPatch(request.body),
          userName: userNameFromPatch(request.body),
          displayName: displayNameFromPatch(request.body),
        }),
      ),
  );

  fastify.delete(
    `${SCIM_BASE}/Users/:id`,
    {
      schema: {
        operationId: RouteId.ScimDeleteUser,
        description:
          "SCIM 2.0: delete a user. Soft-deletes the user like deactivation: no sign-in, data kept.",
        tags: ["SCIM"],
        params: UserIdParamsSchema,
        response: scimResponses(204, z.undefined()),
      },
    },
    async (request, reply) => {
      await applyChanges(request, { userId: request.params.id, active: false });
      return reply.code(204).send();
    },
  );

  // Any other path under the SCIM base URL, such as `/Groups` or `/Schemas`,
  // is a SCIM 404 like every other error here. Registered last, so it runs the
  // hooks above.
  await fastify.register(
    async (scope) => {
      scope.setNotFoundHandler(() => {
        throw new ApiError(404, "This SCIM endpoint is not supported");
      });
    },
    { prefix: SCIM_BASE },
  );
};

export default scimRoutes;

// ===== internal helpers =====

const SCIM_BASE = "/api/scim/v2";
const MAX_COUNT = 200;

const UserIdParamsSchema = z.object({ id: z.string() });

const SCIM_CONTENT_TYPE = "application/scim+json; charset=utf-8";
const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

/** The `scimType` values (RFC 7644 section 3.12) this service sends. */
const SCIM_TYPES = new Set(["invalidFilter", "invalidValue", "uniqueness"]);

const ScimErrorSchema = z.object({
  schemas: z.array(z.string()),
  status: z.string(),
  scimType: z.string().optional(),
  detail: z.string(),
});

/** One success response plus a SCIM error body for every error status. */
function scimResponses<S extends number, T extends z.ZodTypeAny>(
  status: S,
  schema: T,
) {
  return {
    [status]: schema,
    400: ScimErrorSchema,
    401: ScimErrorSchema,
    403: ScimErrorSchema,
    404: ScimErrorSchema,
    409: ScimErrorSchema,
    500: ScimErrorSchema,
  } as Record<S, T> &
    Record<400 | 401 | 403 | 404 | 409 | 500, typeof ScimErrorSchema>;
}

/**
 * The SCIM error for an error reply. `scimType` comes from the error's
 * internal code when it names one, and a 409 is always `uniqueness`.
 */
function toScimError(status: number, payload: unknown) {
  const error =
    typeof payload === "object" && payload !== null && "error" in payload
      ? (payload.error as { message?: unknown; internal_code?: unknown })
      : undefined;
  const code = error?.internal_code;
  const scimType =
    typeof code === "string" && SCIM_TYPES.has(code)
      ? code
      : status === 409
        ? "uniqueness"
        : undefined;
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType && { scimType }),
    detail:
      typeof error?.message === "string" ? error.message : "Request failed",
  };
}

/** SCIM sends booleans as JSON booleans or, from Entra ID, as "True"/"False". */
const ScimBooleanSchema = z.union([
  z.boolean(),
  z
    .string()
    .regex(/^(true|false)$/i)
    .transform((value) => value.toLowerCase() === "true"),
]);

const ScimUserInputSchema = z.looseObject({
  userName: z.string().trim().min(1),
  displayName: z.string().optional(),
  name: z
    .looseObject({
      formatted: z.string().optional(),
      givenName: z.string().optional(),
      familyName: z.string().optional(),
    })
    .optional(),
  emails: z
    .array(
      z.looseObject({
        value: z.string(),
        primary: ScimBooleanSchema.optional(),
      }),
    )
    .optional(),
  active: ScimBooleanSchema.optional(),
});

const ScimPatchSchema = z.looseObject({
  Operations: z.array(
    z.looseObject({
      op: z.string(),
      path: z.string().optional(),
      value: z.unknown().optional(),
    }),
  ),
});

const ScimUserSchema = z.object({
  schemas: z.array(z.string()),
  id: z.string(),
  userName: z.string(),
  displayName: z.string(),
  name: z.object({ formatted: z.string() }),
  emails: z.array(
    z.object({ value: z.string(), type: z.string(), primary: z.boolean() }),
  ),
  active: z.boolean(),
  meta: z.object({
    resourceType: z.string(),
    created: z.string(),
    lastModified: z.string(),
  }),
});

const ScimListResponseSchema = z.object({
  schemas: z.array(z.string()),
  totalResults: z.number().int(),
  startIndex: z.number().int(),
  itemsPerPage: z.number().int(),
  Resources: z.array(ScimUserSchema),
});

type ScimUserInput = z.infer<typeof ScimUserInputSchema>;

/** Only `userName eq "<value>"`, the filter Entra ID and Okta send. */
function parseFilter(filter: string): string {
  const match = /^\s*userName\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!match)
    throw new ApiError(
      400,
      'Only the filter userName eq "<value>" is supported',
      "invalidFilter",
    );
  return match[1].replace(/\\(.)/g, "$1");
}

/** The email is the userName when it is one, else the primary email. */
function emailOf(body: ScimUserInput): string {
  const email = emailIn(body);
  if (!email)
    throw new ApiError(
      400,
      "userName or emails must contain an email address",
      "invalidValue",
    );
  return email;
}

function emailIn(body: ScimUserInput): string | undefined {
  if (EMAIL.test(body.userName)) return body.userName.toLowerCase();
  const email =
    body.emails?.find((entry) => entry.primary === true)?.value ??
    body.emails?.[0]?.value;
  return email && EMAIL.test(email) ? email.toLowerCase() : undefined;
}

function displayNameOf(body: ScimUserInput): string | undefined {
  const given = [body.name?.givenName, body.name?.familyName]
    .filter(Boolean)
    .join(" ");
  return body.displayName || body.name?.formatted || given || undefined;
}

/**
 * The values a PATCH sets for one attribute, in order: from
 * `{ path: "<attribute>", value }`, or from a path-less
 * `{ value: { <attribute> } }` (both forms are in use).
 */
function patchValues(
  body: z.infer<typeof ScimPatchSchema>,
  attribute: "active" | "userName" | "displayName",
): unknown[] {
  return body.Operations.flatMap((operation) => {
    if (!/^(replace|add)$/i.test(operation.op)) return [];
    if (operation.path?.toLowerCase() === attribute.toLowerCase())
      return [operation.value];
    return operation.path === undefined &&
      typeof operation.value === "object" &&
      operation.value !== null
      ? [(operation.value as Record<string, unknown>)[attribute]]
      : [];
  });
}

/** The `active` value a PATCH sets, if any. */
function activeFromPatch(body: z.infer<typeof ScimPatchSchema>) {
  return patchValues(body, "active")
    .map((value) => ScimBooleanSchema.safeParse(value))
    .findLast((parsed) => parsed.success)?.data;
}

/** The email-shaped `userName` a PATCH sets, if any. */
function userNameFromPatch(body: z.infer<typeof ScimPatchSchema>) {
  return patchValues(body, "userName")
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .findLast((value) => EMAIL.test(value));
}

/** The `displayName` a PATCH sets, if any. */
function displayNameFromPatch(body: z.infer<typeof ScimPatchSchema>) {
  return patchValues(body, "displayName")
    .filter((value) => typeof value === "string")
    .findLast((value) => value.trim() !== "");
}

async function getUserOrThrow(params: {
  organizationId: string;
  userId: string;
}) {
  const user = await scimProvisioningService.getUser(params);
  if (!user) throw new ApiError(404, "User not found");
  return user;
}

/**
 * Apply what Archestra takes from a SCIM update: `active` (`false`
 * soft-deletes, `true` restores), and `userName` and `displayName` for a user
 * who has not signed in yet. A call that changed nothing is left out of the
 * audit log, and one that deactivated the user is recorded as
 * `member.soft_deleted` whatever its method.
 */
async function applyChanges(
  request: FastifyRequest,
  params: {
    userId: string;
    active: boolean | undefined;
    userName?: string;
    displayName?: string;
  },
) {
  const { organizationId } = request;
  const { userId, active } = params;
  const before = await getUserOrThrow({ organizationId, userId });
  // First, so that nothing below can keep the user active.
  if (active === false)
    await scimProvisioningService.softDeleteUser({ organizationId, userId });

  let profileChanged = false;
  if (params.userName !== undefined) {
    const result = await scimProvisioningService.changeUserName({
      organizationId,
      userId,
      userName: params.userName,
    });
    // A deactivation is never refused: the identity provider gets the
    // conflict when it next sends the userName alone.
    if (result === "exists" && active !== false)
      throw new ApiError(
        409,
        "A user with this userName already exists",
        "uniqueness",
      );
    profileChanged = result === "changed";
  }
  if (params.displayName !== undefined) {
    const result = await scimProvisioningService.changeDisplayName({
      organizationId,
      userId,
      displayName: params.displayName,
    });
    profileChanged ||= result === "changed";
  }
  if (active === true)
    await scimProvisioningService.restoreUser({ organizationId, userId });

  const user = await getUserOrThrow({ organizationId, userId });
  if (!profileChanged && user.active === before.active)
    request.auditSkip = true;
  else if (before.active && !user.active)
    request.auditAction = "member.soft_deleted";
  return user;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;
