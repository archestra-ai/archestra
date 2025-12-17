"use client";

import type { SsoProviderFormValues } from "@shared";
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
import { RoleMappingForm } from "./role-mapping-form.ee";
import { TeamSyncConfigForm } from "./team-sync-config-form.ee";

interface SamlConfigFormProps {
  form: UseFormReturn<SsoProviderFormValues>;
  /** Hide the Provider ID field (for predefined providers) */
  hideProviderId?: boolean;
}

export function SamlConfigForm({ form, hideProviderId }: SamlConfigFormProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">SSO Provider Configuration</h3>
        <p className="text-sm text-muted-foreground">
          Configure your SAML 2.0 provider settings.
        </p>
      </div>

      <div className="grid gap-4">
        {!hideProviderId && (
          <FormField
            control={form.control}
            name="providerId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Provider ID</FormLabel>
                <FormControl>
                  <Input placeholder="my-company-saml" {...field} />
                </FormControl>
                <FormDescription>
                  Unique identifier for this SSO provider. Used in callback
                  URLs.
                </FormDescription>
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
              <FormControl>
                <Input placeholder="https://idp.company.com" {...field} />
              </FormControl>
              <FormDescription>
                The issuer URL of your identity provider.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="domain"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Domain</FormLabel>
              <FormControl>
                <Input placeholder="company.com" {...field} />
              </FormControl>
              <FormDescription>
                Email domain for automatic provider detection.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

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
              <FormControl>
                <Input
                  placeholder="https://idp.company.com/saml/metadata"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The Entity ID of your SAML Identity Provider.
              </FormDescription>
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
              <FormControl>
                <Input
                  placeholder="https://idp.company.com/saml/sso"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The Single Sign-On URL where users are redirected to
                authenticate.
              </FormDescription>
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
              <FormControl>
                <Textarea
                  placeholder="-----BEGIN CERTIFICATE-----&#10;MIIDdDCCAlygAwIBAgIGAXOvL...&#10;-----END CERTIFICATE-----"
                  className="font-mono text-xs min-h-[150px]"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The X.509 certificate from your Identity Provider for signature
                verification.
              </FormDescription>
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
              <FormControl>
                <Textarea
                  placeholder="<?xml version='1.0'?>&#10;<md:EntityDescriptor>...</md:EntityDescriptor>"
                  className="font-mono text-xs min-h-[150px]"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The full IdP metadata XML from your Identity Provider. This is
                the recommended way to configure SAML and includes all necessary
                endpoints and certificates.
              </FormDescription>
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
              <FormControl>
                <Input
                  placeholder="https://your-app.com/api/auth/sso/callback/provider-id"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The Assertion Consumer Service URL where SAML responses are
                sent.
              </FormDescription>
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
              <FormControl>
                <Input placeholder="https://your-app.com" {...field} />
              </FormControl>
              <FormDescription>
                Expected audience value in SAML assertions.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <Separator />

      <div>
        <h4 className="text-md font-medium mb-4">
          Service Provider Metadata (Optional)
        </h4>
        <div className="grid gap-4">
          <FormField
            control={form.control}
            name="samlConfig.spMetadata.entityID"
            render={({ field }) => (
              <FormItem>
                <FormLabel>SP Entity ID</FormLabel>
                <FormControl>
                  <Input placeholder="https://your-app.com" {...field} />
                </FormControl>
                <FormDescription>
                  Your application's Entity ID for SAML.
                </FormDescription>
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
                <FormControl>
                  <Textarea
                    placeholder="<?xml version='1.0'?>&#10;<EntityDescriptor>...</EntityDescriptor>"
                    className="font-mono text-xs min-h-[100px]"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Your Service Provider metadata XML document.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </div>

      <Separator />

      <div>
        <h4 className="text-md font-medium mb-4">
          Attribute Mapping (Optional)
        </h4>
        <div className="grid gap-4">
          <FormField
            control={form.control}
            name="samlConfig.mapping.id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>User ID Attribute</FormLabel>
                <FormControl>
                  <Input
                    placeholder="urn:oid:0.9.2342.19200300.100.1.1"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  The SAML attribute that contains the unique user identifier.
                </FormDescription>
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
                <FormControl>
                  <Input
                    placeholder="urn:oid:0.9.2342.19200300.100.1.3"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  The SAML attribute that contains the user's email address.
                </FormDescription>
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
                <FormControl>
                  <Input
                    placeholder="urn:oid:2.16.840.1.113730.3.1.241"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  The SAML attribute that contains the user's display name.
                </FormDescription>
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
                <FormControl>
                  <Input placeholder="urn:oid:2.5.4.42" {...field} />
                </FormControl>
                <FormDescription>
                  The SAML attribute that contains the user's first name.
                </FormDescription>
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
                <FormControl>
                  <Input placeholder="urn:oid:2.5.4.4" {...field} />
                </FormControl>
                <FormDescription>
                  The SAML attribute that contains the user's last name.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </div>

      <RoleMappingForm form={form} />

      <TeamSyncConfigForm form={form} />
    </div>
  );
}
