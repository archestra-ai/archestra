import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { openappaBatteriesService } from "@/openappa/batteries";
import { openappaEnabled } from "@/openappa/service";
import { ApiError, constructResponseSchema } from "@/types";
import {
  BatteryMatchesSchema,
  BatteryPolicySourceSchema,
  BatterySummarySchema,
  CreateBatteryInstallSchema,
  EffectivePolicySchema,
  PolicyBatteryViewSchema,
  PolicyDeclarationsViewSchema,
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
  // Every write here edits the organization's policy text, so writes require
  // organization management as well as the endpoint permission. The policy
  // service gates the credential grants an edit would create on top of that.
  app.addHook("preHandler", async (request) => {
    if (!openappaEnabled())
      throw new ApiError(404, "Guardrails v2 is disabled");
    if (
      request.method !== "GET" &&
      !(await userHasPermission(
        request.user.id,
        request.organizationId,
        "organization",
        "update",
      ))
    )
      throw new ApiError(
        403,
        "Organization update permission is required to manage guardrails batteries",
      );
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
        response: constructResponseSchema(EffectivePolicySchema),
      },
    },
    async (request) =>
      openappaBatteriesService.getEffectivePolicy(request.organizationId),
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
    async (request) =>
      openappaBatteriesService.uploadPackage({
        userId: request.user.id,
        organizationId: request.organizationId,
        name: request.params.name,
        files: request.body.files,
      }),
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
