import { NotionBlock } from './notion-connector'; // Assuming NotionBlock type is exported

// Helper for rich text to markdown
function richTextToMarkdown(richText: any[]): string {
  if (!richText || richText.length === 0) return '';

  return richText
    .map((text) => {
      let content = text.plain_text;
      if (text.annotations.bold) content = `**${content}**`;
      if (text.annotations.italic) content = `*${content}*`;
      if (text.annotations.strikethrough) content = `~~${content}~~`;
      if (text.annotations.underline) content = `<u>${content}</u>`; // Markdown doesn't have native underline, use HTML
      if (text.annotations.code) content = `\`${content}\``;
      if (text.href) content = `[${content}](${text.href})`;
      return content;
    })
    .join('');
}

// Recursive helper to get block content as markdown
export function createMarkdownBlock(block: NotionBlock, indentLevel: number = 0): string {
  const indent = '  '.repeat(indentLevel); // 2 spaces per indent level for lists

  let markdown = '';
  const childrenMarkdown = (block.children || []).map((child: NotionBlock) => createMarkdownBlock(child, indentLevel + 1)).join('\n');

  switch (block.type) {
    case 'paragraph':
      markdown = richTextToMarkdown(block.paragraph.rich_text);
      break;
    case 'heading_1':
      markdown = `# ${richTextToMarkdown(block.heading_1.rich_text)}`;
      break;
    case 'heading_2':
      markdown = `## ${richTextToMarkdown(block.heading_2.rich_text)}`;
      break;
    case 'heading_3':
      markdown = `### ${richTextToMarkdown(block.heading_3.rich_text)}`;
      break;
    case 'bulleted_list_item':
      markdown = `${indent}- ${richTextToMarkdown(block.bulleted_list_item.rich_text)}`;
      break;
    case 'numbered_list_item':
      // Notion API doesn't provide the number, so we just use generic numbered list.
      markdown = `${indent}1. ${richTextToMarkdown(block.numbered_list_item.rich_text)}`;
      break;
    case 'to_do':
      const checked = block.to_do.checked ? 'x' : ' ';
      markdown = `${indent}- [${checked}] ${richTextToMarkdown(block.to_do.rich_text)}`;
      break;
    case 'code':
      const language = block.code.language || 'plaintext';
      markdown = `\`\`\`${language}\n${richTextToMarkdown(block.code.rich_text)}\n\`\`\``;
      break;
    case 'quote':
      markdown = `> ${richTextToMarkdown(block.quote.rich_text)}`;
      break;
    case 'callout':
      const icon = block.callout.icon?.emoji || '💡';
      markdown = `> ${icon} ${richTextToMarkdown(block.callout.rich_text)}`;
      break;
    case 'divider':
      markdown = '---';
      break;
    case 'image':
      const imageUrl = block.image.type === 'external' ? block.image.external.url : block.image.file.url;
      const imageCaption = richTextToMarkdown(block.image.caption || []);
      markdown = `![${imageCaption}](${imageUrl})`;
      break;
    case 'link_to_page':
      // This refers to an internal Notion page. We might want to link to its synced URL if available.
      // For now, just display the page ID.
      markdown = `[Link to Notion Page](${block.link_to_page.page_id})`;
      break;
    case 'bookmark':
      const bookmarkUrl = block.bookmark.url;
      const bookmarkCaption = richTextToMarkdown(block.bookmark.caption || []);
      markdown = `[${bookmarkCaption || bookmarkUrl}](${bookmarkUrl})`;
      break;
    case 'equation':
      markdown = `$${block.equation.expression}$`; // Assuming MathJax/LaTeX format
      break;
    case 'column_list':
    case 'column':
      // Columns are tricky to represent in flat markdown.
      // Just render children sequentially for now, possibly with extra newlines.
      return childrenMarkdown;
    case 'child_page':
      // child_page type appears in search results, but not as block children usually.
      // If it appears, just display the title.
      markdown = `[Child Page: ${block.child_page.title}]`;
      break;
    case 'unsupported':
    default:
      // Log unsupported block types
      console.warn(`Unsupported Notion block type: ${block.type}`);
      markdown = ''; // Or provide a placeholder
      break;
  }

  // Append children markdown
  if (childrenMarkdown) {
    if (['paragraph', 'heading_1', 'heading_2', 'heading_3', 'quote', 'callout', 'code', 'image', 'bookmark'].includes(block.type)) {
      markdown += '\n' + childrenMarkdown; // Add a newline after block if it has children
    } else {
      markdown += '\n' + childrenMarkdown;
    }
  }

  return markdown;
}
