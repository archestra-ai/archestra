"use client";

import type { IdentityProviderFormValues } from "@archestra/shared";
import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { AllowedEmailDomainsField } from "./allowed-email-domains-field.ee";
import { RoleMappingForm } from "./role-mapping-form.ee";
import { SsoLoginEnabledField } from "./sso-login-enabled-field.ee";
import { TeamSyncConfigForm } from "./team-sync-config-form.ee";

interface SamlConfigFormProps {
  form: UseFormReturn<IdentityProviderFormValues>;
  identityProviderId?: string;
  activeSection?:
    | "general"
    | "service-provider-metadata"
    | "attribute-mapping"
    | "role-mapping"
    | "team-sync";
  /** Hide the Provider ID field (for predefined providers) */
  hideProviderId?: boolean;
}

export function SamlConfigForm({
  form,
  identityProviderId,
  activeSection,
  hideProviderId,
}: SamlConfigFormProps) {
  return (
    <div className="space-y-6">
      {(!activeSection || activeSection === "general") && (
        <div className="grid gap-4">
          {!hideProviderId && (
            <FormField
              control={form.control}
              name="providerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider ID</FormLabel>
                  <FormDescription>
                    Unique identifier for this identity provider. Used in
                    callback URLs.
                  </FormDescription>
                  <FormControl>
                    <Input placeholder="my-company-idp" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="issuer"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Issuer</FormLabel>
                <FormDescription>
                  The issuer URL of your identity provider.
                </FormDescription>
                <FormControl>
                  <Input placeholder="https://idp.company.com" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <SsoLoginEnabledField form={form} />
          <AllowedEmailDomainsField form={form} />

          <Separator />

          <div>
            <h4 className="text-md font-medium mb-4">SAML Settings</h4>
          </div>

          <FormField
            control={form.control}
            name="samlConfig.issuer"
            render={({ field }) => (
              <FormItem>
                <FormLabel>SAML Issuer / Entity ID</FormLabel>
                <FormDescription>
                  The Entity ID of your SAML Identity Provider.
                </FormDescription>
                <FormControl>
                  <Input
                    placeholder="https://idp.company.com/saml/metadata"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="samlConfig.entryPoint"
            render={({ field }) => (
              <FormItem>
                <FormLabel>SSO Entry Point URL</FormLabel>
                <FormDescription>
                  The Single Sign-On URL where users are redirected to
                  authenticate.
                </FormDescription>
                <FormControl>
                  <Input
                    placeholder="https://idp.company.com/saml/sso"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="samlConfig.cert"
            render={({ field }) => (
              <FormItem>
                <FormLabel>IdP Certificate</FormLabel>
                <FormDescription>
                  The X.509 certificate from your Identity Provider for
                  signature verification.
                </FormDescription>
                <FormControl>
                  <Textarea
                    placeholder="-----BEGIN CERTIFICATE-----&#10;MIIDdDCCAlygAwIBAgIGAXOvL...&#10;-----END CERTIFICATE-----"
                    className="font-mono text-xs min-h-[150px]"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="samlConfig.idpMetadata.metadata"
            render={({ field }) => (
              <FormItem>
                <FormLabel>IdP Metadata XML (Recommended)</FormLabel>
                <FormDescription>
                  The full IdP metadata XML from your Identity Provider. This is
                  the recommended way to configure SAML and includes all
                  necessary endpoints and certificates.
                </FormDescription>
                <FormControl>
                  <Textarea
                    placeholder="<?xml version='1.0'?>&#10;<md:EntityDescriptor>...</md:EntityDescriptor>"
                    className="font-mono text-xs min-h-[150px]"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="samlConfig.callbackUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Callback URL (ACS URL)</FormLabel>
                <FormDescription>
                  The Assertion Consumer Service URL where SAML responses are
                  sent.
                </FormDescription>
                <FormControl>
                  <Input
                    placeholder="https://your-app.com/api/auth/sso/callback/provider-id"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="samlConfig.audience"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Audience (Optional)</FormLabel>
                <FormDescription>
                  Expected audience value in SAML assertions.
                </FormDescription>
                <FormControl>
                  <Input placeholder="https://your-app.com" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      )}

      {!activeSection && <Separator />}

      {(!activeSection || activeSection === "service-provider-metadata") && (
        <div>
          <div className="grid gap-4">
            <FormField
              control={form.control}
              name="samlConfig.spMetadata.entityID"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>SP Entity ID</FormLabel>
                  <FormDescription>
                    Your application's Entity ID for SAML.
                  </FormDescription>
                  <FormControl>
                    <Input placeholder="https://your-app.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="samlConfig.spMetadata.metadata"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>SP Metadata XML (Optional)</FormLabel>
                  <FormDescription>
                    Your Service Provider metadata XML document.
                  </FormDescription>
                  <FormControl>
                    <Textarea
                      placeholder="<?xml version='1.0'?>&#10;<EntityDescriptor>...</EntityDescriptor>"
                      className="font-mono text-xs min-h-[100px]"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      )}

      {!activeSection && <Separator />}

      {(!activeSection || activeSection === "attribute-mapping") && (
        <div>
          <div className="grid gap-4">
            <FormField
              control={form.control}
              name="samlConfig.mapping.id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>User ID Attribute</FormLabel>
                  <FormDescription>
                    The SAML attribute that contains the unique user identifier.
                  </FormDescription>
                  <FormControl>
                    <Input
                      placeholder="urn:oid:0.9.2342.19200300.100.1.1"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="samlConfig.mapping.email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email Attribute</FormLabel>
                  <FormDescription>
                    The SAML attribute that contains the user's email address.
                  </FormDescription>
                  <FormControl>
                    <Input
                      placeholder="urn:oid:0.9.2342.19200300.100.1.3"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="samlConfig.mapping.name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Display Name Attribute</FormLabel>
                  <FormDescription>
                    The SAML attribute that contains the user's display name.
                  </FormDescription>
                  <FormControl>
                    <Input
                      placeholder="urn:oid:2.16.840.1.113730.3.1.241"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="samlConfig.mapping.firstName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>First Name Attribute (Optional)</FormLabel>
                  <FormDescription>
                    The SAML attribute that contains the user's first name.
                  </FormDescription>
                  <FormControl>
                    <Input placeholder="urn:oid:2.5.4.42" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="samlConfig.mapping.lastName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Last Name Attribute (Optional)</FormLabel>
                  <FormDescription>
                    The SAML attribute that contains the user's last name.
                  </FormDescription>
                  <FormControl>
                    <Input placeholder="urn:oid:2.5.4.4" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      )}

      {(!activeSection || activeSection === "role-mapping") && (
        <RoleMappingForm
          form={form}
          identityProviderId={identityProviderId}
          embedded={!!activeSection}
        />
      )}

      {(!activeSection || activeSection === "team-sync") && (
        <TeamSyncConfigForm
          form={form}
          identityProviderId={identityProviderId}
          embedded={!!activeSection}
        />
      )}
    </div>
  );
}
