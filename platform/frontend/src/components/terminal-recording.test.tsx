import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { TerminalRecording } from "./terminal-recording";

vi.mock("./terminal-playback", () => ({
  TerminalPlayback: ({ content }: { content: string }) => (
    <pre data-testid="recorded-bytes">{content}</pre>
  ),
}));

test("falls back to the end when a refreshed recording no longer contains the selected position", () => {
  const { rerender } = render(
    <TerminalRecording
      content={"Earlier recorded output\r\n\x1b[2JFinal output"}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Previous recorded screen" }),
  );
  const shorterRecording = "a\r\nb";
  rerender(<TerminalRecording content={shorterRecording} />);
  expect(screen.getByTestId("recorded-bytes").textContent).toBe(
    shorterRecording,
  );
  expect(screen.getByRole("button", { name: "Recording end" })).toBeDisabled();
});

test("rewinds before a screen clear, stays at that position as output arrives, and returns to the end", () => {
  const early = "Early result\r\n";
  const recording = `${early}\x1b[2JFinal result`;
  const { rerender } = render(<TerminalRecording content={recording} />);
  expect(screen.getByTestId("recorded-bytes").textContent).toBe(recording);
  fireEvent.click(
    screen.getByRole("button", { name: "Previous recorded screen" }),
  );
  expect(screen.getByTestId("recorded-bytes").textContent).toBe(early);
  rerender(<TerminalRecording content={`${recording}\r\nLater output`} />);
  expect(screen.getByTestId("recorded-bytes").textContent).toBe(early);
  fireEvent.click(screen.getByRole("button", { name: "Recording end" }));
  expect(screen.getByTestId("recorded-bytes").textContent).toBe(
    `${recording}\r\nLater output`,
  );
});
