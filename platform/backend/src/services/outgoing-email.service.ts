import config from "@/config";

export interface SendOutgoingEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  fromName?: string;
}

export interface SendOutgoingEmailResult {
  provider: "gmail_api";
  messageId: string;
  accepted: string[];
  rejected: string[];
}

interface GmailTokenCache {
  accessToken: string;
  expiresAtMs: number;
}

let cachedToken: GmailTokenCache | null = null;

function getOutgoingEmailConfig() {
  return config.agents.outgoingEmail;
}

export function isOutgoingEmailEnabled(): boolean {
  const outgoingConfig = getOutgoingEmailConfig();
  if (outgoingConfig.provider !== "gmail_api") return false;

  const { fromAddress, clientId, clientSecret, refreshToken } =
    outgoingConfig.gmail;
  return Boolean(fromAddress && clientId && clientSecret && refreshToken);
}

function sanitizeHeaderText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildRawMimeMessage(params: {
  fromAddress: string;
  toAddress: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  fromName?: string;
  replyToAddress?: string;
}): string {
  const fromHeader = params.fromName
    ? `"${sanitizeHeaderText(params.fromName)}" <${params.fromAddress}>`
    : params.fromAddress;

  const headers = [
    `From: ${fromHeader}`,
    `To: ${params.toAddress}`,
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
  ];

  if (params.replyToAddress) {
    headers.push(`Reply-To: ${params.replyToAddress}`);
  }

  if (!params.htmlBody) {
    return `${headers.join("\r\n")}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${params.textBody}`;
  }

  const boundary = `archestra_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return `${headers.join("\r\n")}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${params.textBody}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${params.htmlBody}\r\n--${boundary}--`;
}

async function getGmailAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs > now + 30_000) {
    return cachedToken.accessToken;
  }

  const { clientId, clientSecret, refreshToken } = getOutgoingEmailConfig().gmail;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to refresh Gmail OAuth token (${response.status}): ${errorText}`,
    );
  }

  const tokenData = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!tokenData.access_token) {
    throw new Error("Gmail OAuth token response did not include access_token");
  }

  const expiresInMs = Math.max(30_000, (tokenData.expires_in || 3600) * 1000);
  cachedToken = {
    accessToken: tokenData.access_token,
    expiresAtMs: Date.now() + expiresInMs,
  };
  return tokenData.access_token;
}

export async function sendOutgoingEmail(
  input: SendOutgoingEmailInput,
): Promise<SendOutgoingEmailResult> {
  if (!isOutgoingEmailEnabled()) {
    throw new Error(
      "Outgoing email is not configured. Set Gmail SMTP env vars first.",
    );
  }

  const outgoingConfig = getOutgoingEmailConfig();

  const to = sanitizeHeaderText(input.to);
  const subject = sanitizeHeaderText(input.subject);
  const text = input.text?.trim();
  const html = input.html?.trim();

  if (!to) throw new Error("Recipient email is required");
  if (!subject) throw new Error("Email subject is required");
  if (!text) throw new Error("Email text body is required");

  const accessToken = await getGmailAccessToken();
  const rawMime = buildRawMimeMessage({
    fromAddress: outgoingConfig.gmail.fromAddress,
    toAddress: to,
    subject,
    textBody: text,
    htmlBody: html || undefined,
    fromName: input.fromName?.trim() || undefined,
    replyToAddress: outgoingConfig.gmail.replyToAddress || undefined,
  });

  const sendResponse = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        raw: toBase64Url(rawMime),
      }),
    },
  );

  if (!sendResponse.ok) {
    const errorText = await sendResponse.text().catch(() => "");
    throw new Error(
      `Failed to send Gmail message (${sendResponse.status}): ${errorText}`,
    );
  }

  const sendResult = (await sendResponse.json()) as { id?: string };
  if (!sendResult.id) {
    throw new Error("Gmail API did not return a message ID");
  }

  return {
    provider: "gmail_api",
    messageId: sendResult.id,
    accepted: [to],
    rejected: [],
  };
}
