import {
  browserLanguagePreferences,
  resolveSpeechRecognitionLocale,
} from "./speech-locale";

export interface RecognitionResult {
  isFinal: boolean;
  readonly [index: number]: { transcript: string };
}

export interface DictationRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
}

export type DictationState = {
  phase: "idle" | "starting" | "recording" | "transcribing" | "error";
  transcript: string;
  error?: string;
};

/** A user session spans browser recognition runs. No audio is stored here. */
export class DictationSession {
  private recognition: DictationRecognition | null = null;
  private completed = "";
  private results = "";
  private intent: "stop" | "send" | null = null;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private restarts: number[] = [];
  private fallback = false;
  private state: DictationState = { phase: "idle", transcript: "" };

  constructor(
    private readonly create: () => DictationRecognition,
    private readonly changed: (state: DictationState) => void,
    private readonly finished: (transcript: string, send: boolean) => void,
  ) {}

  private publish(phase: DictationState["phase"], error?: string) {
    this.state = {
      phase,
      transcript: [this.completed, this.results]
        .filter(Boolean)
        .join(" ")
        .trim(),
      error,
    };
    this.changed(this.state);
  }

  start() {
    if (this.recognition || !["idle", "error"].includes(this.state.phase))
      return;
    this.intent = null;
    this.fallback = false;
    this.restarts = [];
    // Retry continues the recoverable transcript, rather than discarding it.
    this.publish("starting");
    this.run();
  }

  private run() {
    const startedAt = Date.now();
    const recognition = this.create();
    this.recognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.fallback
      ? ""
      : (resolveSpeechRecognitionLocale(browserLanguagePreferences()) ?? "");
    const current = () => this.recognition === recognition;
    recognition.onstart = () => {
      if (current() && !this.intent) this.publish("recording");
    };
    recognition.onresult = (event) => {
      if (!current()) return;
      this.restarts = [];
      // Results are a cumulative, indexed snapshot for THIS browser run.
      // Replacing it handles interim revisions and repeated final results.
      this.results = Array.from(
        event.results,
        (result) => result[0]?.transcript.trim() ?? "",
      )
        .filter(Boolean)
        .join(" ");
      this.publish(this.state.phase);
    };
    recognition.onerror = ({ error }) => {
      if (!current()) return;
      if (error === "no-speech") return;
      if (
        error === "language-not-supported" &&
        !this.fallback &&
        !this.intent
      ) {
        this.fallback = true;
        return; // Restart only after onend, never while the engine is stopping.
      }
      this.fail(
        error === "not-allowed" || error === "service-not-allowed"
          ? "Microphone permission denied. Allow microphone access in your browser, then retry."
          : `Voice input interrupted (${error}). Keep the transcript or retry.`,
      );
    };
    recognition.onend = () => {
      if (!current()) return;
      this.recognition = null;
      this.completed = [this.completed, this.results]
        .filter(Boolean)
        .join(" ")
        .trim();
      this.results = "";
      if (this.intent) {
        clearTimeout(this.timeout);
        const send = this.intent === "send";
        this.intent = null;
        const transcript = this.completed;
        this.completed = "";
        this.publish("idle");
        this.finished(transcript, send);
        return;
      }
      // Ordinary no-speech timeouts must never exhaust a session budget.
      // Only an engine that repeatedly exits immediately is a restart loop.
      this.restarts =
        Date.now() - startedAt >= 1_000
          ? []
          : this.restarts.filter((time) => Date.now() - time < 30_000);
      if (this.restarts.length >= 5) {
        this.fail(
          "The browser repeatedly stopped listening. Keep the transcript or retry.",
        );
        return;
      }
      this.restarts.push(Date.now());
      this.publish("starting");
      this.run();
    };
    try {
      recognition.start();
    } catch {
      this.fail(
        "Voice input could not start. Check microphone access, then retry.",
      );
    }
  }

  finish(send: boolean) {
    if (this.intent || this.state.phase === "idle") return;
    if (this.state.phase === "error") {
      const transcript = this.state.transcript;
      this.completed = this.results = "";
      this.publish("idle");
      this.finished(transcript, false); // An interrupted recording never auto-sends.
      return;
    }
    this.intent = send ? "send" : "stop";
    this.publish("transcribing");
    this.timeout = setTimeout(
      () =>
        this.fail(
          "Transcription timed out. Keep the available transcript or retry; nothing was sent.",
        ),
      10_000,
    );
    try {
      this.recognition?.stop();
    } catch {
      this.fail(
        "Transcription could not finish. Keep the available transcript or retry.",
      );
    }
  }

  private fail(message: string) {
    clearTimeout(this.timeout);
    this.intent = null;
    const recognition = this.recognition;
    this.recognition = null;
    recognition?.abort();
    this.completed = [this.completed, this.results]
      .filter(Boolean)
      .join(" ")
      .trim();
    this.results = "";
    this.publish("error", message);
  }

  cancel() {
    clearTimeout(this.timeout);
    this.intent = null;
    const recognition = this.recognition;
    this.recognition = null;
    recognition?.abort();
    this.completed = this.results = "";
    this.publish("idle");
  }
}
