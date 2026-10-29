/**
 * Shares the current tab through the screen-share API so a feedback comment
 * can carry real pixels: a still frame for the screenshot, and a clip the
 * user records on demand.
 *
 * The clip is recorded from a canvas of fixed, even dimensions rather than
 * from the share itself: the share follows the tab's size, and Chrome's
 * H.264 recorder writes a corrupt file when that size changes mid-recording
 * or is odd.
 */
class ScreenRecorder {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private recording: Recording | null = null;
  private endedListener: (() => void) | null = null;

  get isActive(): boolean {
    return this.stream?.active ?? false;
  }

  get isRecording(): boolean {
    return this.recording !== null;
  }

  /** Asks for the tab share. Resolves false when declined or unsupported. */
  async start(onEnded: () => void): Promise<boolean> {
    if (this.isActive) return true;
    if (!navigator.mediaDevices?.getDisplayMedia) return false;
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: FRAME_RATE },
        audio: false,
        // Chromium: offer the current tab first and skip the picker's
        // window/screen tabs where possible.
        preferCurrentTab: true,
        selfBrowserSurface: "include",
      } as DisplayMediaStreamOptions);
    } catch {
      return false;
    }

    this.endedListener = () => {
      this.stop();
      onEnded();
    };
    this.stream
      .getVideoTracks()[0]
      ?.addEventListener("ended", this.endedListener);

    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);
    return true;
  }

  /** The current frame, at the stream's native resolution. */
  captureFrame(): HTMLCanvasElement | null {
    const video = this.video;
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    return canvas;
  }

  /** Starts a clip. Returns false without an active share or recorder. */
  startRecording(): boolean {
    const video = this.video;
    if (this.recording) return true;
    if (!video?.videoWidth || typeof MediaRecorder === "undefined") {
      return false;
    }
    const width = even(Math.min(MAX_CLIP_WIDTH, video.videoWidth));
    const height = even((video.videoHeight * width) / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return false;

    // Letterboxed, so a tab resized mid-clip keeps its proportions.
    const draw = () => {
      const scale = Math.min(
        width / video.videoWidth,
        height / video.videoHeight,
      );
      const drawWidth = video.videoWidth * scale;
      const drawHeight = video.videoHeight * scale;
      context.fillStyle = "#000000";
      context.fillRect(0, 0, width, height);
      context.drawImage(
        video,
        (width - drawWidth) / 2,
        (height - drawHeight) / 2,
        drawWidth,
        drawHeight,
      );
    };
    draw();
    const drawTimer = setInterval(draw, 1000 / FRAME_RATE);

    const recorder = new MediaRecorder(canvas.captureStream(FRAME_RATE), {
      mimeType: pickMimeType(),
      // A full minute stays near 19 MB, about 25 MB base64, under the
      // comment route's 40 MB body limit.
      videoBitsPerSecond: 2_500_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start(1000);
    this.recording = { recorder, chunks, drawTimer };
    return true;
  }

  /** Ends the clip and returns it as one playable file. */
  stopRecording(): Promise<Blob | null> {
    const recording = this.recording;
    this.recording = null;
    if (!recording) return Promise.resolve(null);
    const { recorder, chunks, drawTimer } = recording;
    return new Promise((resolve) => {
      recorder.onstop = () => {
        clearInterval(drawTimer);
        resolve(
          chunks.length > 0
            ? new Blob(chunks, { type: recorder.mimeType.split(";")[0] })
            : null,
        );
      };
      recorder.stop();
    });
  }

  stop() {
    if (this.recording) {
      clearInterval(this.recording.drawTimer);
      this.recording.recorder.ondataavailable = null;
      if (this.recording.recorder.state !== "inactive") {
        this.recording.recorder.stop();
      }
      this.recording = null;
    }
    if (this.stream && this.endedListener) {
      this.stream
        .getVideoTracks()[0]
        ?.removeEventListener("ended", this.endedListener);
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video = null;
  }
}

export const screenRecorder = new ScreenRecorder();

// ===

const FRAME_RATE = 15;
/** Wide enough to read UI text, small enough for a minute-long upload. */
const MAX_CLIP_WIDTH = 1920;

type Recording = {
  recorder: MediaRecorder;
  chunks: Blob[];
  drawTimer: ReturnType<typeof setInterval>;
};

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function pickMimeType(): string | undefined {
  // MP4 first: Slack plays it inline everywhere; WebM is the fallback.
  return [
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type));
}
