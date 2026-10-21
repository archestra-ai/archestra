import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { openappaBatteriesService } from "@/openappa/batteries";
import { openappaEnabled } from "@/openappa/service";
import { ApiError, constructResponseSchema } from "@/types";
import {
  BatteryInstallSchema,
  BatteryMatchesSchema,
  BatteryPolicySourceSchema,
  BatterySummarySchema,
  CreateBatteryInstallSchema,
  CredentialBindingParamsSchema,
  CredentialBindingViewSchema,
  EffectivePolicyViewSchema,
  PolicyBatteryViewSchema,
  PolicyDeclarationsViewSchema,
  SetCredentialBindingSchema,
  UpdateBatteryInstallSchema,
  UploadBatteryPackageSchema,
  UploadedBatteryPackageSchema,
} from "@/types/openappa-batteries";

const InstallParamsSchema = z.object({ id: z.uuid() });
const PackageNameParamsSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
});
const PackageHashParamsSchema = z.object({
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
const MatchesQuerySchema = z.object({ catalogId: z.uuid() });
const PolicySourceQuerySchema = z.object({ entry: z.string().min(1).max(512) });
const DeletedSchema = z.object({ success: z.literal(true) });

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", async () => {
    if (!openappaEnabled())
      throw new ApiError(404, "Guardrails v2 is disabled");
  });
  app.get(
    "/api/openappa/batteries",
    {
      schema: {
        operationId: RouteId.GetOpenappaBatteries,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(z.array(BatterySummarySchema)),
      },
    },
    async (request) =>
      openappaBatteriesService.listBatteries(request.organizationId),
  );
  app.get(
    "/api/openappa/policy-declarations",
    {
      schema: {
        operationId: RouteId.GetOpenappaPolicyDeclarations,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(PolicyDeclarationsViewSchema),
      },
    },
    async (request) =>
      openappaBatteriesService.policyDeclarations(request.organizationId),
  );
  app.get(
    "/api/openappa/battery-policy-source",
    {
      schema: {
        operationId: RouteId.GetOpenappaBatteryPolicySource,
        tags: ["OpenAPPA"],
        querystring: PolicySourceQuerySchema,
        response: constructResponseSchema(BatteryPolicySourceSchema),
      },
    },
    async (request) =>
      openappaBatteriesService.policySource(
        request.organizationId,
        request.query.entry,
      ),
  );
  app.get(
    "/api/openappa/effective-policy",
    {
      schema: {
        operationId: RouteId.GetOpenappaEffectivePolicy,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(EffectivePolicyViewSchema),
      },
    },
    async (request) =>
      openappaBatteriesService.effectivePolicyView(request.organizationId),
  );
  app.get(
    "/api/openappa/battery-matches",
    {
      schema: {
        operationId: RouteId.GetOpenappaBatteryMatches,
        tags: ["OpenAPPA"],
        querystring: MatchesQuerySchema,
        response: constructResponseSchema(BatteryMatchesSchema),
      },
    },
    async (request) =>
      openappaBatteriesService.matchesForCatalog({
        organizationId: request.organizationId,
        catalogId: request.query.catalogId,
      }),
  );
  app.post(
    "/api/openappa/battery-installs",
    {
      schema: {
        operationId: RouteId.CreateOpenappaBatteryInstall,
        tags: ["OpenAPPA"],
        body: CreateBatteryInstallSchema,
        response: constructResponseSchema(PolicyBatteryViewSchema),
      },
    },
    async (request) => {
      const { battery, installId } =
        await openappaBatteriesService.createInstall({
          userId: request.user.id,
          organizationId: request.organizationId,
          install: request.body,
        });
      // The response is the declaration, which has no row id of its own, so the
      // audit record is told which row the write produced.
      request.auditResourceId = { value: installId ?? battery.name };
      return battery;
    },
  );
  app.get(
    "/api/openappa/battery-installs/:id",
    {
      schema: {
        operationId: RouteId.GetOpenappaBatteryInstall,
        description:
          "Get one battery install as the last composition stored it, without recomposing; an install whose battery is no longer available is still returned, with status `unavailable`, though the battery list omits it.",
        tags: ["OpenAPPA"],
        params: InstallParamsSchema,
        response: constructResponseSchema(BatteryInstallSchema),
      },
    },
    async (request) =>
      openappaBatteriesService.getInstall({
        organizationId: request.organizationId,
        id: request.params.id,
      }),
  );
  app.patch(
    "/api/openappa/battery-installs/:id",
    {
      schema: {
        operationId: RouteId.UpdateOpenappaBatteryInstall,
        tags: ["OpenAPPA"],
        params: InstallParamsSchema,
        body: UpdateBatteryInstallSchema,
        response: constructResponseSchema(PolicyBatteryViewSchema),
      },
    },
    async (request) => {
      const { battery, installId } =
        await openappaBatteriesService.updateInstall({
          userId: request.user.id,
          organizationId: request.organizationId,
          id: request.params.id,
          changes: request.body,
        });
      // An update that unbinds the last catalog leaves no row to name, so the
      // record falls back to the battery the declaration is for.
      request.auditResourceId = { value: installId ?? battery.name };
      return battery;
    },
  );
  app.delete(
    "/api/openappa/battery-installs/:id",
    {
      schema: {
        operationId: RouteId.DeleteOpenappaBatteryInstall,
        tags: ["OpenAPPA"],
        params: InstallParamsSchema,
        response: constructResponseSchema(DeletedSchema),
      },
    },
    async (request) => {
      await openappaBatteriesService.deleteInstall({
        userId: request.user.id,
        organizationId: request.organizationId,
        id: request.params.id,
      });
      return { success: true as const };
    },
  );
  app.delete(
    "/api/openappa/battery-includes/:name",
    {
      schema: {
        operationId: RouteId.DeleteOpenappaBatteryInclude,
        tags: ["OpenAPPA"],
        params: PackageNameParamsSchema,
        response: constructResponseSchema(DeletedSchema),
      },
    },
    async (request) => {
      await openappaBatteriesService.removeInclude({
        userId: request.user.id,
        organizationId: request.organizationId,
        name: request.params.name,
      });
      return { success: true as const };
    },
  );
  app.get(
    "/api/openappa/credential-bindings",
    {
      schema: {
        operationId: RouteId.GetOpenappaCredentialBindings,
        description:
          "List the stored credential bindings; credential values are never returned.",
        tags: ["OpenAPPA"],
        response: constructResponseSchema(z.array(CredentialBindingViewSchema)),
      },
    },
    async (request) =>
      openappaBatteriesService.listCredentialBindings(request.organizationId),
  );
  app.get(
    "/api/openappa/credential-bindings/:variable",
    {
      schema: {
        operationId: RouteId.GetOpenappaCredentialBinding,
        description:
          "Get one stored credential binding; the credential value is never returned.",
        tags: ["OpenAPPA"],
        params: CredentialBindingParamsSchema,
        response: constructResponseSchema(CredentialBindingViewSchema),
      },
    },
    async (request) =>
      openappaBatteriesService.getCredentialBinding({
        organizationId: request.organizationId,
        variable: request.params.variable,
      }),
  );
  app.put(
    "/api/openappa/credential-bindings/:variable",
    {
      schema: {
        operationId: RouteId.SetOpenappaCredentialBinding,
        tags: ["OpenAPPA"],
        params: CredentialBindingParamsSchema,
        body: SetCredentialBindingSchema,
        response: constructResponseSchema(PolicyDeclarationsViewSchema),
      },
    },
    async (request) =>
      openappaBatteriesService.setCredentialBinding({
        userId: request.user.id,
        organizationId: request.organizationId,
        variable: request.params.variable,
        key: request.body.key,
      }),
  );
  app.put(
    "/api/openappa/battery-packages/:name",
    {
      schema: {
        operationId: RouteId.UploadOpenappaBatteryPackage,
        tags: ["OpenAPPA"],
        params: PackageNameParamsSchema,
        body: UploadBatteryPackageSchema,
        response: constructResponseSchema(UploadedBatteryPackageSchema),
      },
    },
    // Only the batteries Archestra ships are supported for now.
    async (): Promise<never> => {
      throw new ApiError(501, "Uploading battery packages is not supported");
    },
  );
  app.delete(
    "/api/openappa/battery-packages/:contentHash",
    {
      schema: {
        operationId: RouteId.DeleteOpenappaBatteryPackage,
        tags: ["OpenAPPA"],
        params: PackageHashParamsSchema,
        response: constructResponseSchema(DeletedSchema),
      },
    },
    async (request) => {
      await openappaBatteriesService.deletePackage({
        organizationId: request.organizationId,
        contentHash: request.params.contentHash,
      });
      return { success: true as const };
    },
  );
};
export default routes;
