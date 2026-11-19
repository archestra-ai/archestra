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
    cleanup(): void;
  }

  interface PdfJsDocument {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfJsPage>;
    destroy(): void | Promise<void>;
  }

  interface PdfJsLoadingTask extends PromiseLike<PdfJsDocument> {
    promise: Promise<PdfJsDocument>;
    destroy(): void | Promise<void>;
  }

  interface PdfJsApi {
    disableWorker: boolean;
    getDocument(params: {
      data: Buffer | Uint8Array;
      stopAtErrors?: boolean;
    }): PdfJsLoadingTask;
  }

  const pdfJs: PdfJsApi;
  export default pdfJs;
}
