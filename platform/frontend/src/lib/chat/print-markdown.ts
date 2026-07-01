import DOMPurify from "dompurify";
import { toast } from "sonner";

/**
 * Open the browser print dialog for an element's rendered HTML so the user can
 * "Save as PDF". Shared by the artifact panel and the Files detail view.
 */
export function printMarkdownElementAsPdf(
  element: HTMLElement | null,
  title: string,
): void {
  const printWindow = window.open("", "_blank");

  if (!printWindow || !element) {
    toast.error("Unable to generate PDF. Please check popup settings.");
    return;
  }

  // Sanitize the rendered HTML before writing it into the print window.
  const content = DOMPurify.sanitize(element.innerHTML);

  const printDocument = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>${title}</title>
        <style>
          @page { size: A4; margin: 20mm; }
          @media print {
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              line-height: 1.6;
              color: #000;
              background: #fff;
            }
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            line-height: 1.6;
            padding: 20px;
            max-width: 800px;
            margin: 0 auto;
            color: #333;
          }
          h1 { font-size: 2em; font-weight: bold; margin: 0.67em 0; page-break-after: avoid; }
          h2 { font-size: 1.5em; font-weight: bold; margin: 0.75em 0; page-break-after: avoid; }
          h3 { font-size: 1.17em; font-weight: semibold; margin: 0.83em 0; page-break-after: avoid; }
          p { margin: 1em 0; }
          ul, ol { margin: 1em 0; padding-left: 2em; }
          li { margin: 0.5em 0; }
          code { background: #f4f4f4; padding: 0.2em 0.4em; border-radius: 3px; font-family: monospace; }
          pre { background: #f4f4f4; padding: 1em; border-radius: 5px; overflow-x: auto; page-break-inside: avoid; }
          pre code { background: none; padding: 0; }
          table { border-collapse: collapse; width: 100%; margin: 1em 0; page-break-inside: avoid; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f4f4f4; font-weight: bold; }
          blockquote { border-left: 4px solid #ddd; padding-left: 1em; margin-left: 0; color: #666; font-style: italic; }
          hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
          a { color: #0066cc; text-decoration: underline; }
          strong { font-weight: bold; }
          em { font-style: italic; }
          del { text-decoration: line-through; }
          /* Mermaid diagrams won't render in print; just keep svg sized. */
          svg { max-width: 100%; page-break-inside: avoid; }
        </style>
      </head>
      <body>
        ${content}
      </body>
    </html>
  `;

  printWindow.document.write(printDocument);
  printWindow.document.close();

  printWindow.onload = () => {
    setTimeout(() => {
      printWindow.print();
      toast.success("Print dialog opened - select 'Save as PDF' to download");
      printWindow.onafterprint = () => {
        printWindow.close();
      };
    }, 500);
  };
}
