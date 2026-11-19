// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

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
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";

/**
 * AWS IAM (SigV4) sign-in for a remote server behind an AWS service: the IAM
 * role each agent assumes with its own SPIFFE ID, and where requests are
 * signed for.
 */
export function AwsIamAuthFields(props: {
  form: UseFormReturn<McpCatalogFormValues>;
}) {
  const { form } = props;
  const appName = useAppName();
  const spiffe = useFeature("agentIdentitySpiffe");
  return (
    <div className="space-y-4 border-t pt-5">
      <p className="text-sm text-muted-foreground">
        Each agent assumes this IAM role with its own SPIFFE ID, and {appName}{" "}
        signs every request with SigV4. The role&apos;s trust policy decides
        which agents may call the server.
      </p>
      {spiffe && (
        <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p>
            In AWS IAM, add an OpenID Connect provider for{" "}
            <code className="break-all">{spiffe.issuer}</code> with the audience{" "}
            <code>sts.amazonaws.com</code>, and let the role trust it.
          </p>
          <p>
            Agents act as{" "}
            <code className="break-all">
              spiffe://{spiffe.trustDomain}/agent/&lt;agent ID&gt;
            </code>
            . Listing the server&apos;s tools acts as{" "}
            <code className="break-all">
              spiffe://{spiffe.trustDomain}/platform
            </code>
            .
          </p>
        </div>
      )}
      <FormField
        control={form.control}
        name="awsIamConfig.roleArn"
        render={({ field }) => (
          <FormItem>
            <FormLabel>IAM Role ARN</FormLabel>
            <FormControl>
              <Input
                placeholder="arn:aws:iam::123456789012:role/archestra-agents"
                className="font-mono"
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <div className="grid items-start gap-4 md:grid-cols-2">
        <FormField
          control={form.control}
          name="awsIamConfig.region"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Region</FormLabel>
              <FormControl>
                <Input
                  placeholder="us-east-1"
                  className="font-mono"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="awsIamConfig.service"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Service</FormLabel>
              <FormControl>
                <Input
                  placeholder="bedrock-agentcore"
                  className="font-mono"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormDescription>
                The SigV4 service name of what the server sits behind.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <FormField
        control={form.control}
        name="awsIamConfig.audience"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Token Audience (Optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="sts.amazonaws.com"
                className="font-mono"
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormDescription>
              The audience the IAM OpenID Connect provider lists. Defaults to{" "}
              <code>sts.amazonaws.com</code>.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
