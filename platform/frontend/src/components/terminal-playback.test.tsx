import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalPlayback } from "./terminal-playback";
import { TerminalRecording } from "./terminal-recording";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("retains scrollback through alternate-screen output with safe native artifact links", async () => {
  const output = Array.from({ length: 100 }, (_, i) => `Line ${i}`).join(
    "\r\n",
  );
  render(
    <TerminalPlayback
      content={`\x1b]777;archestra-terminal-size=80x5\x07${output}\x1b[?1049h\x1b[2J\x1b[HAlternate output\r\nArtifact: https://example.com/report\r\n\x1b[?1049lDone`}
    />,
  );
  await waitFor(() => expect(screen.getByText("Done")).toBeVisible());
  expect(screen.getByText("Line 0")).toBeVisible();
  expect(screen.getByText("Alternate output")).toBeVisible();
  const link = screen.getByRole("link", { name: "https://example.com/report" });
  expect(link).toHaveAttribute("href", "https://example.com/report");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(link.style.textDecorationLine).toContain("underline");
  expect(screen.getByTestId("terminal-playback")).not.toContainHTML(
    'class="xterm',
  );
});

test("changes wrapping after emulation and keeps geometry, text, colors and links", async () => {
  render(
    <TerminalRecording
      content={
        "\x1b]777;archestra-terminal-size=20x4\x07\x1b[31mA long line that runs across the original grid\x1b[0m\r\n\x1b]8;;https://example.com/report\x1b\\View artifact\x1b]8;;\x1b\\"
      }
    />,
  );
  const link = await screen.findByRole("link", { name: "View artifact" });
  const playback = screen.getByTestId("terminal-playback");
  const text = playback.textContent;
  const physicalLines = playback.querySelectorAll("[data-terminal-row]").length;
  expect(playback).toHaveAttribute("data-recorded-cols", "20");
  expect(playback).toHaveAttribute("data-recorded-rows", "4");
  const red =
    playback.querySelector<HTMLElement>("[style*=color]")?.style.color;
  expect(red).toBe("rgb(204, 0, 0)");
  const resize = vi.spyOn(Terminal.prototype, "resize");
  const wrap = screen.getByRole("button", { name: "Wrap lines" });
  expect(wrap).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(wrap);
  expect(wrap).toHaveAttribute("aria-pressed", "true");
  expect(playback.querySelectorAll("[data-terminal-row]").length).toBeLessThan(
    physicalLines,
  );
  expect(playback.textContent).toBe(text);
  expect(playback).toHaveAttribute("data-recorded-cols", "20");
  expect(link).toHaveAttribute("href", "https://example.com/report");
  expect(
    playback.querySelector<HTMLElement>("[style*=color]")?.style.color,
  ).toBe(red);
  fireEvent(window, new Event("resize"));
  expect(resize).not.toHaveBeenCalled();
  fireEvent.click(wrap);
  expect(playback.querySelectorAll("[data-terminal-row]").length).toBe(
    physicalLines,
  );
});

test("seeking reconstructs redraws without stale output or links", async () => {
  const { rerender } = render(
    <TerminalPlayback
      content={
        "\x1b]777;archestra-terminal-size=40x5\x07Old screen\r\nhttps://example.com/old"
      }
    />,
  );
  await screen.findByRole("link");
  rerender(
    <TerminalPlayback
      content={
        "\x1b]777;archestra-terminal-size=80x6\x07\x1b[2J\x1b[HNew screen\r\n\x1b[32mReady"
      }
    />,
  );
  await screen.findByText("Ready");
  expect(screen.queryByText("Old screen")).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.getByTestId("terminal-playback")).toHaveAttribute(
    "data-recorded-cols",
    "80",
  );
});

test("keeps DOM work bounded when a large soft-wrapped artifact is reflowed", async () => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  render(
    <TerminalRecording
      content={`\x1b]777;archestra-terminal-size=80x5\x07${"x".repeat(80 * 5100)}`}
    />,
  );
  await waitFor(() =>
    expect(
      document.querySelectorAll("[data-recording-block]").length,
    ).toBeGreaterThan(100),
  );
  expect(document.querySelectorAll("[data-terminal-row]").length).toBeLessThan(
    500,
  );
  fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }));
  expect(
    document.querySelectorAll("[data-recording-block]").length,
  ).toBeGreaterThan(100);
  expect(document.querySelectorAll("[data-terminal-row]").length).toBeLessThan(
    500,
  );
});

test("a new seek cancels a large snapshot without exposing its stale content", async () => {
  const originalWrite = Terminal.prototype.write;
  const parsed = new Promise<void>((resolve) => {
    vi.spyOn(Terminal.prototype, "write").mockImplementation(function (
      this: Terminal,
      data,
      callback,
    ) {
      originalWrite.call(this, data, () => {
        callback?.();
        resolve();
      });
    });
  });
  const { rerender } = render(
    <TerminalPlayback
      content={`\x1b]777;archestra-terminal-size=80x5\x07${"Old output\r\n".repeat(6000)}`}
    />,
  );
  await act(() => parsed);
  rerender(<TerminalPlayback content="Latest screen" />);
  await screen.findByText("Latest screen");
  expect(screen.queryByText("Old output")).not.toBeInTheDocument();
});

test("appends streamed bytes and completes an artifact URL without resetting history", async () => {
  const prefix =
    "\x1b]777;archestra-terminal-size=80x5\x07First\nReport: https://exam";
  const { rerender } = render(<TerminalPlayback content={prefix} />);
  await screen.findByText("First");
  const reset = vi.spyOn(Terminal.prototype, "reset");
  rerender(
    <TerminalPlayback content={`${prefix}ple.com/report.html\nReady`} />,
  );
  await screen.findByText("Ready");
  expect(screen.getByText("First")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "https://example.com/report.html" }),
  ).toHaveAttribute("href", "https://example.com/report.html");
  expect(reset).not.toHaveBeenCalled();
});

test("replays retained text when its recorded geometry changes", async () => {
  const { rerender } = render(<TerminalPlayback content="Captured frame" />);
  await screen.findByText("Captured frame");
  expect(screen.getByTestId("terminal-playback")).toHaveAttribute(
    "data-recorded-cols",
    "120",
  );
  rerender(
    <TerminalPlayback
      content={"\x1b]777;archestra-terminal-size=90x30\x07Captured frame"}
    />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("terminal-playback")).toHaveAttribute(
      "data-recorded-cols",
      "90",
    ),
  );
  expect(screen.getByTestId("terminal-playback")).toHaveAttribute(
    "data-recorded-rows",
    "30",
  );
  expect(screen.getByText("Captured frame")).toBeVisible();
});

test("drains parsed bytes before a rapid seek and publishes only the latest position", async () => {
  const originalWrite = Terminal.prototype.write;
  let release: (() => void) | undefined;
  const parsed = new Promise<void>((resolve) => {
    vi.spyOn(Terminal.prototype, "write").mockImplementation(function (
      this: Terminal,
      data,
      callback,
    ) {
      originalWrite.call(this, data, () => {
        if (!release) {
          release = callback;
          resolve();
        } else callback?.();
      });
    });
  });
  const reset = vi.spyOn(Terminal.prototype, "reset");
  const { rerender } = render(<TerminalPlayback content="Later screen" />);
  await act(() => parsed);
  rerender(<TerminalPlayback content="Middle screen" />);
  rerender(<TerminalPlayback content="Latest screen" />);
  expect(reset).not.toHaveBeenCalled();
  await act(() => release?.());
  await screen.findByText("Latest screen");
  expect(Terminal.prototype.write).not.toHaveBeenCalledWith(
    "Middle screen",
    expect.any(Function),
  );
  expect(screen.queryByText("Later screen")).not.toBeInTheDocument();
  expect(screen.queryByText("Middle screen")).not.toBeInTheDocument();
});
