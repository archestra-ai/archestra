import type { FastifyRequest } from "fastify";
import type { InsertAuditLog } from "@/types";
import { AuditLogModel } from "@/models";

class AuditLogService {
  async record(params: {
    organizationId: string;
    userId: string | null;
    action: string;
    resource: string;
    resourceId?: string | null;
    metadata?: {
      ip?: string | null;
      userAgent?: string | null;
      diff?: Record<string, unknown> | null;
    };
    request?: FastifyRequest;
  }) {
    const { organizationId, userId, action, resource, resourceId, metadata, request } = params;

    const insertData: InsertAuditLog = {
      organizationId,
      userId,
      action,
      resource,
      resourceId: resourceId ?? null,
      metadata: {
        ip: metadata?.ip ?? (request ? this.extractIp(request) : null),
        userAgent: metadata?.userAgent ?? (request ? this.extractUserAgent(request) : null),
        diff: metadata?.diff ?? null,
      },
    };

    return AuditLogModel.create(insertData);
  }

  private extractIp(request: FastifyRequest): string | null {
    const forwarded = request.headers["x-forwarded-for"];
    if (forwarded) {
      return (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")[0].trim();
    }
    const realIp = request.headers["x-real-ip"];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }
    return request.ip || null;
  }

  private extractUserAgent(request: FastifyRequest): string | null {
    const ua = request.headers["user-agent"];
    return ua ? (Array.isArray(ua) ? ua[0] : ua) : null;
  }
}

const auditLogService = new AuditLogService();
export default auditLogService;
