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

const EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  wave: "audio/wav",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
};

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
    mimeType === "audio/mp4" ||
    mimeType === "audio/x-m4a" ||
    mimeType === "audio/m4a" ||
    mimeType === "audio/aac" ||
    mimeType === "audio/x-aac" ||
    extension === "webm" ||
    extension === "ogg" ||
    extension === "oga" ||
    extension === "opus" ||
    extension === "m4a" ||
    extension === "aac";
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

export function resolvePreferredExtensionForMediaFile(
  file: File,
  fallbackExtension: string,
): string {
  const normalizedMime = normalizeMediaMimeType(file.type);
  const extensionFromMime = MIME_TYPE_TO_EXTENSION[normalizedMime];
  if (extensionFromMime) return extensionFromMime;

  const extensionFromName = getMediaFileExtension(file.name);
  if (extensionFromName in EXTENSION_TO_MIME_TYPE) {
    return extensionFromName;
  }

  return fallbackExtension;
}

export function resolvePreferredContentTypeForMediaFile(
  file: File,
  fallbackContentType: string,
): string {
  const normalizedMime = normalizeMediaMimeType(file.type);
  if (normalizedMime) return normalizedMime;

  const extensionFromName = getMediaFileExtension(file.name);
  return EXTENSION_TO_MIME_TYPE[extensionFromName] ?? fallbackContentType;
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
