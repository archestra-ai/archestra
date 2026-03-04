import { LocalServerInstallDialog } from "@/app/mcp/registry/_parts/local-server-install-dialog";
import { ManageUsersDialog } from "@/app/mcp/registry/_parts/manage-users-dialog";
import { NoAuthInstallDialog } from "@/app/mcp/registry/_parts/no-auth-install-dialog";
import { RemoteServerInstallDialog } from "@/app/mcp/registry/_parts/remote-server-install-dialog";
import { OAuthConfirmationDialog } from "@/components/oauth-confirmation-dialog";
import type { McpInstallOrchestrator } from "@/lib/mcp-install-orchestrator.hook";

interface McpInstallDialogsProps {
  orchestrator: McpInstallOrchestrator;
}

export function McpInstallDialogs({ orchestrator }: McpInstallDialogsProps) {
  return (
    <>
      <RemoteServerInstallDialog
        isOpen={orchestrator.isDialogOpened("remote-install")}
        onClose={orchestrator.closeRemoteInstall}
        onConfirm={orchestrator.handleRemoteServerInstallConfirm}
        catalogItem={orchestrator.selectedCatalogItem}
        isInstalling={orchestrator.isInstalling}
        isReauth={orchestrator.isReauth}
      />

      <OAuthConfirmationDialog
        open={orchestrator.isDialogOpened("oauth")}
        onOpenChange={(open) => {
          if (!open) orchestrator.closeOAuth();
        }}
        serverName={orchestrator.selectedCatalogItem?.name || ""}
        onConfirm={orchestrator.handleOAuthConfirm}
        onCancel={orchestrator.closeOAuth}
        catalogId={orchestrator.selectedCatalogItem?.id}
      />

      <NoAuthInstallDialog
        isOpen={orchestrator.isDialogOpened("no-auth")}
        onClose={orchestrator.closeNoAuth}
        onInstall={orchestrator.handleNoAuthConfirm}
        catalogItem={orchestrator.noAuthCatalogItem}
        isInstalling={orchestrator.isInstalling}
      />

      {orchestrator.localServerCatalogItem && (
        <LocalServerInstallDialog
          isOpen={orchestrator.isDialogOpened("local-install")}
          onClose={orchestrator.closeLocalInstall}
          onConfirm={orchestrator.handleLocalServerInstallConfirm}
          catalogItem={orchestrator.localServerCatalogItem}
          isInstalling={orchestrator.isInstalling}
          isReauth={orchestrator.isReauth}
        />
      )}

      {orchestrator.manageCatalogId && (
        <ManageUsersDialog
          isOpen={orchestrator.isDialogOpened("manage")}
          onClose={orchestrator.handleManageDialogClose}
          catalogId={orchestrator.manageCatalogId}
        />
      )}
    </>
  );
}
