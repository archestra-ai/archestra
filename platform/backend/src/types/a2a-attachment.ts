/**
 * Source-agnostic attachment for A2A execution.
 * Callers (email, Slack, Teams, etc.) should transform their provider-specific
 * attachment types into this format before passing to executeA2AMessage.
 */
export interface A2AAttachment {
  /** MIME content type (e.g., 'image/png', 'application/pdf') */
  contentType: string;
  /** Base64-encoded content */
  contentBase64: string;
  /** Optional filename for context */
  name?: string;
}
