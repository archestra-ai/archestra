import { archestraApiSdk, DEFAULT_ADMIN_EMAIL } from "@shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  clearDefaultPasswordChangePending,
  setDefaultPasswordChangePending,
} from "./default-password-change";

type AuthClientError = {
  message?: string;
  statusText?: string;
};

export function useUpdateAccountNameMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      const { error } = await authClient.updateUser({ name });
      if (error) {
        toast.error(getAuthErrorMessage(error, "Failed to update name"));
        return false;
      }
      return true;
    },
    onSuccess: async (updated) => {
      if (!updated) return;
      toast.success("Name updated");
      await queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
    },
  });
}

export function useChangeAccountPasswordMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      currentPassword: string;
      newPassword: string;
      revokeOtherSessions?: boolean;
    }) => {
      const { error } = await authClient.changePassword(params);
      if (error) {
        toast.error(
          getChangePasswordErrorMessage(error, "Failed to change password"),
        );
        return false;
      }
      return true;
    },
    onSuccess: async (changed) => {
      if (!changed) return;
      toast.success("Password changed");
      await queryClient.invalidateQueries({
        queryKey: ["auth", "defaultCredentialsEnabled"],
      });
    },
  });
}

export function useSignInWithEmailMutation() {
  return useMutation({
    mutationFn: async (params: {
      email: string;
      password: string;
      callbackURL?: string;
    }) => {
      const isDefaultAdminEmail =
        params.email.trim().toLowerCase() === DEFAULT_ADMIN_EMAIL;
      let defaultCredentialsEnabled = false;

      if (isDefaultAdminEmail) {
        const { data: defaultCredentialsStatus } =
          await archestraApiSdk.getDefaultCredentialsStatus();
        defaultCredentialsEnabled = defaultCredentialsStatus?.enabled ?? false;
      }

      if (defaultCredentialsEnabled) {
        setDefaultPasswordChangePending();
      } else {
        clearDefaultPasswordChangePending();
      }

      const { data, error } = await authClient.signIn.email({
        email: params.email,
        password: params.password,
      });

      if (error) {
        clearDefaultPasswordChangePending();
        toast.error(getAuthErrorMessage(error, "Failed to sign in"));
        return null;
      }

      if (!isDefaultAdminEmail) {
        return {
          requiresDefaultPasswordChange: false,
          redirectUrl: data?.url ?? params.callbackURL ?? "/",
        };
      }

      return {
        requiresDefaultPasswordChange: defaultCredentialsEnabled,
        redirectUrl: data?.url ?? params.callbackURL ?? "/",
      };
    },
  });
}

function getAuthErrorMessage(error: AuthClientError, fallback: string) {
  return error.message ?? error.statusText ?? fallback;
}

function getChangePasswordErrorMessage(
  error: AuthClientError,
  fallback: string,
) {
  const message = getAuthErrorMessage(error, fallback);
  return message === "Invalid password"
    ? "Current password is invalid"
    : message;
}
