"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useVerifyTotpMutation } from "@/lib/auth/two-factor.query";
import { getValidatedRedirectPath } from "@/lib/utils/redirect-validation";

const TwoFactorFormSchema = z.object({
  code: z
    .string()
    .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
  trustDevice: z.boolean(),
});

type TwoFactorFormValues = z.infer<typeof TwoFactorFormSchema>;

/**
 * Two-factor challenge during sign-in: verifies the TOTP code (optionally
 * trusting the device) and completes the session. Enrollment — QR scan,
 * first-code confirmation, recovery codes — lives in the
 * /auth/two-factor-setup wizard.
 */
export function TwoFactorView() {
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo");

  const verifyTotp = useVerifyTotpMutation();
  const form = useForm<TwoFactorFormValues>({
    resolver: zodResolver(TwoFactorFormSchema),
    defaultValues: { code: "", trustDevice: false },
  });

  async function onSubmit(values: TwoFactorFormValues) {
    const verified = await verifyTotp.mutateAsync({
      code: values.code,
      trustDevice: values.trustDevice,
    });

    if (!verified) return;

    // Full navigation (rather than router.push) so the app shell re-evaluates
    // the now-authenticated session from scratch.
    window.location.href = getValidatedRedirectPath(redirectTo);
  }

  const recoverAccountHref = redirectTo
    ? `/auth/recover-account?redirectTo=${encodeURIComponent(redirectTo)}`
    : "/auth/recover-account";

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">Two-Factor Authentication</CardTitle>
        <CardDescription>
          Enter the 6-digit code from your authenticator app
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>One-time code</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      // Wide enough to accept a pasted "123 456"; the value
                      // is normalised to six digits below.
                      maxLength={8}
                      disabled={verifyTotp.isPending}
                      {...field}
                      onChange={(event) =>
                        field.onChange(
                          event.target.value.replace(/\D/g, "").slice(0, 6),
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="trustDevice"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center gap-2 space-y-0">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={verifyTotp.isPending}
                    />
                  </FormControl>
                  <FormLabel className="font-normal">
                    Trust this device
                  </FormLabel>
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={verifyTotp.isPending}
            >
              {verifyTotp.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              <span>Verify</span>
            </Button>
            <div className="text-center text-sm">
              <Link
                href={recoverAccountHref}
                className="text-muted-foreground underline-offset-4 hover:underline"
              >
                Lost access to your authenticator? Use a backup code
              </Link>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
