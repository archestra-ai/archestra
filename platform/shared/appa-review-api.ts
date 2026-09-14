import { client } from "./hey-api/clients/api/client.gen";

export type AppaApprovalReviewApi = {
  id: string;
  candidateCallId: string;
  tool: string;
  args: Record<string, unknown>;
  argumentsSha256: string;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  expiresAt: string;
  approverId: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type AppaQuarantineReviewApi = {
  id: string;
  profileId: string;
  createdAt: string;
  updatedAt: string;
};

export type AppaQuarantineDetailApi = AppaQuarantineReviewApi & {
  actions: Array<{
    callRef: string;
    tool: string;
    state:
      | "authorization_intent"
      | "open"
      | "result_intent"
      | "result_admitted"
      | "denied";
    outcome: "success" | "failure" | "indeterminate" | null;
    createdAt: string;
    updatedAt: string;
  }>;
};

type ApiResult<T> = Promise<{ data?: T; error?: unknown }>;

// These routes are intentionally kept outside the generated namespace until
// backend OpenAPI generation can complete in an environment with all startup
// dependencies. They still use the generated client's configured transport.
export function listAppaApprovals(): ApiResult<AppaApprovalReviewApi[]> {
  return client.get({ url: "/api/appa-approvals" }) as ApiResult<
    AppaApprovalReviewApi[]
  >;
}

export function getAppaApproval(params: {
  path: { id: string };
}): ApiResult<AppaApprovalReviewApi> {
  return client.get({
    url: "/api/appa-approvals/{id}",
    ...params,
  }) as ApiResult<AppaApprovalReviewApi>;
}

export function decideAppaApproval(params: {
  path: { id: string };
  body: { decision: "approve" | "deny" };
}): ApiResult<AppaApprovalReviewApi> {
  return client.post({
    url: "/api/appa-approvals/{id}/decision",
    ...params,
  }) as ApiResult<AppaApprovalReviewApi>;
}

export function listAppaQuarantines(): ApiResult<AppaQuarantineReviewApi[]> {
  return client.get({ url: "/api/appa-quarantines" }) as ApiResult<
    AppaQuarantineReviewApi[]
  >;
}

export function getAppaQuarantine(params: {
  path: { id: string };
}): ApiResult<AppaQuarantineDetailApi> {
  return client.get({
    url: "/api/appa-quarantines/{id}",
    ...params,
  }) as ApiResult<AppaQuarantineDetailApi>;
}

export function acknowledgeAppaQuarantine(params: {
  path: { id: string };
  body: { acknowledgment: "acknowledged" | "reconciled" };
}): ApiResult<{
  quarantine: AppaQuarantineReviewApi;
  acknowledgment: "acknowledged" | "reconciled";
  acknowledgedAt: string;
}> {
  return client.post({
    url: "/api/appa-quarantines/{id}/acknowledgment",
    ...params,
  }) as ApiResult<{
    quarantine: AppaQuarantineReviewApi;
    acknowledgment: "acknowledged" | "reconciled";
    acknowledgedAt: string;
  }>;
}
