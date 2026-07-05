import JSZip from "jszip";
import { describe, expect, test } from "@/test";
import { extractTextFromPptx } from "./pptx-text-extractor";

const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function slideXml(runs: string[]): string {
  const body = runs.map((r) => `<a:t>${xmlEscape(r)}</a:t>`).join("");
  return `<?xml version="1.0"?><p:sld xmlns:a="${DRAWING_NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
}

async function buildPptx(slides: Record<string, string[]>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, runs] of Object.entries(slides)) {
    zip.file(`ppt/slides/${name}.xml`, slideXml(runs));
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("extractTextFromPptx", () => {
  test("joins <a:t> runs per slide and separates slides", async () => {
    const buffer = await buildPptx({
      slide1: ["Title", "Subtitle"],
      slide2: ["Second slide"],
    });
    expect(await extractTextFromPptx(buffer)).toBe(
      "Title Subtitle\n\nSecond slide",
    );
  });

  test("orders slides numerically (slide2 before slide10)", async () => {
    const buffer = await buildPptx({
      slide10: ["ten"],
      slide2: ["two"],
    });
    expect(await extractTextFromPptx(buffer)).toBe("two\n\nten");
  });

  test("returns run text verbatim, without leaking markup", async () => {
    const buffer = await buildPptx({ slide1: ["<b>bold</b>"] });
    expect(await extractTextFromPptx(buffer)).toBe("<b>bold</b>");
  });

  test("returns an empty string for a non-ZIP buffer", async () => {
    expect(await extractTextFromPptx(Buffer.from("not a zip"))).toBe("");
  });
});
