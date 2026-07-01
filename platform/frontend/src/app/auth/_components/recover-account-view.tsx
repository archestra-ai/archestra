"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useVerifyBackupCodeMutation } from "@/lib/auth/two-factor.query";
import { getValidatedRedirectPath } from "@/lib/utils/redirect-validation";

const RecoverAccountFormSchema = z.object({
  code: z.string().min(1, "Backup code is required"),
});

type RecoverAccountFormValues = z.infer<typeof RecoverAccountFormSchema>;

/**
 * Completes a two-factor sign-in with a backup code when the authenticator
 * app is unavailable.
 */
export function RecoverAccountView() {
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo");

  const verifyBackupCode = useVerifyBackupCodeMutation();
  const form = useForm<RecoverAccountFormValues>({
    resolver: zodResolver(RecoverAccountFormSchema),
    defaultValues: { code: "" },
  });

  async function onSubmit(values: RecoverAccountFormValues) {
    const verified = await verifyBackupCode.mutateAsync({
      code: values.code.trim(),
    });

    if (!verified) return;

    // Full navigation (rather than router.push) so the app shell re-evaluates
    // the now-authenticated session from scratch.
    window.location.href = getValidatedRedirectPath(redirectTo);
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">Recover Account</CardTitle>
        <CardDescription>
          Enter one of your backup codes to sign in
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
                  <FormLabel>Backup code</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      disabled={verifyBackupCode.isPending}
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
              disabled={verifyBackupCode.isPending}
            >
              {verifyBackupCode.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Recover Account
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
