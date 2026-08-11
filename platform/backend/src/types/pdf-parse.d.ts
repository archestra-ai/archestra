declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfData {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
  }
  function pdfParse(
    dataBuffer: Buffer | Uint8Array,
    options?: Record<string, unknown>,
  ): Promise<PdfData>;
  export default pdfParse;
}

declare module "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js" {
  interface PdfJsTextItem {
    str?: string;
    transform?: number[];
  }

  interface PdfJsPage {
    getTextContent(options: {
      normalizeWhitespace: boolean;
      disableCombineTextItems: boolean;
    }): Promise<{ items: PdfJsTextItem[] }>;
    getOperatorList(): Promise<{ fnArray: number[] }>;
  }

  interface PdfJsDocument {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfJsPage>;
    destroy(): void | Promise<void>;
  }

  interface PdfJsApi {
    disableWorker: boolean;
    OPS: Record<string, number | undefined>;
    getDocument(data: Buffer | Uint8Array): Promise<PdfJsDocument>;
  }

  const pdfJs: PdfJsApi;
  export default pdfJs;
}
