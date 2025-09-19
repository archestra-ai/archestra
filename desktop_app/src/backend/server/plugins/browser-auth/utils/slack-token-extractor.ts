/**
 * Slack Token Extraction Utilities
 *
 * Utilities for extracting Slack authentication tokens from the browser
 */

interface SlackTokenExtractionResult {
  success: boolean;
  xoxcToken?: string;
  workspaceId?: string;
  error?: string;
}

/**
 * Extract Slack tokens from localStorage
 * This runs in the browser context
 */
export const SLACK_TOKEN_EXTRACTION_SCRIPT = `
  (function() {
    try {
      console.log('[Slack Token Extraction] Starting token extraction...');
      console.log('[Slack Token Extraction] Current URL:', window.location.pathname);
      
      // Use workspace ID from context or extract from URL
      let workspaceId = '{{WORKSPACE_ID}}';
      console.log('[Slack Token Extraction] Context workspace ID:', workspaceId || 'none');
      
      if (!workspaceId || workspaceId === 'null') {
        const urlMatch = window.location.pathname.match(/^\\/client\\/([A-Z0-9]+)/);
        if (urlMatch) {
          workspaceId = urlMatch[1];
          console.log('[Slack Token Extraction] Extracted workspace ID from URL:', workspaceId);
        }
      }
      
      if (!workspaceId || workspaceId === 'null') {
        // Try to get from localStorage
        const localConfig = localStorage.getItem('localConfig_v2');
        if (localConfig) {
          const config = JSON.parse(localConfig);
          const teamIds = Object.keys(config.teams || {});
          if (teamIds.length > 0) {
            workspaceId = teamIds[0];
          }
        }
      }
      
      if (!workspaceId || workspaceId === 'null') {
        return { success: false, error: 'Could not determine workspace ID' };
      }
      
      // Get xoxc token from localStorage
      const localConfig = localStorage.getItem('localConfig_v2');
      if (!localConfig) {
        return { success: false, error: 'localConfig_v2 not found' };
      }
      
      const config = JSON.parse(localConfig);
      if (!config.teams || !config.teams[workspaceId]) {
        return { success: false, error: 'Workspace not found in config' };
      }
      
      const xoxcToken = config.teams[workspaceId].token;
      return { success: true, xoxcToken: xoxcToken, workspaceId: workspaceId };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
  })();
`;

/**
 * Build the Slack token extraction script with context
 */
export function buildSlackTokenExtractionScript(workspaceId: string | null): string {
  return SLACK_TOKEN_EXTRACTION_SCRIPT.replace('{{WORKSPACE_ID}}', workspaceId || 'null');
}

/**
 * Validate Slack workspace URL
 */
export function isSlackWorkspacePage(url: string): boolean {
  return url.includes('app.slack.com/client/');
}

/**
 * Extract workspace ID from Slack protocol URL
 */
export function extractWorkspaceIdFromProtocol(url: string): string | null {
  const match = url.match(/slack:\/\/([A-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Build workspace URL from ID
 */
export function buildSlackWorkspaceUrl(workspaceId: string): string {
  return `https://app.slack.com/client/${workspaceId}`;
}
