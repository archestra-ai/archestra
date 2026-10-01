// @vitest-environment node
import { Terminal } from "@xterm/xterm";
import { expect, test } from "vitest";
import { inferTerminalRecordingLinks } from "./terminal-recording-links";
import { snapshotTerminalRecording } from "./terminal-recording-snapshot";

test("keeps scrollback and interior blank rows while dropping unwritten padding", async () => {
  await withTerminal(
    "first\r\n\r\nthird\r\nfourth\r\nfifth",
    { cols: 10, rows: 3 },
    (terminal) => {
      const result = snapshotTerminalRecording(terminal);
      expect(result.cols).toBe(10);
      expect(result.rows).toBe(3);
      expect(textLines(result)).toEqual([
        "first",
        "",
        "third",
        "fourth",
        "fifth",
      ]);
    },
  );
});

test("range extraction preserves boundary blanks, physical coordinates and link boundaries", async () => {
  await withTerminal(
    `First\r\n\r\n${link("https://example.com/a", "Artifact")} after`,
    { cols: 20, rows: 5 },
    (terminal) => {
      const first = snapshotTerminalRecording(terminal, { start: -5, end: 2 });
      expect(textLines(first)).toEqual(["First", ""]);
      expect(first.lines.map((line) => line.row)).toEqual([0, 1]);
      const second = snapshotTerminalRecording(terminal, { start: 2, end: 99 });
      expect(textLines(second)).toEqual(["Artifact after", "", ""]);
      expect(second.lines.map((line) => line.row)).toEqual([2, 3, 4]);
      expect(
        second.lines[0].runs.filter((run) => run.url).map((run) => run.text),
      ).toEqual(["Artifact"]);
      expect([second.cols, second.rows]).toEqual([20, 5]);
    },
  );
});

test("snapshots are immutable when later writes overwrite cells", async () => {
  await withTerminal("Before", {}, async (terminal) => {
    const before = snapshotTerminalRecording(terminal);
    await write(terminal, "\rAfter\x1b[K");
    expect(textLines(before)).toEqual(["Before"]);
    expect(textLines(snapshotTerminalRecording(terminal))).toEqual(["After"]);
  });
});

test("preserves combined Unicode, wide cells, physical rows and soft wrap markers", async () => {
  await withTerminal("A界e\u0301BXYZ", { cols: 6 }, (terminal) => {
    const result = snapshotTerminalRecording(terminal);
    expect(textLines(result)).toEqual(["A界e\u0301BX", "YZ"]);
    expect(result.lines.map((line) => line.wrapped)).toEqual([false, true]);
    expect(result.lines.map((line) => line.row)).toEqual([0, 1]);
    expect(result.lines[1].runs[0].column).toBe(0);
  });
});

test("retains written spaces and painted empty rows", async () => {
  await withTerminal(
    "A  \x1b[3;1H\x1b[48;2;1;2;3m\x1b[2K\x1b[0m",
    { cols: 8, rows: 5 },
    (terminal) => {
      const result = snapshotTerminalRecording(terminal);
      expect(textLines(result)).toEqual(["A  ", "", "        "]);
      expect(result.lines[2].runs[0].style.backgroundColor).toBe("#010203");
    },
  );
});

test("keeps unwritten boundary spaces before a wide glyph soft wraps", async () => {
  await withTerminal("ABC界", { cols: 4 }, (terminal) => {
    const result = snapshotTerminalRecording(terminal);
    expect(textLines(result)).toEqual(["ABC ", "界"]);
    expect(result.lines[1].wrapped).toBe(true);
  });
});

test("resolves RGB, palette, inverse, bold and invisible cells", async () => {
  await withTerminal(
    "\x1b[38;2;1;2;3;48;2;4;5;6mR\x1b[7mI\x1b[0;31;1mB\x1b[0;38;5;196mP\x1b[0;38;5;244mG\x1b[0;8;44mH",
    {},
    (terminal) => {
      const runs = snapshotTerminalRecording(terminal).lines[0].runs;
      expect(runs.map((run) => run.text)).toEqual([
        "R",
        "I",
        "B",
        "P",
        "G",
        "H",
      ]);
      expect(runs.map((run) => run.column)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(runs[0].style).toMatchObject({
        color: "#010203",
        backgroundColor: "#040506",
      });
      expect(runs[1].style).toMatchObject({
        color: "#040506",
        backgroundColor: "#010203",
      });
      expect(runs[2].style).toMatchObject({
        color: "#ef2929",
        fontWeight: "bold",
      });
      expect(runs[3].style.color).toBe("#ff0000");
      expect(runs[4].style.color).toBe("#808080");
      expect(runs[5].style).toMatchObject({
        color: "transparent",
        backgroundColor: "#3465a4",
      });
    },
  );
});

test("brightens the resulting foreground after swapping inverse colors", async () => {
  await withTerminal("\x1b[31;44;1;7mX", {}, (terminal) => {
    expect(
      snapshotTerminalRecording(terminal).lines[0].runs[0].style,
    ).toMatchObject({
      color: "#729fcf",
      backgroundColor: "#cc0000",
      fontWeight: "bold",
    });
  });
});

test.each([
  [
    "A😀B",
    [
      ["A", 0, 1, false],
      ["😀", 1, 1, true],
      ["B", 2, 1, false],
    ],
  ],
  [
    "A界B",
    [
      ["A", 0, 1, false],
      ["界", 1, 2, true],
      ["B", 3, 1, false],
    ],
  ],
  [
    "Ae\u0301B",
    [
      ["A", 0, 1, false],
      ["e\u0301", 1, 1, true],
      ["B", 2, 1, false],
    ],
  ],
])("isolates original cell widths for Unicode text %s", async (content, expected) => {
  await withTerminal(content as string, {}, (terminal) => {
    expect(
      snapshotTerminalRecording(terminal).lines[0].runs.map((run) => [
        run.text,
        run.column,
        run.cells,
        run.fixedWidth,
      ]),
    ).toEqual(expected);
  });
});

test("merges adjacent matching styles and retains visible decorations", async () => {
  await withTerminal("A\x1b[0mB\x1b[2;3;4;9;53mStyled", {}, (terminal) => {
    const runs = snapshotTerminalRecording(terminal).lines[0].runs;
    expect(runs.map((run) => run.text)).toEqual(["AB", "Styled"]);
    expect(runs[1].style).toMatchObject({
      fontStyle: "italic",
      textDecorationLine: "underline line-through overline",
    });
    expect(runs[1].style.color).toContain("color-mix");
  });
});

test("retains true OSC8 labels and separates different destinations", async () => {
  await withTerminal(
    link("https://example.com/a", "View artifact") +
      link("file:///tmp/report.html", "File"),
    {},
    (terminal) => {
      const runs = snapshotTerminalRecording(terminal).lines[0].runs;
      expect(runs.map((run) => [run.text, run.url])).toEqual([
        ["View artifact", "https://example.com/a"],
        ["File", "file:///tmp/report.html"],
      ]);
      expect(runs[0].style.textDecorationLine).toContain("underline");
    },
  );
});

test("does not resurrect OSC8 links after partial overwrite or erase", async () => {
  await withTerminal(
    `${link("https://example.com/a", "Artifact")}\rXX\x1b[5G\x1b[K`,
    {},
    (terminal) => {
      const runs = snapshotTerminalRecording(terminal).lines[0].runs;
      expect(runs.map((run) => [run.text, run.url])).toEqual([
        ["XX", undefined],
        ["ti", "https://example.com/a"],
      ]);
    },
  );
});

test("keeps unsafe OSC8 labels readable without clickable destinations", async () => {
  await withTerminal(
    link("javascript:alert(1)", "Unsafe") + link("data:text/html,test", "Data"),
    {},
    (terminal) => {
      const runs = snapshotTerminalRecording(terminal).lines[0].runs;
      expect(runs.map((run) => run.text).join("")).toBe("UnsafeData");
      expect(runs.every((run) => run.url === null)).toBe(true);
    },
  );
});

test("leaves explicit labels unlinked when the pinned OSC8 adapter is unavailable", async () => {
  await withTerminal(
    link("https://example.com/target", "https://example.com/label"),
    {},
    (terminal) => {
      const core = (
        terminal as unknown as { _core: { _oscLinkService?: unknown } }
      )._core;
      const service = core._oscLinkService;
      try {
        core._oscLinkService = undefined;
        const snapshot = snapshotTerminalRecording(terminal);
        inferTerminalRecordingLinks(snapshot.lines);
        expect(snapshot.lines[0].runs[0]).toMatchObject({
          text: "https://example.com/label",
          url: null,
        });
      } finally {
        core._oscLinkService = service;
      }
    },
  );
});

test("ends a hyperlink before ordinary text and later rows", async () => {
  await withTerminal(
    `Before ${link("https://example.com/a", "Artifact")} after\r\nNext row`,
    {},
    (terminal) => {
      const linked = snapshotTerminalRecording(terminal)
        .lines.flatMap((line) => line.runs)
        .filter((run) => run.url);
      expect(linked.map((run) => run.text).join("")).toBe("Artifact");
    },
  );
});

test("preserves generated artifact links across physical soft wraps", async () => {
  await withTerminal(
    "Artifact https://example.com/\x1b[31mreport",
    { cols: 12 },
    (terminal) => {
      const result = snapshotTerminalRecording(terminal);
      inferTerminalRecordingLinks(result.lines);
      const linked = result.lines
        .flatMap((line) => line.runs)
        .filter((run) => run.url);
      expect(linked.map((run) => run.text).join("")).toBe(
        "https://example.com/report",
      );
      expect(
        linked.every((run) => run.url === "https://example.com/report"),
      ).toBe(true);
    },
  );
});

test("updates inferred targets after append and respects explicit destinations", async () => {
  await withTerminal("https://example.com/par", {}, async (terminal) => {
    const before = snapshotTerminalRecording(terminal);
    inferTerminalRecordingLinks(before.lines);
    await write(
      terminal,
      "t\r\n" +
        link("https://example.com/target", "https://example.com/label") +
        " " +
        link("javascript:alert(1)", "https://example.com/unsafe"),
    );
    const after = snapshotTerminalRecording(terminal);
    inferTerminalRecordingLinks(after.lines);
    expect(before.lines[0].runs[0].url).toBe("https://example.com/par");
    expect(after.lines[0].runs[0].url).toBe("https://example.com/part");
    expect(
      after.lines[1].runs.filter((run) => run.url).map((run) => run.url),
    ).toEqual(["https://example.com/target"]);
    expect(after.lines[1].runs.at(-1)?.url).toBeNull();
  });
});

test.each([
  50, 2000,
])("links through a wide glyph wrap across physical boundary %i", async (boundary) => {
  const url = "https://a/界report";
  await withTerminal(
    "\r\n".repeat(boundary - 1) + url,
    { cols: 11, rows: boundary + 2 },
    (terminal) => {
      const first = snapshotTerminalRecording(terminal, {
        start: 0,
        end: boundary,
      });
      const second = snapshotTerminalRecording(terminal, {
        start: boundary,
        end: boundary + 2,
      });
      const lines = [...first.lines, ...second.lines];
      expect(lines[boundary - 1].trailingPadding).toBe(1);
      inferTerminalRecordingLinks(lines);
      const linked = lines
        .flatMap((line) => line.runs)
        .filter((run) => run.url);
      expect(linked.map((run) => run.text).join("")).toBe(url);
      expect(
        linked.every((run) => run.url === "https://a/%E7%95%8Creport"),
      ).toBe(true);
      const glyph = linked.find((run) => run.text === "界");
      expect(glyph).toMatchObject({ column: 0, cells: 2, fixedWidth: true });
      expect(lines[boundary - 1].runs.map((run) => run.text).join("")).toBe(
        "https://a/ ",
      );
    },
  );
});

function textLines(
  snapshot: ReturnType<typeof snapshotTerminalRecording>,
): string[] {
  return snapshot.lines.map((line) =>
    line.runs.map((run) => run.text).join(""),
  );
}

function link(target: string, text: string): string {
  return `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function write(terminal: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve));
}

async function withTerminal(
  content: string,
  options: ConstructorParameters<typeof Terminal>[0],
  check: (terminal: Terminal) => void | Promise<void>,
): Promise<void> {
  const terminal = new Terminal({ cols: 80, rows: 8, ...options });
  try {
    await write(terminal, content);
    await check(terminal);
  } finally {
    terminal.dispose();
  }
}
