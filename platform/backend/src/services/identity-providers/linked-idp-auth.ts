import { LINKED_IDP_SSO_MODE } from "@shared";
import { z } from "zod";
import db, { type Transaction } from "@/database";
import logger from "@/logging";
import {
  AccountModel,
  MemberModel,
  SessionModel,
  UserModel,
  VerificationModel,
} from "@/models";
import { ApiError } from "@/types";

const LINKED_IDP_INTENT_TTL_MS = 10 * 60 * 1000;
const LINKED_IDP_INTENT_PREFIX = LINKED_IDP_SSO_MODE;

const LinkedIdentityProviderIntentSchema = z.object({
  originalUserId: z.string(),
  originalSessionId: z.string(),
  providerId: z.string(),
  redirectTo: z.string(),
  createdAt: z.string(),
});

type LinkedIdentityProviderIntent = z.infer<
  typeof LinkedIdentityProviderIntentSchema
>;

export async function createLinkedIdentityProviderIntent(params: {
  originalUserId: string;
  originalSessionId: string;
  providerId: string;
  redirectTo: string;
}) {
  const redirectTo = normalizeRedirectPath(params.redirectTo);
  const intentId = crypto.randomUUID();
  const intent: LinkedIdentityProviderIntent = {
    originalUserId: params.originalUserId,
    originalSessionId: params.originalSessionId,
    providerId: params.providerId,
    redirectTo,
    createdAt: new Date().toISOString(),
  };

  await VerificationModel.create({
    identifier: getLinkedIdentityProviderIntentIdentifier(intentId),
    value: JSON.stringify(intent),
    expiresAt: new Date(Date.now() + LINKED_IDP_INTENT_TTL_MS),
  });

  return { intentId, redirectTo };
}

export async function completeLinkedIdentityProviderIntent(params: {
  intentId: string;
  currentUserId: string;
  currentSessionId: string;
}) {
  return await db.transaction(async (tx) => {
    const identifier = getLinkedIdentityProviderIntentIdentifier(
      params.intentId,
    );
    const verification = await VerificationModel.getByIdentifier(
      identifier,
      tx,
    );

    if (!verification) {
      throw new ApiError(400, "Linked identity provider request not found");
    }

    if (verification.expiresAt < new Date()) {
      await VerificationModel.deleteByIdentifier(identifier, tx);
      throw new ApiError(400, "Linked identity provider request expired");
    }

    const intent = parseLinkedIdentityProviderIntent(verification.value);
    const [originalSession] = await SessionModel.getById(
      intent.originalSessionId,
      tx,
    );

    if (
      !originalSession ||
      originalSession.userId !== intent.originalUserId ||
      originalSession.expiresAt < new Date()
    ) {
      await VerificationModel.deleteByIdentifier(identifier, tx);
      throw new ApiError(400, "Original session is no longer available");
    }

    const currentProviderAccount =
      await AccountModel.getLatestSsoAccountByUserIdAndProviderId(
        params.currentUserId,
        intent.providerId,
        tx,
      );
    const originalProviderAccount =
      await AccountModel.getLatestSsoAccountByUserIdAndProviderId(
        intent.originalUserId,
        intent.providerId,
        tx,
      );

    if (currentProviderAccount) {
      if (currentProviderAccount.userId !== intent.originalUserId) {
        await AccountModel.deleteByUserIdAndProviderId({
          userId: intent.originalUserId,
          providerId: intent.providerId,
          tx,
        });
        await AccountModel.moveToUser({
          id: currentProviderAccount.id,
          userId: intent.originalUserId,
          tx,
        });
      }
    } else if (!originalProviderAccount) {
      throw new ApiError(400, "Linked identity provider account not found");
    }

    if (params.currentSessionId !== intent.originalSessionId) {
      await SessionModel.deleteById(params.currentSessionId, tx);
    }

    if (params.currentUserId !== intent.originalUserId) {
      await cleanupTemporaryLinkedIdentityUser(params.currentUserId, tx);
    }

    await VerificationModel.deleteByIdentifier(identifier, tx);
    logger.info(
      {
        providerId: intent.providerId,
        originalUserId: intent.originalUserId,
      },
      "[linked-idp-auth] Linked identity provider account to original session",
    );

    return {
      originalSessionToken: originalSession.token,
      redirectTo: intent.redirectTo,
    };
  });
}

async function cleanupTemporaryLinkedIdentityUser(
  userId: string,
  tx: Transaction,
) {
  const accountCount = await AccountModel.countByUserId(userId, tx);
  if (accountCount > 0) {
    return;
  }

  await MemberModel.deleteAllByUserId(userId, tx);
  await UserModel.delete(userId, tx);
}

function getLinkedIdentityProviderIntentIdentifier(intentId: string) {
  return `${LINKED_IDP_INTENT_PREFIX}:${intentId}`;
}

function parseLinkedIdentityProviderIntent(value: string) {
  try {
    return LinkedIdentityProviderIntentSchema.parse(JSON.parse(value));
  } catch {
    throw new ApiError(400, "Linked identity provider request is invalid");
  }
}

function normalizeRedirectPath(redirectTo: string) {
  if (
    redirectTo.startsWith("/") &&
    !redirectTo.startsWith("//") &&
    !redirectTo.includes("\\")
  ) {
    return redirectTo;
  }

  return "/chat";
}
