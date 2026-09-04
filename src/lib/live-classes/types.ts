export type LiveSessionStatus = "scheduled" | "live" | "ended" | "recording_ready";
export type LiveRecordingStatus = "idle" | "recording" | "processing" | "ready" | "failed";
export type LiveWaitingRoomParticipantStatus = "pending" | "admitted" | "rejected";

const DEFAULT_RECORDING_MAX_RETRY_COUNT = 1;

export type LiveRecordingData = {
  auto: boolean;
  egressId: string | null;
  status: LiveRecordingStatus;
  storagePath: string | null;
  backupManifestPath: string | null;
  backupLiveManifestPath: string | null;
  playbackReadyAt: string | null;
  durationSec: number | null;
  errorMessage: string | null;
  errorCode: number | null;
  retryCount: number;
  maxRetryCount: number;
  lastRetryAt: string | null;
};

export type LiveWaitingRoomParticipant = {
  uid: string;
  displayName: string;
  email: string;
  status: LiveWaitingRoomParticipantStatus;
  requestedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  updatedAt: string | null;
};

export type LiveWaitingRoomData = {
  enabled: boolean;
  participants: Record<string, LiveWaitingRoomParticipant>;
};

export type LiveClassSession = {
  provider: "livekit";
  roomName: string;
  status: LiveSessionStatus;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  timezone: string;
  teacherActive: boolean;
  waitingRoom: LiveWaitingRoomData;
  recording: LiveRecordingData;
  lastStartedAt?: string | null;
  lastEndedAt?: string | null;
  lastEndedById?: string | null;
  lastEndedByName?: string | null;
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

function asNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
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

function asWaitingRoomStatus(value: unknown): LiveWaitingRoomParticipantStatus {
  if (value === "admitted" || value === "rejected") return value;
  return "pending";
}

function normalizeWaitingRoomParticipant(
  uid: string,
  value: unknown,
): LiveWaitingRoomParticipant | null {
  if (!uid || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    uid,
    displayName: asTrimmedString(raw.displayName) || asTrimmedString(raw.name) || "Alumno",
    email: asTrimmedString(raw.email),
    status: asWaitingRoomStatus(raw.status),
    requestedAt: asNullableString(raw.requestedAt),
    decidedAt: asNullableString(raw.decidedAt),
    decidedBy: asNullableString(raw.decidedBy),
    updatedAt: asNullableString(raw.updatedAt),
  };
}

function normalizeWaitingRoom(value: unknown): LiveWaitingRoomData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      enabled: true,
      participants: {},
    };
  }

  const raw = value as Record<string, unknown>;
  const participantsRaw =
    raw.participants && typeof raw.participants === "object" && !Array.isArray(raw.participants)
      ? (raw.participants as Record<string, unknown>)
      : {};
  const participants: Record<string, LiveWaitingRoomParticipant> = {};
  Object.entries(participantsRaw).forEach(([uid, participantRaw]) => {
    const normalizedUid = asTrimmedString(uid);
    const participant = normalizeWaitingRoomParticipant(normalizedUid, participantRaw);
    if (participant) {
      participants[normalizedUid] = participant;
    }
  });

  return {
    enabled: raw.enabled !== false,
    participants,
  };
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
    waitingRoom: {
      enabled: true,
      participants: {},
    },
    recording: {
      auto: false,
      egressId: null,
      status: "idle",
      storagePath: null,
      backupManifestPath: null,
      backupLiveManifestPath: null,
      playbackReadyAt: null,
      durationSec: null,
      errorMessage: null,
      errorCode: null,
      retryCount: 0,
      maxRetryCount: DEFAULT_RECORDING_MAX_RETRY_COUNT,
      lastRetryAt: null,
    },
    lastStartedAt: null,
    lastEndedAt: null,
    lastEndedById: null,
    lastEndedByName: null,
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
    waitingRoom: normalizeWaitingRoom(raw.waitingRoom),
    recording: {
      auto: recordingRaw.auto === true,
      egressId: asNullableString(recordingRaw.egressId),
      status: asRecordingStatus(recordingRaw.status),
      storagePath: asNullableString(recordingRaw.storagePath),
      backupManifestPath: asNullableString(recordingRaw.backupManifestPath),
      backupLiveManifestPath: asNullableString(recordingRaw.backupLiveManifestPath),
      playbackReadyAt: asNullableString(recordingRaw.playbackReadyAt),
      durationSec: asFiniteNumber(recordingRaw.durationSec),
      errorMessage: asNullableString(recordingRaw.errorMessage),
      errorCode: asFiniteNumber(recordingRaw.errorCode),
      retryCount: asNonNegativeInteger(recordingRaw.retryCount, 0),
      maxRetryCount: asNonNegativeInteger(
        recordingRaw.maxRetryCount,
        DEFAULT_RECORDING_MAX_RETRY_COUNT,
      ),
      lastRetryAt: asNullableString(recordingRaw.lastRetryAt),
    },
    lastStartedAt: asNullableString(raw.lastStartedAt),
    lastEndedAt: asNullableString(raw.lastEndedAt),
    lastEndedById: asNullableString(raw.lastEndedById),
    lastEndedByName: asNullableString(raw.lastEndedByName),
  };
}

export function createLiveSessionForClass(params: {
  courseId: string;
  lessonId: string;
  classId: string;
  input?: unknown;
}): LiveClassSession {
  const normalized = normalizeLiveSession(params.input);
  const classScopedRoom = buildLiveRoomName({
    courseId: params.courseId,
    lessonId: params.lessonId,
    classId: params.classId,
  });
  const base = createDefaultLiveSession({
    roomName: classScopedRoom,
    scheduledStartAt: normalized?.scheduledStartAt ?? null,
    scheduledEndAt: normalized?.scheduledEndAt ?? null,
    timezone: normalized?.timezone ?? "America/Monterrey",
  });

  return {
    ...base,
    // Room name must be class-scoped to avoid collisions between simultaneous live classes.
    roomName: classScopedRoom,
    scheduledStartAt: normalized?.scheduledStartAt ?? base.scheduledStartAt,
    scheduledEndAt: normalized?.scheduledEndAt ?? base.scheduledEndAt,
    timezone: normalized?.timezone || base.timezone,
    recording: {
      ...base.recording,
      // Auto-recording is intentionally disabled project-wide to control LiveKit egress costs.
      auto: false,
    },
    waitingRoom: normalized?.waitingRoom ?? base.waitingRoom,
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
  const classScopedRoom = buildLiveRoomName({
    courseId: params.courseId,
    lessonId: params.lessonId,
    classId: params.classId,
  });

  return {
    ...current,
    provider: "livekit",
    // Keep room deterministic by class identity; do not trust roomName from client payload.
    roomName: classScopedRoom,
    scheduledStartAt: incoming ? incoming.scheduledStartAt : current.scheduledStartAt,
    scheduledEndAt: incoming ? incoming.scheduledEndAt : current.scheduledEndAt,
    timezone: incoming?.timezone || current.timezone || "America/Monterrey",
    waitingRoom: current.waitingRoom,
    recording: {
      ...current.recording,
      // Keep disabled even if legacy payloads still send `recording.auto = true`.
      auto: false,
    },
  };
}
