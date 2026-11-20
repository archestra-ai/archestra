"use client";

import { Server, Users } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import { useWatch } from "react-hook-form";
import { IdentityFields } from "@/components/identity-fields";
import { ChoiceCards } from "@/components/oauth-client/choice-cards";
import {
  type OAuthClientFormValues,
  OAuthClientScopePicker,
  type useOauthClientScopeChange,
} from "@/components/oauth-client/configuration-fields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The first step of creating an OAuth client, in the dialog and on the create
 * page alike: its name, the APIs it reaches, and how it signs in.
 */
export function OAuthClientBasicsFields({
  form,
  scopeChange,
}: {
  form: UseFormReturn<OAuthClientFormValues>;
  scopeChange: ReturnType<typeof useOauthClientScopeChange>;
}) {
  const scopes = useWatch({ control: form.control, name: "scopes" });
  const grantType = useWatch({ control: form.control, name: "grantType" });
  const icon = useWatch({ control: form.control, name: "icon" });
  return (
    <div className="space-y-5">
      <IdentityFields
        icon={icon ?? null}
        onIconChange={(next) =>
          form.setValue("icon", next, { shouldDirty: true })
        }
        fallbackType="app"
        label={<Label htmlFor="oauth-client-name">Name</Label>}
      >
        <Input
          id="oauth-client-name"
          placeholder="support-assistant-prod"
          autoComplete="off"
          data-1p-ignore
          {...form.register("name")}
          autoFocus
        />
      </IdentityFields>
      <OAuthClientScopePicker
        value={scopes}
        onChange={scopeChange.change}
        disabled={scopeChange.isPending || form.formState.isSubmitting}
      />
      <ChoiceCards
        label="How does it sign in?"
        idPrefix="oauth-client-signin"
        value={grantType ?? "client_credentials"}
        onValueChange={(value: "client_credentials" | "authorization_code") =>
          form.setValue("grantType", value, { shouldDirty: true })
        }
        options={[
          {
            value: "client_credentials",
            title: "As itself",
            description:
              "A service or bot uses its own credentials: a client secret, or a workload's OIDC token.",
            icon: <Server className="size-4" />,
          },
          {
            value: "authorization_code",
            title: "For its users",
            description: "An app signs users in and acts with their identity.",
            icon: <Users className="size-4" />,
          },
        ]}
      />
    </div>
  );
}
