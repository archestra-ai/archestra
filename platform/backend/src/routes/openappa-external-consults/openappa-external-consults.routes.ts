import { Readable } from "node:stream";
import {
  CursorQuerySchema,
  createCursorPaginatedResponseSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { OpenappaExternalConsultModel } from "@/models";
import { constructResponseSchema } from "@/types";
import {
  type ExternalConsult,
  type ExternalConsultExport,
  ExternalConsultOutcomeSchema,
  ExternalConsultRoleSchema,
  ExternalConsultSchema,
} from "@/types/openappa-external-consults";

const JSONL_ROW_CAP = 10_000;
const ExportFormatSchema = z.enum(["json", "jsonl"]);

const QuerySchema = z
  .object({
    externalName: z.string().min(1).optional(),
    role: ExternalConsultRoleSchema.optional(),
    outcome: ExternalConsultOutcomeSchema.optional(),
    from: z.iso
      .datetime()
      .optional()
      .describe("Recorded on or after this time (ISO 8601)"),
    to: z.iso
      .datetime()
      .optional()
      .describe("Recorded on or before this time (ISO 8601)"),
    root: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    format: ExportFormatSchema.default("json").describe(
      `\`jsonl\` streams up to ${JSONL_ROW_CAP} rows as application/x-ndjson, one consult per line, ignoring \`limit\``,
    ),
  })
  .merge(CursorQuerySchema);

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/openappa/external-consults",
    {
      schema: {
        operationId: RouteId.GetOpenappaExternalConsults,
        description:
          "Export the external consults Guardrails recorded in the active organization, newest first. `log:read` returns the consults of the caller's own sessions. `log:admin` returns every consult in the organization. Byte fields are base64.",
        tags: ["OpenAPPA"],
        querystring: QuerySchema,
        response: constructResponseSchema(
          createCursorPaginatedResponseSchema(ExternalConsultSchema),
        ),
      },
    },
    async ({ query, user, organizationId }, reply) => {
      const { format, limit, cursor, from, to, ...rest } = query;
      // log:read scopes the export to the caller's own consults;
      // log:admin lifts it within the active organization.
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
      const filters = {
        ...rest,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        callerId: canSeeAllLogs ? undefined : `user:${user.id}`,
      };
      switch (format) {
        case "json": {
          const page = await OpenappaExternalConsultModel.findCursorPaginated({
            organizationId,
            filters,
            limit,
            cursor,
          });
          return reply.send({
            data: page.data.map(toExport),
            pagination: page.pagination,
          });
        }
        case "jsonl": {
          const rows = OpenappaExternalConsultModel.exportRows({
            organizationId,
            filters,
            max: JSONL_ROW_CAP,
            cursor,
          });
          // Fastify pipes a stream as is; the JSON response schema cannot
          // describe one, so the cast only steps past the schema's type.
          return reply
            .type("application/x-ndjson")
            .send(Readable.from(jsonLines(rows)) as never);
        }
      }
    },
  );
};
export default routes;

// === Internal ===

function toExport(row: ExternalConsult): ExternalConsultExport {
  return {
    ...row,
    rawResponse: base64(row.rawResponse),
    diagnostics: base64(row.diagnostics),
  };
}

// Drivers hand bytea back as a Buffer or a bare Uint8Array.
function base64(bytes: Uint8Array | null): string | null {
  return bytes ? Buffer.from(bytes).toString("base64") : null;
}

async function* jsonLines(
  rows: AsyncIterable<ExternalConsult>,
): AsyncGenerator<string> {
  for await (const row of rows) yield `${JSON.stringify(toExport(row))}\n`;
}
