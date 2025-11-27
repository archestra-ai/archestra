"use client";

import type { SsoProviderFormValues } from "@shared";
import type { UseFormReturn } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

interface SamlConfigFormProps {
  form: UseFormReturn<SsoProviderFormValues>;
}

export function SamlConfigForm({ form }: SamlConfigFormProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">SAML Configuration</h3>
        <p className="text-sm text-muted-foreground">
          Configure your SAML 2.0 provider settings.
        </p>
      </div>

      <div className="grid gap-4">
        <FormField
          control={form.control}
          name="samlConfig.entryPoint"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Entry Point (SSO URL)</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://auth.company.com/sso/saml"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The SAML SSO endpoint URL provided by your identity provider.
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
              <FormLabel>X.509 Certificate</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                  className="font-mono text-sm"
                  rows={6}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The X.509 certificate from your identity provider (PEM format).
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
              <FormLabel>Callback URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://yourapp.com/api/auth/sso/saml2/callback/provider-id"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The callback URL where SAML responses will be sent.
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
                <Input placeholder="https://yourapp.com" {...field} />
              </FormControl>
              <FormDescription>
                The expected audience for SAML assertions.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="samlConfig.identifierFormat"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name ID Format</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select name ID format" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">
                    Email Address
                  </SelectItem>
                  <SelectItem value="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">
                    Persistent
                  </SelectItem>
                  <SelectItem value="urn:oasis:names:tc:SAML:2.0:nameid-format:transient">
                    Transient
                  </SelectItem>
                  <SelectItem value="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">
                    Unspecified
                  </SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                The format for the SAML NameID element.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="samlConfig.signatureAlgorithm"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Signature Algorithm</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select signature algorithm" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="sha256">SHA-256</SelectItem>
                  <SelectItem value="sha1">SHA-1</SelectItem>
                  <SelectItem value="sha512">SHA-512</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                The algorithm used for signing SAML requests.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="samlConfig.digestAlgorithm"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Digest Algorithm</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select digest algorithm" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="sha256">SHA-256</SelectItem>
                  <SelectItem value="sha1">SHA-1</SelectItem>
                  <SelectItem value="sha512">SHA-512</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                The algorithm used for message digests.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="samlConfig.wantAssertionsSigned"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>Require Signed Assertions</FormLabel>
                <FormDescription>
                  Require SAML assertions to be digitally signed.
                </FormDescription>
              </div>
            </FormItem>
          )}
        />
      </div>

      <Separator />

      <div>
        <h4 className="text-md font-medium mb-4">Attribute Mapping</h4>
        <div className="grid gap-4">
          <FormField
            control={form.control}
            name="samlConfig.mapping.id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>User ID Attribute</FormLabel>
                <FormControl>
                  <Input placeholder="nameID" {...field} />
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
                  <Input placeholder="email" {...field} />
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
                  <Input placeholder="displayName" {...field} />
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
                  <Input placeholder="givenName" {...field} />
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
                  <Input placeholder="surname" {...field} />
                </FormControl>
                <FormDescription>
                  The SAML attribute that contains the user's last name.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="samlConfig.mapping.emailVerified"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email Verified Attribute (Optional)</FormLabel>
                <FormControl>
                  <Input placeholder="email_verified" {...field} />
                </FormControl>
                <FormDescription>
                  The SAML attribute that indicates if the email is verified.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </div>
    </div>
  );
}
