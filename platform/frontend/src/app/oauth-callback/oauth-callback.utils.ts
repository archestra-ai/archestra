export interface OAuthCallbackErrorState {
  title: string;
  description: string;
}

export function getOAuthCallbackErrorState(params: {
  code: string | null;
  error: string | null;
  errorDescription: string | null;
  state: string | null;
}): OAuthCallbackErrorState | null {
  const { code, error, errorDescription, state } = params;

  if (code && state) {
    return null;
  }

  if (error) {
    return {
      title: "OAuth Authentication Failed",
      description:
        errorDescription ||
        `OAuth provider returned "${error}". Check the provider configuration and try again.`,
    };
  }

  if (!code) {
    return {
      title: "Missing Authorization Code",
      description:
        "The OAuth provider redirected back without an authorization code. Check the provider configuration and try again.",
    };
  }

  return {
    title: "Missing OAuth State",
    description:
      "The OAuth provider redirected back without a state value. Start the installation again and retry the sign-in flow.",
  };
}
