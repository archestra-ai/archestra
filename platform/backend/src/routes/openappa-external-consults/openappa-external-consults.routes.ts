import { Readable } from "node:stream";
import {
  CursorQuerySchema,
  createCursorPaginatedResponseSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  exportExternalConsults,
  externalConsultAccess,
  findExternalConsult,
  listExternalConsults,
} from "@/services/openappa-external-consults";
import { ApiError, constructResponseSchema } from "@/types";
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
    llmSessionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "An LLM session ID, as on the LLM logs page: consults from every trajectory of that session, sub-agents included",
      ),
    search: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Case-insensitive substring of the external's name or the session ID",
      ),
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
          "Export the external consults Guardrails recorded in the active organization, newest first. `openappaDiagnostics:read` returns the consults of the caller's own sessions. `openappaDiagnostics:admin` returns every consult in the organization. An audience source's consult names people, so its `request`, `answer`, `rawResponse` and `diagnostics` are null for a caller without `member:read`. Byte fields are base64.",
        tags: ["OpenAPPA"],
        querystring: QuerySchema,
        response: constructResponseSchema(
          createCursorPaginatedResponseSchema(ExternalConsultSchema),
        ),
      },
    },
    async ({ query, user, organizationId }, reply) => {
      const { format, limit, cursor, from, to, ...rest } = query;
      const access = await externalConsultAccess({
        userId: user.id,
        organizationId,
      });
      const consultQuery = {
        ...rest,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      };
      switch (format) {
        case "json": {
          const page = await listExternalConsults({
            organizationId,
            access,
            query: consultQuery,
            limit,
            cursor,
          });
          return reply.send({
            data: page.data.map(toExport),
            pagination: page.pagination,
          });
        }
        case "jsonl": {
          const rows = exportExternalConsults({
            organizationId,
            access,
            query: consultQuery,
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
  app.get(
    "/api/openappa/external-consults/:id",
    {
      schema: {
        operationId: RouteId.GetOpenappaExternalConsult,
        description:
          "One external consult Guardrails recorded, with where it happened: `llmSessionId` is the LLM session it belongs to and `mcpToolCallId` the logged tool call it was raised for, each null when not logged. Access is as for the list.",
        tags: ["OpenAPPA"],
        params: z.object({ id: z.string().min(1) }),
        response: constructResponseSchema(
          z.object({
            consult: ExternalConsultSchema,
            llmSessionId: z.string().nullable(),
            mcpToolCallId: z.string().nullable(),
          }),
        ),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      const access = await externalConsultAccess({
        userId: user.id,
        organizationId,
      });
      const found = await findExternalConsult({
        organizationId,
        access,
        id: params.id,
      });
      if (!found) throw new ApiError(404, "Consult not found");
      return reply.send({ ...found, consult: toExport(found.consult) });
    },
  );
};
export default routes;

// === Internal ===

/** A stored consult as the export serves it: byte columns as base64. */
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
