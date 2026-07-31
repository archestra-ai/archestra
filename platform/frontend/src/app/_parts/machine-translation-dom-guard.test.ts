import { beforeAll, describe, expect, it, vi } from "vitest";
import { installMachineTranslationDomGuard } from "./machine-translation-dom-guard";

// Simulates what Chrome page translation does to the DOM: text nodes React
// created get re-parented into injected <font> wrappers, so React's own
// removeChild/insertBefore calls later reference nodes whose parent changed.

function translatedTextNode(parent: HTMLElement) {
  const text = document.createTextNode("hello");
  parent.appendChild(text);
  const font = document.createElement("font");
  font.appendChild(text);
  parent.appendChild(font);
  return text;
}

describe("installMachineTranslationDomGuard", () => {
  beforeAll(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installMachineTranslationDomGuard();
  });

  it("removeChild no longer throws for a node a translator re-parented", () => {
    const parent = document.createElement("div");
    const text = translatedTextNode(parent);
    expect(() => parent.removeChild(text)).not.toThrow();
    expect(parent.removeChild(text)).toBe(text);
  });

  it("removeChild still removes an actual child", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    expect(parent.removeChild(child)).toBe(child);
    expect(parent.contains(child)).toBe(false);
  });

  it("insertBefore skips the insertion when the reference node was re-parented", () => {
    const parent = document.createElement("div");
    const reference = translatedTextNode(parent);
    const inserted = document.createElement("span");
    expect(parent.insertBefore(inserted, reference)).toBe(inserted);
    expect(inserted.parentNode).toBeNull();
  });

  it("installs only once", () => {
    const removeChild = Node.prototype.removeChild;
    const insertBefore = Node.prototype.insertBefore;
    installMachineTranslationDomGuard();
    expect(Node.prototype.removeChild).toBe(removeChild);
    expect(Node.prototype.insertBefore).toBe(insertBefore);
  });

  it("insertBefore still inserts before an actual child", () => {
    const parent = document.createElement("div");
    const reference = document.createElement("span");
    parent.appendChild(reference);
    const inserted = document.createElement("b");
    expect(parent.insertBefore(inserted, reference)).toBe(inserted);
    expect(parent.firstChild).toBe(inserted);
  });

  it("insertBefore with a null reference still appends", () => {
    const parent = document.createElement("div");
    const inserted = document.createElement("span");
    expect(parent.insertBefore(inserted, null)).toBe(inserted);
    expect(parent.lastChild).toBe(inserted);
  });
});
