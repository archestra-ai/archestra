/** Use Slack's fallback text when supplied; otherwise recover composer content. */
export function slackMessageText(message: {
  text?: string;
  blocks?: unknown;
}): string {
  if (message.text?.trim()) return message.text;
  const recovered = (Array.isArray(message.blocks) ? message.blocks : [])
    .filter((block) => isElement(block) && block.type === "rich_text")
    .map(renderElement)
    .filter(Boolean)
    .join("\n");
  return recovered || message.text || "";
}

/**
 * Thread-history variant: when a message has no text or rich text, also read
 * the content bots and webhooks post instead — section/header/context blocks
 * and legacy attachments — capped so one oversized alert cannot crowd out the
 * rest of the thread.
 */
export function slackThreadMessageText(message: {
  text?: string;
  blocks?: unknown;
  attachments?: unknown;
}): string {
  const text = slackMessageText(message);
  if (text.trim()) return text;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : [];
  const recovered = [
    ...new Set([
      ...renderLayoutBlocks(message.blocks),
      ...attachments.flatMap(renderAttachment),
    ]),
  ].join("\n");
  if (!recovered) return text;
  return recovered.length > MAX_RECOVERED_TEXT_LENGTH
    ? `${recovered.slice(0, MAX_RECOVERED_TEXT_LENGTH)}…`
    : recovered;
}

const MAX_RECOVERED_TEXT_LENGTH = 4000;

function renderAttachment(value: unknown): string[] {
  if (!isElement(value)) return [];
  const fields = (Array.isArray(value.fields) ? value.fields : [])
    .filter(isElement)
    .map((field) =>
      [stringValue(field.title), stringValue(field.value)]
        .filter(Boolean)
        .join(": "),
    );
  const parts = [
    stringValue(value.pretext),
    stringValue(value.title),
    stringValue(value.text),
    ...fields,
    ...renderLayoutBlocks(value.blocks),
  ].filter(Boolean);
  // `fallback` is Slack's plain summary of the parts above; read it only alone.
  if (parts.length > 0) return parts;
  const fallback = stringValue(value.fallback);
  return fallback ? [fallback] : [];
}

/** Text-bearing layout blocks only: buttons, menus, and dividers are chrome. */
function renderLayoutBlocks(blocks: unknown): string[] {
  return (Array.isArray(blocks) ? blocks : [])
    .filter(isElement)
    .flatMap((block) => {
      switch (block.type) {
        case "header":
          return [textObject(block.text)];
        case "section":
          return [
            textObject(block.text),
            ...(Array.isArray(block.fields) ? block.fields : []).map(
              textObject,
            ),
          ];
        case "context":
          return (Array.isArray(block.elements) ? block.elements : []).map(
            textObject,
          );
        case "rich_text":
          return [renderElement(block)];
        default:
          return [];
      }
    })
    .filter(Boolean);
}

function textObject(value: unknown): string {
  return isElement(value) &&
    (value.type === "mrkdwn" || value.type === "plain_text")
    ? stringValue(value.text)
    : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isElement(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Only rich-text content is read: action labels and other UI chrome are excluded. */
function renderElement(value: unknown): string {
  if (!isElement(value)) return "";
  const children = Array.isArray(value.elements) ? value.elements : [];
  const inline = () => children.map(renderElement).join("");
  switch (value.type) {
    case "rich_text":
      return children.map(renderElement).filter(Boolean).join("\n");
    case "rich_text_section":
      return inline();
    case "rich_text_quote": {
      const text = inline();
      return text.trim()
        ? text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")
        : "";
    }
    case "rich_text_preformatted": {
      const text = inline();
      return text.trim() ? `\`\`\`\n${text}\n\`\`\`` : "";
    }
    case "rich_text_list":
      return children
        .map(
          (child, index) =>
            `${value.style === "ordered" ? `${index + 1}.` : "-"} ${renderElement(child)}`,
        )
        .join("\n");
    case "text":
      // Match Slack's fallback encoding before cleanBotMention decodes it.
      return typeof value.text === "string" ? escapeText(value.text) : "";
    case "user":
      return typeof value.user_id === "string" ? `<@${value.user_id}>` : "";
    case "channel":
      return typeof value.channel_id === "string"
        ? `<#${value.channel_id}>`
        : "";
    case "usergroup":
      return typeof value.usergroup_id === "string"
        ? `<!subteam^${value.usergroup_id}>`
        : "";
    case "link":
      return typeof value.url === "string"
        ? `<${value.url}${typeof value.text === "string" ? `|${escapeText(value.text)}` : ""}>`
        : "";
    case "emoji":
      return typeof value.name === "string" ? `:${value.name}:` : "";
    case "broadcast":
      return typeof value.range === "string" ? `<!${value.range}>` : "";
    case "date":
      return typeof value.fallback === "string"
        ? escapeText(value.fallback)
        : "";
    default:
      return "";
  }
}

function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
