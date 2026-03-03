import { formatBytes } from "../utils/strings.mts";

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

export class ProgressBar {
  #current = 0;
  #lastRender = 0;
  #startTime = Date.now();

  constructor(
    private readonly label: string,
    private readonly total?: number,
  ) {}

  update(current: number, detail?: string): void {
    this.#current = current;
    const now = Date.now();
    if (!process.stdout.isTTY && now - this.#lastRender < 1_000) {
      return;
    }
    if (process.stdout.isTTY && now - this.#lastRender < 80) {
      return;
    }

    this.#lastRender = now;
    this.render(detail);
  }

  finish(detail?: string): void {
    this.#current = this.total ?? this.#current;
    this.render(detail);
    process.stdout.write("\n");
  }

  private render(detail?: string): void {
    const elapsed = Date.now() - this.#startTime;
    const prefix = `${this.label}: `;

    if (!process.stdout.isTTY) {
      const suffix = detail ? ` ${detail}` : "";
      process.stdout.write(`${prefix}${this.#current}${this.total ? `/${this.total}` : ""}${suffix}\n`);
      return;
    }

    if (!this.total || this.total <= 0) {
      const suffix = detail ? ` ${detail}` : "";
      process.stdout.write(`\r${prefix}${this.#current}${suffix}`);
      return;
    }

    const width = 24;
    const ratio = Math.max(0, Math.min(1, this.#current / this.total));
    const filled = Math.round(width * ratio);
    const bar = `${"=".repeat(filled)}${" ".repeat(width - filled)}`;
    const percent = `${Math.round(ratio * 100)}`.padStart(3, " ");
    const speed = this.#current > 0 ? `${formatBytes((this.#current / elapsed) * 1000)}/s` : "0 B/s";
    const eta =
      this.#current > 0 && this.#current < this.total
        ? formatDuration(((this.total - this.#current) / this.#current) * elapsed)
        : "0s";
    const suffix = detail ? ` ${detail}` : "";

    process.stdout.write(`\r${prefix}[${bar}] ${percent}% ${formatBytes(this.#current)}/${formatBytes(this.total)} ${speed} ETA ${eta}${suffix}`);
  }
}

export class Spinner {
  #frameIndex = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #frames = ["-", "\\", "|", "/"];

  constructor(private readonly label: string) {}

  start(detail?: string): void {
    if (!process.stdout.isTTY) {
      process.stdout.write(`${this.label}${detail ? ` ${detail}` : ""}\n`);
      return;
    }

    this.#timer = setInterval(() => {
      const frame = this.#frames[this.#frameIndex % this.#frames.length];
      this.#frameIndex += 1;
      process.stdout.write(`\r${frame} ${this.label}${detail ? ` ${detail}` : ""}`);
    }, 90);
  }

  stop(detail?: string): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    if (process.stdout.isTTY) {
      process.stdout.write(`\r${this.label}${detail ? ` ${detail}` : ""}\n`);
      return;
    }

    if (detail) {
      process.stdout.write(`${this.label} ${detail}\n`);
    }
  }
}
