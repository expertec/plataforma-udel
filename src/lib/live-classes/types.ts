export type LiveSessionStatus = "scheduled" | "live" | "ended" | "recording_ready";
export type LiveRecordingStatus = "idle" | "recording" | "processing" | "ready" | "failed";

export type LiveRecordingData = {
  auto: boolean;
  egressId: string | null;
  status: LiveRecordingStatus;
  storagePath: string | null;
  playbackReadyAt: string | null;
  durationSec: number | null;
};

export type LiveClassSession = {
  provider: "livekit";
  roomName: string;
  status: LiveSessionStatus;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  timezone: string;
  teacherActive: boolean;
  recording: LiveRecordingData;
  lastStartedAt?: string | null;
  lastEndedAt?: string | null;
};

const LIVE_ROOM_MAX_LENGTH = 128;

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNullableString(value: unknown): string | null {
  const normalized = asTrimmedString(value);
  return normalized || null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function sanitizeRoomToken(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return cleaned || fallback;
}

export function sanitizeLiveRoomName(value: unknown, fallback = "room"): string {
  const raw = asTrimmedString(value);
  if (!raw) return sanitizeRoomToken(fallback, "room");
  const normalized = sanitizeRoomToken(raw, fallback);
  return normalized.slice(0, LIVE_ROOM_MAX_LENGTH);
}

export function buildLiveRoomName(params: {
  courseId: string;
  lessonId: string;
  classId: string;
}): string {
  const courseToken = sanitizeRoomToken(params.courseId, "course");
  const lessonToken = sanitizeRoomToken(params.lessonId, "lesson");
  const classToken = sanitizeRoomToken(params.classId, "class");
  return sanitizeLiveRoomName(`udx-${courseToken}-${lessonToken}-${classToken}`, "udx-room");
}

function asLiveStatus(value: unknown): LiveSessionStatus {
  if (value === "live" || value === "ended" || value === "recording_ready") {
    return value;
  }
  return "scheduled";
}

function asRecordingStatus(value: unknown): LiveRecordingStatus {
  if (
    value === "recording" ||
    value === "processing" ||
    value === "ready" ||
    value === "failed"
  ) {
    return value;
  }
  return "idle";
}

export function createDefaultLiveSession(params?: {
  roomName?: string;
  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;
  timezone?: string;
}): LiveClassSession {
  return {
    provider: "livekit",
    roomName: sanitizeLiveRoomName(params?.roomName, "udx-room"),
    status: "scheduled",
    scheduledStartAt: asNullableString(params?.scheduledStartAt),
    scheduledEndAt: asNullableString(params?.scheduledEndAt),
    timezone: asTrimmedString(params?.timezone ?? "") || "America/Monterrey",
    teacherActive: false,
    recording: {
      auto: true,
      egressId: null,
      status: "idle",
      storagePath: null,
      playbackReadyAt: null,
      durationSec: null,
    },
    lastStartedAt: null,
    lastEndedAt: null,
  };
}

export function normalizeLiveSession(value: unknown): LiveClassSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const recordingRaw =
    raw.recording && typeof raw.recording === "object" && !Array.isArray(raw.recording)
      ? (raw.recording as Record<string, unknown>)
      : {};

  const provider = asTrimmedString(raw.provider).toLowerCase() === "livekit" ? "livekit" : "livekit";
  const timezone = asTrimmedString(raw.timezone) || "America/Monterrey";

  return {
    provider,
    roomName: sanitizeLiveRoomName(raw.roomName, "udx-room"),
    status: asLiveStatus(raw.status),
    scheduledStartAt: asNullableString(raw.scheduledStartAt),
    scheduledEndAt: asNullableString(raw.scheduledEndAt),
    timezone,
    teacherActive: raw.teacherActive === true,
    recording: {
      auto: recordingRaw.auto !== false,
      egressId: asNullableString(recordingRaw.egressId),
      status: asRecordingStatus(recordingRaw.status),
      storagePath: asNullableString(recordingRaw.storagePath),
      playbackReadyAt: asNullableString(recordingRaw.playbackReadyAt),
      durationSec: asFiniteNumber(recordingRaw.durationSec),
    },
    lastStartedAt: asNullableString(raw.lastStartedAt),
    lastEndedAt: asNullableString(raw.lastEndedAt),
  };
}

export function createLiveSessionForClass(params: {
  courseId: string;
  lessonId: string;
  classId: string;
  input?: unknown;
}): LiveClassSession {
  const normalized = normalizeLiveSession(params.input);
  const defaultRoom = buildLiveRoomName({
    courseId: params.courseId,
    lessonId: params.lessonId,
    classId: params.classId,
  });
  const base = createDefaultLiveSession({
    roomName: normalized?.roomName || defaultRoom,
    scheduledStartAt: normalized?.scheduledStartAt ?? null,
    scheduledEndAt: normalized?.scheduledEndAt ?? null,
    timezone: normalized?.timezone ?? "America/Monterrey",
  });

  return {
    ...base,
    roomName: sanitizeLiveRoomName(normalized?.roomName || defaultRoom, defaultRoom),
    scheduledStartAt: normalized?.scheduledStartAt ?? base.scheduledStartAt,
    scheduledEndAt: normalized?.scheduledEndAt ?? base.scheduledEndAt,
    timezone: normalized?.timezone || base.timezone,
    recording: {
      ...base.recording,
      auto: normalized?.recording?.auto !== false,
    },
  };
}

export function mergeTeacherEditableLiveSession(params: {
  courseId: string;
  lessonId: string;
  classId: string;
  current?: unknown;
  input?: unknown;
}): LiveClassSession {
  const fallback = createLiveSessionForClass({
    courseId: params.courseId,
    lessonId: params.lessonId,
    classId: params.classId,
    input: params.input,
  });
  const current = normalizeLiveSession(params.current) ?? fallback;
  const incoming = normalizeLiveSession(params.input);
  const defaultRoom = buildLiveRoomName({
    courseId: params.courseId,
    lessonId: params.lessonId,
    classId: params.classId,
  });

  return {
    ...current,
    provider: "livekit",
    roomName: sanitizeLiveRoomName(
      incoming?.roomName || current.roomName || defaultRoom,
      defaultRoom,
    ),
    scheduledStartAt: incoming ? incoming.scheduledStartAt : current.scheduledStartAt,
    scheduledEndAt: incoming ? incoming.scheduledEndAt : current.scheduledEndAt,
    timezone: incoming?.timezone || current.timezone || "America/Monterrey",
    recording: {
      ...current.recording,
      auto: incoming?.recording?.auto ?? current.recording.auto,
    },
  };
}
