import { AuthErrorTool } from "./auth-error-tool";

interface ExpiredAuthToolProps {
  toolName: string;
  catalogName: string;
  manageUrl: string;
}

export function ExpiredAuthTool({
  toolName,
  catalogName,
  manageUrl,
}: ExpiredAuthToolProps) {
  return (
    <AuthErrorTool
      toolName={toolName}
      title="Expired / Invalid Authentication"
      description={
        <>
          Your credentials for &ldquo;{catalogName}&rdquo; have expired or are
          invalid. Revoke the old credentials and re-authenticate to continue
          using this tool.
        </>
      }
      buttonText="Manage credentials"
      buttonUrl={manageUrl}
    />
  );
}
