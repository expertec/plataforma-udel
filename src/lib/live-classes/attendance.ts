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
    createdAt: asNullableText(data.createdAt),
    updatedAt: asNullableText(data.updatedAt),
  };
}

export function isStudentLiveParticipant(participant: LiveAttendanceParticipantInput): boolean {
  return participant.role?.trim().toLowerCase() === "student";
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
    const snap = await transaction.get(docRef);
    const current = snap.exists ? (snap.data() ?? {}) as Record<string, unknown> : {};
    const activeStartedAt = asNullableText(current.activeSessionStartedAt);
    const totalSeconds =
      asNonNegativeNumber(current.totalSeconds) + secondsBetween(activeStartedAt, leftAtIso);
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
        lastLeftAt: leftAtIso,
        activeSessionStartedAt: null,
        connected: false,
        totalSeconds,
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

  const batch = classRef.firestore.batch();
  attendanceSnap.docs.forEach((docSnap) => {
    const data = (docSnap.data() ?? {}) as Record<string, unknown>;
    const activeStartedAt = asNullableText(data.activeSessionStartedAt);
    const totalSeconds =
      asNonNegativeNumber(data.totalSeconds) + secondsBetween(activeStartedAt, endedAtIso);
    batch.set(
      docSnap.ref,
      {
        lastLeftAt: asNullableText(data.lastLeftAt) ?? endedAtIso,
        activeSessionStartedAt: null,
        connected: false,
        totalSeconds,
        updatedAt: endedAtIso,
      },
      { merge: true },
    );
  });
  await batch.commit();
}

export async function loadLiveAttendanceRecords(
  classRef: DocumentReference,
): Promise<LiveAttendanceRecord[]> {
  const snap = await classRef.collection(ATTENDANCE_COLLECTION).get();
  return snap.docs.map(mapAttendanceDoc);
}
