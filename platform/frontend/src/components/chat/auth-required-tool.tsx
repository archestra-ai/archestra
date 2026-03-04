import { AuthErrorTool } from "./auth-error-tool";

interface AuthRequiredToolProps {
  toolName: string;
  catalogName: string;
  installUrl: string;
}

export function AuthRequiredTool({
  toolName,
  catalogName,
  installUrl,
}: AuthRequiredToolProps) {
  return (
    <AuthErrorTool
      toolName={toolName}
      title="Authentication Required"
      description={
        <>
          No credentials found for &ldquo;{catalogName}&rdquo;. Set up your
          credentials to use this tool.
        </>
      }
      buttonText="Set up credentials"
      buttonUrl={installUrl}
    />
  );
}
