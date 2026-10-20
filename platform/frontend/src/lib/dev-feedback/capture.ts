type Rect = { left: number; top: number; width: number; height: number };

/**
 * A JPEG of the captured frame with the commented element outlined, the pin
 * drawn where it was dropped, and the comment beside it, so the picture reads
 * on its own in Slack. The frame is the tab at its native pixel size, so page
 * coordinates are scaled by the frame-to-viewport ratio.
 */
export async function annotateFrame(params: {
  frame: HTMLCanvasElement;
  elementRect: Rect;
  pin: { x: number; y: number };
  comment: string;
}): Promise<{ mimeType: "image/jpeg"; base64: string } | null> {
  const { elementRect, pin } = params;
  // Draw on a copy: a retried post must not stack a second outline.
  const frame = document.createElement("canvas");
  frame.width = params.frame.width;
  frame.height = params.frame.height;
  const context = frame.getContext("2d");
  if (!context) return null;
  context.drawImage(params.frame, 0, 0);
  const scale = frame.width / window.innerWidth;

  context.lineWidth = 3 * scale;
  context.strokeStyle = MARK_COLOR;
  context.strokeRect(
    elementRect.left * scale,
    elementRect.top * scale,
    elementRect.width * scale,
    elementRect.height * scale,
  );
  context.beginPath();
  context.arc(pin.x * scale, pin.y * scale, 8 * scale, 0, Math.PI * 2);
  context.fillStyle = MARK_COLOR;
  context.fill();
  context.lineWidth = 2 * scale;
  context.strokeStyle = "#ffffff";
  context.stroke();
  drawCommentBubble({ context, scale, pin, comment: params.comment });

  const blob = await new Promise<Blob | null>((resolve) =>
    frame.toBlob(resolve, "image/jpeg", 0.85),
  );
  return blob ? { mimeType: "image/jpeg", base64: await toBase64(blob) } : null;
}

export async function toBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

// ===

const MARK_COLOR = "#2563eb";
const BUBBLE = {
  maxWidth: 280,
  maxLines: 8,
  fontSize: 14,
  lineHeight: 20,
  padding: 10,
  gap: 14,
};

/**
 * The comment in a card beside the pin: to its right, or to its left when it
 * would run off the frame, and kept inside the frame vertically. Sizes are in
 * page pixels and scaled like everything else.
 */
function drawCommentBubble(params: {
  context: CanvasRenderingContext2D;
  scale: number;
  pin: { x: number; y: number };
  comment: string;
}) {
  const { context, scale, pin } = params;
  const s = (value: number) => value * scale;
  context.font = `${s(BUBBLE.fontSize)}px ui-sans-serif, system-ui, sans-serif`;
  const lines = wrapText({
    context,
    text: params.comment,
    maxWidth: s(BUBBLE.maxWidth - BUBBLE.padding * 2),
  });
  const width =
    Math.max(...lines.map((line) => context.measureText(line).width)) +
    s(BUBBLE.padding * 2);
  const height = lines.length * s(BUBBLE.lineHeight) + s(BUBBLE.padding * 2);
  const frameWidth = context.canvas.width;
  const frameHeight = context.canvas.height;

  let left = s(pin.x + BUBBLE.gap);
  if (left + width > frameWidth) left = s(pin.x - BUBBLE.gap) - width;
  left = Math.max(s(4), left);
  const top = Math.min(
    Math.max(s(4), s(pin.y) - s(BUBBLE.padding + BUBBLE.lineHeight / 2)),
    frameHeight - height - s(4),
  );

  context.save();
  context.shadowColor = "rgba(0, 0, 0, 0.25)";
  context.shadowBlur = s(8);
  context.shadowOffsetY = s(2);
  context.beginPath();
  context.roundRect(left, top, width, height, s(8));
  context.fillStyle = "#ffffff";
  context.fill();
  context.restore();
  context.lineWidth = s(2);
  context.strokeStyle = MARK_COLOR;
  context.stroke();

  context.fillStyle = "#111827";
  context.textBaseline = "middle";
  lines.forEach((line, index) => {
    context.fillText(
      line,
      left + s(BUBBLE.padding),
      top + s(BUBBLE.padding + BUBBLE.lineHeight * (index + 0.5)),
    );
  });
}

/** Word-wraps to the bubble width, keeping explicit line breaks. */
function wrapText(params: {
  context: CanvasRenderingContext2D;
  text: string;
  maxWidth: number;
}): string[] {
  const { context, maxWidth } = params;
  const fits = (line: string) => context.measureText(line).width <= maxWidth;
  const lines: string[] = [];
  for (const paragraph of params.text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate) || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
      // A single word wider than the bubble is cut rather than overflowing.
      while (!fits(line) && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && !fits(line.slice(0, cut))) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  if (lines.length <= BUBBLE.maxLines) return lines;
  const kept = lines.slice(0, BUBBLE.maxLines);
  kept[kept.length - 1] = `${kept[kept.length - 1].replace(/.$/, "")}…`;
  return kept;
}
