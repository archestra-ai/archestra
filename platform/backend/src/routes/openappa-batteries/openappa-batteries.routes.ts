import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { openappaBatteriesService } from "@/openappa/batteries";
import { openappaEnabled } from "@/openappa/service";
import { ApiError, constructResponseSchema } from "@/types";
import {
  BatteryInstallViewSchema,
  BatterySummarySchema,
  CreateBatteryInstallSchema,
  EffectivePolicySchema,
  UpdateBatteryInstallSchema,
  UploadBatteryPackageSchema,
} from "@/types/openappa-batteries";

const InstallParamsSchema = z.object({ id: z.uuid() });
const PackageParamsSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
});
const DeletedSchema = z.object({ success: z.literal(true) });

const routes: FastifyPluginAsyncZod = async (app) => {
  // Installing a battery changes organization policy, so writes require
  // organization management as well as the endpoint permission.
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
  app.post(
    "/api/openappa/battery-installs",
    {
      schema: {
        operationId: RouteId.CreateOpenappaBatteryInstall,
        tags: ["OpenAPPA"],
        body: CreateBatteryInstallSchema,
        response: constructResponseSchema(BatteryInstallViewSchema),
      },
    },
    async (request) =>
      openappaBatteriesService.createInstall({
        organizationId: request.organizationId,
        install: request.body,
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
        response: constructResponseSchema(BatteryInstallViewSchema),
      },
    },
    async (request) =>
      openappaBatteriesService.updateInstall({
        organizationId: request.organizationId,
        id: request.params.id,
        changes: request.body,
      }),
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
        organizationId: request.organizationId,
        id: request.params.id,
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
        params: PackageParamsSchema,
        body: UploadBatteryPackageSchema,
        response: constructResponseSchema(BatterySummarySchema),
      },
    },
    async (request) =>
      openappaBatteriesService.uploadPackage({
        organizationId: request.organizationId,
        name: request.params.name,
        files: request.body.files,
      }),
  );
  app.delete(
    "/api/openappa/battery-packages/:name",
    {
      schema: {
        operationId: RouteId.DeleteOpenappaBatteryPackage,
        tags: ["OpenAPPA"],
        params: PackageParamsSchema,
        response: constructResponseSchema(DeletedSchema),
      },
    },
    async (request) => {
      await openappaBatteriesService.deletePackage({
        organizationId: request.organizationId,
        name: request.params.name,
      });
      return { success: true as const };
    },
  );
};
export default routes;
