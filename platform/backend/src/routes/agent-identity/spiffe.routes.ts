// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  SPIFFE_BUNDLE_PATH,
  SPIFFE_DISCOVERY_PATH,
  SPIFFE_JWKS_PATH,
} from "@/routes/route-paths";
import { spiffeIssuer } from "@/services/identity-providers/enterprise-managed/spiffe-issuer";
import { constructResponseSchema } from "@/types";

/**
 * The public face of Archestra's issuer of agents' JWT-SVIDs: what a verifier
 * (an identity provider, a SPIRE server, a service mesh) reads to trust them.
 * Public by design, and they hold only public keys.
 */
const spiffeRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    SPIFFE_DISCOVERY_PATH,
    {
      schema: {
        operationId: RouteId.GetSpiffeDiscoveryDocument,
        description:
          "OIDC discovery document of the issuer of agents' SPIFFE JWT-SVIDs. Point a verifier that trusts OIDC issuers here.",
        tags: ["Agent Identity"],
        response: constructResponseSchema(SpiffeDiscoveryDocumentSchema),
      },
    },
    async (_request, reply) =>
      reply
        .header("Cache-Control", CACHE_CONTROL)
        .send(spiffeIssuer.discoveryDocument()),
  );

  fastify.get(
    SPIFFE_JWKS_PATH,
    {
      schema: {
        operationId: RouteId.GetSpiffeJwks,
        description:
          "Public keys that sign agents' SPIFFE JWT-SVIDs, as a JSON Web Key Set.",
        tags: ["Agent Identity"],
        response: constructResponseSchema(KeySetSchema),
      },
    },
    async (_request, reply) =>
      reply
        .header("Cache-Control", CACHE_CONTROL)
        .send(await spiffeIssuer.jwks()),
  );

  fastify.get(
    SPIFFE_BUNDLE_PATH,
    {
      schema: {
        operationId: RouteId.GetSpiffeTrustBundle,
        description:
          "SPIFFE trust bundle of the agents' trust domain, for SPIFFE federation (https_web profile).",
        tags: ["Agent Identity"],
        response: constructResponseSchema(
          KeySetSchema.extend({ spiffe_refresh_hint: z.number() }),
        ),
      },
    },
    async (_request, reply) =>
      reply
        .header("Cache-Control", CACHE_CONTROL)
        .send(await spiffeIssuer.trustBundle()),
  );
};

export default spiffeRoutes;

// === Internal helpers

const CACHE_CONTROL = "public, max-age=60";

const SpiffeDiscoveryDocumentSchema = z.object({
  issuer: z.string(),
  jwks_uri: z.string(),
  id_token_signing_alg_values_supported: z.array(z.string()),
  response_types_supported: z.array(z.string()),
  subject_types_supported: z.array(z.string()),
});

const KeySetSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});
