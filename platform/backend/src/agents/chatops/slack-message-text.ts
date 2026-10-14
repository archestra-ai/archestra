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
