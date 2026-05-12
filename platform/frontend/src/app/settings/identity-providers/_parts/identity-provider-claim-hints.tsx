import { IDENTITY_PROVIDER_ID } from "@shared";
import type { ReactNode } from "react";

type ClaimHint = {
  roleMappingNote: ReactNode;
  teamSyncNote: ReactNode;
};

export function getIdentityProviderClaimHint(
  providerId: string | undefined,
): ClaimHint | null {
  switch (providerId) {
    case IDENTITY_PROVIDER_ID.OKTA:
      return {
        roleMappingNote: (
          <>
            Okta group-based role rules commonly read the{" "}
            <HintCode>groups</HintCode> claim, for example{" "}
            <HintCode>
              {'{{#includes groups "group-name"}}true{{/includes}}'}
            </HintCode>
            .
          </>
        ),
        teamSyncNote: (
          <>
            Okta team sync commonly reads group names from the{" "}
            <HintCode>groups</HintCode> claim. Leave the template empty when
            Okta sends a flat <HintCode>groups</HintCode> array.
          </>
        ),
      };
    case IDENTITY_PROVIDER_ID.ENTRA_ID:
      return {
        roleMappingNote: (
          <>
            Microsoft Entra ID role rules commonly read{" "}
            <HintCode>roles</HintCode> for App role assignments, or{" "}
            <HintCode>groups</HintCode> for group membership. Prefer{" "}
            <HintCode>roles</HintCode> when you assign Entra App roles.
          </>
        ),
        teamSyncNote: (
          <>
            Microsoft Entra ID team sync commonly reads group identifiers from{" "}
            <HintCode>groups</HintCode>. Use <HintCode>roles</HintCode> only if
            you intentionally sync teams from Entra App roles.
          </>
        ),
      };
    default:
      return null;
  }
}

function HintCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-background/70 px-1 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}
