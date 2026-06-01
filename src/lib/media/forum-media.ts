export type ForumMediaKind = "audio" | "video";

const FORUM_AUDIO_ALLOWED_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav"]);
const FORUM_VIDEO_ALLOWED_EXTENSIONS = new Set(["mp4", "m4v"]);

const FORUM_AUDIO_ALLOWED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
  "audio/x-aac",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
]);

const FORUM_VIDEO_ALLOWED_MIME_TYPES = new Set([
  "video/mp4",
  "video/x-m4v",
]);

const FORUM_BLOCKED_EMBED_HOSTS = [
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "drive.google.com",
  "dropbox.com",
];

const AUDIO_RECORDER_MIME_CANDIDATES = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/mpeg",
  "audio/webm;codecs=opus",
  "audio/webm",
] as const;

const MIME_TYPE_TO_EXTENSION: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/x-aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "video/mp4": "mp4",
  "video/x-m4v": "m4v",
};

type AudioContextCtor = new () => AudioContext;

function clampSample(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function encodeAudioBufferAsWav(audioBuffer: AudioBuffer): ArrayBuffer {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const sampleCount = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = sampleCount * blockAlign;
  const totalLength = 44 + dataLength;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // 16-bit
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let frame = 0; frame < sampleCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = clampSample(audioBuffer.getChannelData(channel)[frame] ?? 0);
      const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, Math.round(value), true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}

function createAudioContextInstance(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const windowWithLegacy = window as typeof window & {
    webkitAudioContext?: AudioContextCtor;
  };
  const Ctor: AudioContextCtor | undefined = window.AudioContext ?? windowWithLegacy.webkitAudioContext;
  if (!Ctor) return null;
  return new Ctor();
}

function isBlockedMediaHost(hostname: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  return FORUM_BLOCKED_EMBED_HOSTS.some(
    (host) => normalizedHost === host || normalizedHost.endsWith(`.${host}`),
  );
}

export function normalizeMediaMimeType(value: string | null | undefined): string {
  if (!value) return "";
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function getMediaFileExtension(fileName: string): string {
  if (!fileName) return "";
  const cleanName = fileName.split(/[?#]/)[0] ?? "";
  const parts = cleanName.split(".");
  if (parts.length < 2) return "";
  return (parts.pop() ?? "").trim().toLowerCase();
}

export function isForumAudioTranscodeCandidate(file: File): boolean {
  const mimeType = normalizeMediaMimeType(file.type);
  const extension = getMediaFileExtension(file.name);
  return mimeType.includes("webm") ||
    mimeType.includes("ogg") ||
    mimeType.includes("opus") ||
    extension === "webm" ||
    extension === "ogg" ||
    extension === "oga" ||
    extension === "opus";
}

export function pickPreferredAudioRecordingMimeType(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return null;
  }

  for (const candidate of AUDIO_RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolvePreferredExtensionForMimeType(
  mimeType: string | null | undefined,
  fallbackExtension: string,
): string {
  const normalized = normalizeMediaMimeType(mimeType);
  return MIME_TYPE_TO_EXTENSION[normalized] ?? fallbackExtension;
}

export async function transcodeAudioFileToWav(file: File): Promise<File> {
  const context = createAudioContextInstance();
  if (!context) {
    throw new Error("NO_AUDIO_CONTEXT");
  }

  try {
    const sourceBuffer = await file.arrayBuffer();
    const decoded = await context.decodeAudioData(sourceBuffer.slice(0));
    const wavBuffer = encodeAudioBufferAsWav(decoded);
    const baseName = file.name.replace(/\.[^./\\]+$/, "") || `audio-${Date.now()}`;
    return new File([wavBuffer], `${baseName}.wav`, {
      type: "audio/wav",
    });
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function validateForumMediaFile(
  kind: ForumMediaKind,
  file: File,
): string | null {
  if (!file || file.size <= 0) {
    return "El archivo está vacío o no se pudo leer.";
  }

  const extension = getMediaFileExtension(file.name);
  const mimeType = normalizeMediaMimeType(file.type);

  if (kind === "audio") {
    const extensionAllowed = extension.length > 0 && FORUM_AUDIO_ALLOWED_EXTENSIONS.has(extension);
    const mimeAllowed = mimeType.length > 0 && FORUM_AUDIO_ALLOWED_MIME_TYPES.has(mimeType);
    if (!extensionAllowed && !mimeAllowed) {
      return "Audio no compatible. Usa MP3, M4A, AAC o WAV.";
    }
    return null;
  }

  const extensionAllowed = extension.length > 0 && FORUM_VIDEO_ALLOWED_EXTENSIONS.has(extension);
  const mimeAllowed = mimeType.length > 0 && FORUM_VIDEO_ALLOWED_MIME_TYPES.has(mimeType);
  if (!extensionAllowed && !mimeAllowed) {
    return "Video no compatible. Usa MP4 (H.264/AAC).";
  }

  return null;
}

export function validateForumMediaUrl(
  kind: ForumMediaKind,
  rawUrl: string,
): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "El enlace no es válido. Usa una URL directa al archivo.";
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "El enlace debe iniciar con http:// o https://";
  }

  if (isBlockedMediaHost(parsed.hostname)) {
    return "Ese enlace es de una página embebida. Usa URL directa del archivo de audio.";
  }

  const extension = getMediaFileExtension(parsed.pathname);
  if (!extension) {
    return "El enlace debe apuntar directo al archivo (.mp3, .m4a, .aac o .wav).";
  }

  if (kind === "audio" && !FORUM_AUDIO_ALLOWED_EXTENSIONS.has(extension)) {
    return "El enlace debe ser de audio MP3, M4A, AAC o WAV.";
  }

  if (kind === "video" && !FORUM_VIDEO_ALLOWED_EXTENSIONS.has(extension)) {
    return "El enlace debe ser de video MP4.";
  }

  return null;
}
