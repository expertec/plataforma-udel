import type { DocumentReference, QueryDocumentSnapshot } from "firebase-admin/firestore";

export type LiveAttendanceParticipantInput = {
  identity: string;
  name: string | null;
  role: string | null;
  uid: string | null;
};

export type LiveAttendanceRecord = {
  participantIdentity: string;
  studentId: string;
  studentName: string | null;
  role: string | null;
  roomName: string;
  courseId: string;
  lessonId: string;
  classId: string;
  firstJoinedAt: string | null;
  lastJoinedAt: string | null;
  lastLeftAt: string | null;
  activeSessionStartedAt: string | null;
  connected: boolean;
  joinCount: number;
  totalSeconds: number;
  cameraOnCount: number | null;
  cameraOnSeconds: number | null;
  cameraActiveStartedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type AttendanceContext = {
  classRef: DocumentReference;
  classId: string;
  courseId: string;
  lessonId: string;
  roomName: string;
};

const ATTENDANCE_COLLECTION = "attendance";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNullableText(value: unknown): string | null {
  const text = normalizeText(value);
  return text || null;
}

function asNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function asNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function toMillis(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value === "object" && value !== null) {
    if ("toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      try {
        const millis = (value as { toMillis: () => number }).toMillis();
        return Number.isFinite(millis) ? millis : null;
      } catch {
        return null;
      }
    }
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        const millis = (value as { toDate: () => Date }).toDate().getTime();
        return Number.isFinite(millis) ? millis : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function secondsBetween(start: unknown, endIso: string): number {
  const startMs = toMillis(start);
  const endMs = Date.parse(endIso);
  if (startMs === null || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.round((endMs - startMs) / 1000);
}

function attendanceDocId(identity: string): string {
  return encodeURIComponent(identity).replace(/\./g, "%2E").slice(0, 120) || "participant";
}

function attendanceRef(classRef: DocumentReference, identity: string) {
  return classRef.collection(ATTENDANCE_COLLECTION).doc(attendanceDocId(identity));
}

function mapAttendanceDoc(docSnap: QueryDocumentSnapshot): LiveAttendanceRecord {
  const data = (docSnap.data() ?? {}) as Record<string, unknown>;
  return {
    participantIdentity: normalizeText(data.participantIdentity) || docSnap.id,
    studentId: normalizeText(data.studentId) || normalizeText(data.participantIdentity) || docSnap.id,
    studentName: asNullableText(data.studentName),
    role: asNullableText(data.role),
    roomName: normalizeText(data.roomName),
    courseId: normalizeText(data.courseId),
    lessonId: normalizeText(data.lessonId),
    classId: normalizeText(data.classId),
    firstJoinedAt: asNullableText(data.firstJoinedAt),
    lastJoinedAt: asNullableText(data.lastJoinedAt),
    lastLeftAt: asNullableText(data.lastLeftAt),
    activeSessionStartedAt: asNullableText(data.activeSessionStartedAt),
    connected: data.connected === true,
    joinCount: asNonNegativeInteger(data.joinCount),
    totalSeconds: asNonNegativeNumber(data.totalSeconds),
    cameraOnCount: data.cameraTrackingStartedAt ? asNonNegativeInteger(data.cameraOnCount) : null,
    cameraOnSeconds: data.cameraTrackingStartedAt ? asNonNegativeNumber(data.cameraOnSeconds) : null,
    cameraActiveStartedAt: asNullableText(data.cameraActiveStartedAt),
    createdAt: asNullableText(data.createdAt),
    updatedAt: asNullableText(data.updatedAt),
  };
}

export function isStudentLiveParticipant(participant: LiveAttendanceParticipantInput): boolean {
  return participant.role?.trim().toLowerCase() === "student";
}

function closeCameraInterval(current: Record<string, unknown>, endedAtIso: string): Record<string, unknown> {
  if (!current.cameraTrackingStartedAt) return {};
  const startedMs = toMillis(current.cameraActiveStartedAt);
  const endedMs = Date.parse(endedAtIso);
  const elapsedSeconds = startedMs !== null && endedMs > startedMs ? (endedMs - startedMs) / 1000 : 0;
  return {
    cameraEnabled: false,
    cameraActiveStartedAt: null,
    cameraOnSeconds: asNonNegativeNumber(current.cameraOnSeconds) + elapsedSeconds,
    cameraStateUpdatedAt: endedAtIso,
  };
}

export async function recordLiveAttendanceCamera(
  context: AttendanceContext,
  participant: LiveAttendanceParticipantInput,
  enabled: boolean,
  observedAtIso: string,
  roomConnected = true,
) {
  const identity = normalizeText(participant.identity);
  if (!identity || !isStudentLiveParticipant(participant)) return;
  const docRef = attendanceRef(context.classRef, identity);
  await context.classRef.firestore.runTransaction(async (transaction) => {
    const classSnap = await transaction.get(context.classRef);
    const snap = await transaction.get(docRef);
    const session = classSnap.data()?.liveSession;
    if (session?.status !== "live" || session?.lastEndedAt) return;
    const current = (snap.data() ?? {}) as Record<string, unknown>;
    if (!roomConnected && (!snap.exists || current.connected !== true)) return;
    const observedMs = toMillis(observedAtIso);
    const previousMs = toMillis(current.cameraStateUpdatedAt);
    if (observedMs === null || (previousMs !== null && observedMs < previousMs)) return;
    const wasEnabled = current.cameraEnabled === true;
    const closedInterval = !enabled && wasEnabled ? closeCameraInterval(current, observedAtIso) : {};
    const joining = roomConnected && (current.connected !== true || !current.activeSessionStartedAt);
    transaction.set(docRef, {
      ...(joining ? {
        participantIdentity: identity,
        studentId: asNullableText(participant.uid) ?? asNullableText(current.studentId) ?? identity,
        studentName: asNullableText(participant.name) ?? asNullableText(current.studentName),
        role: participant.role,
        roomName: context.roomName,
        courseId: context.courseId,
        lessonId: context.lessonId,
        classId: context.classId,
        firstJoinedAt: asNullableText(current.firstJoinedAt) ?? observedAtIso,
        lastJoinedAt: observedAtIso,
        activeSessionStartedAt: observedAtIso,
        connected: true,
        joinCount: asNonNegativeInteger(current.joinCount) + 1,
        totalSeconds: asNonNegativeNumber(current.totalSeconds),
        createdAt: asNullableText(current.createdAt) ?? observedAtIso,
      } : {}),
      ...(!roomConnected ? {
        connected: false,
        activeSessionStartedAt: null,
        lastLeftAt: observedAtIso,
        totalSeconds: asNonNegativeNumber(current.totalSeconds) + secondsBetween(current.activeSessionStartedAt, observedAtIso),
      } : {}),
      ...closedInterval,
      cameraTrackingStartedAt: asNullableText(current.cameraTrackingStartedAt) ?? observedAtIso,
      cameraEnabled: enabled,
      cameraOnCount: asNonNegativeInteger(current.cameraOnCount) + (enabled && !wasEnabled ? 1 : 0),
      cameraOnSeconds: closedInterval.cameraOnSeconds ?? asNonNegativeNumber(current.cameraOnSeconds),
      cameraActiveStartedAt: enabled ? asNullableText(current.cameraActiveStartedAt) ?? observedAtIso : null,
      cameraStateUpdatedAt: observedAtIso,
      updatedAt: observedAtIso,
    }, { merge: true });
  });
}

export async function recordLiveAttendanceJoin(
  context: AttendanceContext,
  participant: LiveAttendanceParticipantInput,
  joinedAtIso: string,
) {
  const identity = normalizeText(participant.identity);
  if (!identity || !isStudentLiveParticipant(participant)) return;

  const docRef = attendanceRef(context.classRef, identity);
  const db = context.classRef.firestore;
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(docRef);
    const current = snap.exists ? (snap.data() ?? {}) as Record<string, unknown> : {};
    const activeStartedAt = asNullableText(current.activeSessionStartedAt);
    const studentName = asNullableText(participant.name) ?? asNullableText(current.studentName);
    const studentId = asNullableText(participant.uid) ?? asNullableText(current.studentId) ?? identity;
    const joinCount = asNonNegativeInteger(current.joinCount) + (activeStartedAt ? 0 : 1);

    transaction.set(
      docRef,
      {
        participantIdentity: identity,
        studentId,
        studentName,
        role: participant.role,
        roomName: context.roomName,
        courseId: context.courseId,
        lessonId: context.lessonId,
        classId: context.classId,
        firstJoinedAt: asNullableText(current.firstJoinedAt) ?? joinedAtIso,
        lastJoinedAt: joinedAtIso,
        activeSessionStartedAt: activeStartedAt ?? joinedAtIso,
        connected: true,
        joinCount,
        totalSeconds: asNonNegativeNumber(current.totalSeconds),
        createdAt: asNullableText(current.createdAt) ?? joinedAtIso,
        updatedAt: joinedAtIso,
      },
      { merge: true },
    );
  });
}

export async function recordLiveAttendanceLeave(
  context: AttendanceContext,
  participant: LiveAttendanceParticipantInput,
  leftAtIso: string,
) {
  const identity = normalizeText(participant.identity);
  if (!identity || !isStudentLiveParticipant(participant)) return;

  const docRef = attendanceRef(context.classRef, identity);
  const db = context.classRef.firestore;
  await db.runTransaction(async (transaction) => {
    const classSnap = await transaction.get(context.classRef);
    const snap = await transaction.get(docRef);
    const current = snap.exists ? (snap.data() ?? {}) as Record<string, unknown> : {};
    const endedAt = asNullableText(classSnap.data()?.liveSession?.lastEndedAt);
    const effectiveLeftAt = endedAt && Date.parse(endedAt) < Date.parse(leftAtIso) ? endedAt : leftAtIso;
    const activeStartedAt = asNullableText(current.activeSessionStartedAt);
    const totalSeconds =
      asNonNegativeNumber(current.totalSeconds) + secondsBetween(activeStartedAt, effectiveLeftAt);
    const studentId = asNullableText(participant.uid) ?? asNullableText(current.studentId) ?? identity;
    const studentName = asNullableText(participant.name) ?? asNullableText(current.studentName);

    transaction.set(
      docRef,
      {
        participantIdentity: identity,
        studentId,
        studentName,
        role: participant.role,
        roomName: context.roomName,
        courseId: context.courseId,
        lessonId: context.lessonId,
        classId: context.classId,
        lastLeftAt: effectiveLeftAt,
        activeSessionStartedAt: null,
        connected: false,
        totalSeconds,
        ...closeCameraInterval(current, effectiveLeftAt),
        createdAt: asNullableText(current.createdAt) ?? leftAtIso,
        updatedAt: leftAtIso,
      },
      { merge: true },
    );
  });
}

export async function finalizeLiveAttendanceForClass(
  classRef: DocumentReference,
  endedAtIso: string,
) {
  const attendanceSnap = await classRef
    .collection(ATTENDANCE_COLLECTION)
    .where("connected", "==", true)
    .get();
  if (attendanceSnap.empty) return;

  await Promise.all(attendanceSnap.docs.map((docSnap) =>
    classRef.firestore.runTransaction(async (transaction) => {
      const currentSnap = await transaction.get(docSnap.ref);
      const data = (currentSnap.data() ?? {}) as Record<string, unknown>;
      if (data.connected !== true) return;
      const activeStartedAt = asNullableText(data.activeSessionStartedAt);
      const totalSeconds =
        asNonNegativeNumber(data.totalSeconds) + secondsBetween(activeStartedAt, endedAtIso);
      transaction.set(docSnap.ref, {
        lastLeftAt: endedAtIso,
        activeSessionStartedAt: null,
        connected: false,
        totalSeconds,
        ...closeCameraInterval(data, endedAtIso),
        updatedAt: endedAtIso,
      }, { merge: true });
    }),
  ));
}

export async function loadLiveAttendanceRecords(
  classRef: DocumentReference,
): Promise<LiveAttendanceRecord[]> {
  const snap = await classRef.collection(ATTENDANCE_COLLECTION).get();
  return snap.docs.map(mapAttendanceDoc);
}
