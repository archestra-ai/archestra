"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import { formatSpendCap } from "@/components/credential-billing/budget-fields";
import {
  ReviewList,
  ReviewListRow,
} from "@/components/credential-billing/review-list";
import {
  type OAuthClientFormValues,
  oauthCapabilities,
} from "@/components/oauth-client/configuration-fields";
import { useServiceAccounts } from "@/lib/service-account.query";
import { useTeams } from "@/lib/teams/team.query";

/**
 * The last step of creating an OAuth client: every choice, each with a way
 * back to the step that set it. `onEdit("access", true)` opens that step with
 * its advanced settings expanded.
 */
export function OAuthClientReview({
  values,
  gateways,
  providerApiKeys,
  onEdit,
}: {
  values: OAuthClientFormValues;
  gateways: AgentSelectorAgent[];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onEdit: (step: "details" | "access", advanced?: boolean) => void;
}) {
  const userMode = values.grantType === "authorization_code";
  const llm = values.scopes.includes("llm:proxy");
  return (
    <ReviewList>
      <ReviewListRow label="Name" onEdit={() => onEdit("details")}>
        <span>{values.name}</span>
      </ReviewListRow>
      <ReviewListRow label="API access" onEdit={() => onEdit("details")}>
        <span>
          {oauthCapabilities
            .filter((item) => values.scopes.includes(item.scope))
            .map((item) => item.label)
            .join(", ")}
        </span>
      </ReviewListRow>
      <ReviewListRow label="Signs in" onEdit={() => onEdit("details")}>
        <span>{userMode ? "For its users" : "As itself"}</span>
      </ReviewListRow>
      {!userMode && (
        <ReviewListRow
          label="Service account"
          onEdit={() => onEdit("access", true)}
        >
          <span>
            {values.serviceAccountId ? (
              <AccountName id={values.serviceAccountId} />
            ) : (
              <span>No service account</span>
            )}
          </span>
        </ReviewListRow>
      )}
      {userMode && (
        <ReviewListRow label="Redirect URIs" onEdit={() => onEdit("access")}>
          <span className="whitespace-pre-line break-all">
            {values.redirectUrisText}
          </span>
        </ReviewListRow>
      )}
      {llm && (
        <ReviewListRow label="Budget" onEdit={() => onEdit("access", true)}>
          <span>
            {userMode ? (
              <span>Each user pays</span>
            ) : values.billingTeamId ? (
              <BillingTeamName id={values.billingTeamId} />
            ) : (
              <span>No billing team</span>
            )}
            {" · "}
            {values.spendCap ? formatSpendCap(values.spendCap) : "No spend cap"}
          </span>
        </ReviewListRow>
      )}
      {values.allowedGatewayIds?.length ? (
        <ReviewListRow
          label="Gateways & agents"
          onEdit={() => onEdit("access")}
        >
          <span>
            {values.allowedGatewayIds
              .map((id) => gateways.find((item) => item.id === id)?.name ?? id)
              .join(", ")}
          </span>
        </ReviewListRow>
      ) : null}
      {llm && !userMode && (
        <ReviewListRow label="Provider keys" onEdit={() => onEdit("access")}>
          <span>
            {values.includeFutureProviders
              ? "Current and future providers"
              : values.providerApiKeys
                  ?.map(
                    (mapping) =>
                      providerApiKeys.find(
                        (key) => key.id === mapping.providerApiKeyId,
                      )?.name ?? mapping.provider,
                  )
                  .join(", ")}
          </span>
        </ReviewListRow>
      )}
    </ReviewList>
  );
}

// === Internal helpers

function AccountName({ id }: { id: string }) {
  const { data: accounts = [] } = useServiceAccounts();
  return (
    accounts.find((account) => account.id === id)?.name ??
    "Selected service account"
  );
}

function BillingTeamName({ id }: { id: string }) {
  const { data: teams = [] } = useTeams({ includeRelations: false });
  return teams.find((team) => team.id === id)?.name ?? "Selected billing team";
}
