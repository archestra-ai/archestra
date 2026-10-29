// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { emailMatchesAllowedIdentityProviderDomains } from "@archestra/shared";
import type { HookEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth";
import { enterpriseTier } from "@/enterprise-tier";
import IdentityProviderModel from "@/models/identity-provider.ee";
import SsoPendingUserModel from "@/models/sso-pending-user.ee";
import UserModel from "@/models/user";
import { openappaBatteriesService } from "@/openappa/batteries";

/**
 * Only the verified SSO callback may reconcile a pending Teams user. Copy the
 * adapter per request: changing the global adapter would affect other logins.
 * Better Auth calls updateUser after it has validated the IdP response and
 * resolved the linked provider/subject to the existing user's immutable ID.
 */
export function withSsoEmailReconciliation(ctx: HookEndpointContext) {
  if (!enterpriseTier.isCoreActive() || !ctx.request) return;
  const path = new URL(ctx.request.url).pathname;
  const match = path.match(/\/sso\/callback\/([^/]+)$/);
  if (!match) return;
  const providerId = decodeURIComponent(match[1]);
  const adapter = ctx.context.internalAdapter;
  return {
    ...adapter,
    updateUser: async (...args: Parameters<typeof adapter.updateUser>) => {
      const [userId, data] = args;
      let reconciledOrganizationId: string | undefined;
      if (typeof data.email === "string") {
        const user = await UserModel.getById(userId);
        const email = data.email.toLowerCase();
        if (user && user.email !== email) {
          const provider =
            await IdentityProviderModel.findByProviderId(providerId);
          if (
            !provider ||
            provider.ssoLoginEnabled === false ||
            !provider.organizationId ||
            (provider.domain &&
              !emailMatchesAllowedIdentityProviderDomains(
                email,
                provider.domain,
              ))
          ) {
            throw new APIError("FORBIDDEN", {
              code: "SSO_EMAIL_NOT_ALLOWED",
              message:
                "Your email domain is not allowed for this identity provider.",
            });
          }
          const collision = await UserModel.findByEmail(email);
          if (collision && collision.id !== userId) {
            // A linked subject proves the person signing in, but an email
            // collision also needs the new email to be asserted as verified
            // or trusted through the provider's configured verified domain.
            const trustedEmail =
              data.emailVerified === true ||
              (provider.domainVerified === true && Boolean(provider.domain));
            const result = trustedEmail
              ? await SsoPendingUserModel.reconcile({
                  userId,
                  email,
                  providerId,
                  organizationId: provider.organizationId,
                  requestPath: path,
                })
              : "conflict";
            if (result === "reconciled")
              reconciledOrganizationId = provider.organizationId;
            if (result === "conflict")
              throw new APIError("CONFLICT", {
                code: "SSO_EMAIL_CONFLICT",
                message:
                  "This email belongs to another account and cannot be linked automatically. Contact your administrator.",
              });
          }
        }
      }
      const updated = await adapter.updateUser(...args);
      // Reconciliation changes the email atomically before the adapter hook
      // can detect it, so refresh the host member roster explicitly here.
      if (reconciledOrganizationId)
        await openappaBatteriesService.recompileOrganizations([
          reconciledOrganizationId,
        ]);
      return updated;
    },
  };
}
