import WordExtractor from "word-extractor";

export async function extractTextFromDocx(buffer: Buffer): Promise<string> {
  try {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);

    const body = doc.getBody();
    return body;
  } catch (error) {
    throw new Error(
      `Extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
