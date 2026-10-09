import { invoke } from "@tauri-apps/api/core";
import type { SerializedFrame } from "../embeddings/embedding.worker";

/**
 * Video frame extraction.
 *
 * `<video>` and `<canvas>` only exist on the main thread — a module worker has
 * no `document` — so frames are decoded here and shipped to the embedding
 * worker as plain data. Inference stays off the main thread; only the decode
 * runs on it.
 *
 * Frames are sampled uniformly across the video's duration rather than
 * sequentially, so a two-hour recording and a ten-second clip produce equally
 * representative coverage.
 */

/** Frames kept per video. 32 is the model card's default subsample ceiling. */
export const DEFAULT_FRAME_COUNT = 16;

/** Widest frame we decode. Larger frames are downscaled by the browser. */
const MAX_FRAME_WIDTH = 512;

export type ExtractedVideo = {
  frames: SerializedFrame[];
  durationSeconds: number;
  width: number;
  height: number;
};

/** Decode a video file into a bounded set of RGB frames. */
export async function extractVideoFrames(
  path: string,
  frameCount = DEFAULT_FRAME_COUNT,
): Promise<ExtractedVideo> {
  const bytes = await invoke<ArrayBuffer>("read_media_bytes", { path });
  const blob = new Blob([bytes], { type: mimeFor(path) });
  const url = URL.createObjectURL(blob);

  try {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error("Timed out loading the video.")),
        30_000,
      );
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("The browser could not decode this video."));
      };
      video.src = url;
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0) {
      throw new Error("The video reports no duration and cannot be sampled.");
    }

    const scale = Math.min(1, MAX_FRAME_WIDTH / (video.videoWidth || MAX_FRAME_WIDTH));
    const width = Math.max(1, Math.round((video.videoWidth || 320) * scale));
    const height = Math.max(1, Math.round((video.videoHeight || 240) * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("A 2D canvas context is unavailable, so frames cannot be read.");
    }

    const frames: SerializedFrame[] = [];

    for (let i = 0; i < frameCount; i++) {
      // Sample evenly, avoiding the very first and last frame, which are often
      // black or a fade.
      const position = duration * ((i + 0.5) / frameCount);
      await seekTo(video, position);
      context.drawImage(video, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      frames.push({
        data: new Uint8ClampedArray(pixels.data),
        width,
        height,
        channels: 3,
      });
    }

    return { frames, durationSeconds: duration, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    // A no-op seek (already exactly here) still fires `seeked`.
    video.currentTime = Math.max(0, Math.min(seconds, video.duration - 0.05));
  });
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  m4v: "video/mp4",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? "video/mp4";
}
