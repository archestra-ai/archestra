"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Copy, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/auth/auth.query";
import { useEnableTwoFactorMutation } from "@/lib/auth/two-factor.query";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppName } from "@/lib/hooks/use-app-name";

const PasswordFormSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

type PasswordFormValues = z.infer<typeof PasswordFormSchema>;

/**
 * Full-page 2FA enrollment for organizations that require it: users without
 * 2FA are sent here after sign-in (the API refuses everything else with
 * `two_factor_setup_required`) and keep landing here until they enroll.
 *
 * Step 1 confirms the password and enables 2FA, step 2 shows the single-view
 * backup codes, then the shared /auth/two-factor view finishes authenticator
 * setup with the QR code.
 */
export function TwoFactorSetupView() {
  const router = useRouter();
  const appName = useAppName();
  const { data: session } = useSession();
  const [enableResult, setEnableResult] = useState<{
    totpURI: string;
    backupCodes: string[];
  } | null>(null);

  const enableTwoFactor = useEnableTwoFactorMutation();
  const form = useForm<PasswordFormValues>({
    resolver: zodResolver(PasswordFormSchema),
    defaultValues: { password: "" },
  });

  // Already enrolled (or arrived here by accident): nothing to set up.
  if (session?.user.twoFactorEnabled && !enableResult) {
    window.location.assign("/");
    return null;
  }

  async function onSubmit(values: PasswordFormValues) {
    const result = await enableTwoFactor.mutateAsync({
      password: values.password,
      // Shown beside the code in the user's authenticator app.
      issuer: appName,
    });
    if (result) {
      setEnableResult({
        totpURI: result.totpURI,
        backupCodes: result.backupCodes,
      });
    }
  }

  async function copyBackupCodes() {
    if (!enableResult) return;
    await copyToClipboard(enableResult.backupCodes.join("\n"));
    toast.success("Backup codes copied to clipboard");
  }

  function continueToAuthenticator() {
    if (!enableResult) return;
    router.push(
      `/auth/two-factor?totpURI=${encodeURIComponent(enableResult.totpURI)}&redirectTo=${encodeURIComponent("/")}`,
    );
  }

  if (enableResult) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl">Save Your Backup Codes</CardTitle>
          <CardDescription>
            Store these codes somewhere safe. Each one can be used once to sign
            in if you lose access to your authenticator app. They are shown only
            once.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 font-mono text-sm">
            {enableResult.backupCodes.map((code) => (
              <div
                key={code}
                className="rounded-md bg-muted px-3 py-2 text-center"
              >
                {code}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={copyBackupCodes}
            >
              <Copy className="mr-2 h-4 w-4" />
              <span>Copy</span>
            </Button>
            <Button
              type="button"
              className="flex-1"
              onClick={continueToAuthenticator}
            >
              Continue
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">
          Set Up Two-Factor Authentication
        </CardTitle>
        <CardDescription>
          Your organization requires two-factor authentication. Confirm your
          password to start setup — you'll scan a QR code with an authenticator
          app (1Password, Google Authenticator, …) on the next step.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      disabled={enableTwoFactor.isPending}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={enableTwoFactor.isPending}
            >
              {enableTwoFactor.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              <span>Continue</span>
            </Button>
            <div className="text-center text-sm">
              <Link
                href="/auth/sign-out"
                className="text-muted-foreground underline-offset-4 hover:underline"
              >
                Sign in as a different user
              </Link>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
