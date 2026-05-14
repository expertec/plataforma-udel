import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  LiveAccessError,
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
} from "@/lib/live-classes/access";
import { mergeTeacherEditableLiveSession } from "@/lib/live-classes/types";
import { sendWhatsAppTextToStudent } from "@/lib/server/whatsapp-notifier";
import {
  buildRecordingOutputPaths,
  ensureLiveKitRoom,
  ensureRoomCompositeRecordingStarted,
  extractRecordingBackupLiveManifestPath,
  extractRecordingBackupManifestPath,
  extractRecordingObjectPath,
  type LiveRecordingOutputPaths,
  resolveDefaultRecordingMaxRetryCount,
} from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WHATSAPP_EVENTS_COLLECTION = "whatsappNotificationEvents";

type LiveStartNotificationSummary = {
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  groups: number;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => asTrimmedString(item))
        .filter(Boolean),
    ),
  );
}

function getGroupCourseIds(groupData: Record<string, unknown>): string[] {
  const explicitIds = asUniqueStringArray(groupData.courseIds);
  if (explicitIds.length > 0) return explicitIds;

  if (Array.isArray(groupData.courses)) {
    const courseIdsFromArray = Array.from(
      new Set(
        groupData.courses
          .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return "";
            return asTrimmedString((item as Record<string, unknown>).courseId);
          })
          .filter(Boolean),
      ),
    );
    if (courseIdsFromArray.length > 0) return courseIdsFromArray;
  }

  const legacyCourseId = asTrimmedString(groupData.courseId);
  return legacyCourseId ? [legacyCourseId] : [];
}

function isActiveStatus(value: unknown): boolean {
  const status = asTrimmedString(value).toLowerCase();
  if (!status) return true;
  const blockedStatuses = new Set([
    "finished",
    "archived",
    "inactive",
    "dropped",
    "cancelled",
    "deleted",
    "blocked",
    "suspended",
    "baja",
  ]);
  return !blockedStatuses.has(status);
}

function buildLiveJoinPath(params: {
  classId: string;
  courseId: string;
  lessonId: string;
}): string {
  const baseClassId = encodeURIComponent(params.classId.trim());
  const search = new URLSearchParams();
  if (params.courseId.trim()) search.set("courseId", params.courseId.trim());
  if (params.lessonId.trim()) search.set("lessonId", params.lessonId.trim());
  const query = search.toString();
  return `/live/${baseClassId}${query ? `?${query}` : ""}`;
}

function buildLiveStartMessage(params: {
  teacherName: string;
  classTitle: string;
  courseTitle?: string;
  lessonTitle?: string;
  joinUrl: string;
}): string {
  const teacherName = params.teacherName || "Tu profesor";
  const classTitle = params.classTitle || "Clase en vivo";
  const contextParts = [params.courseTitle, params.lessonTitle]
    .map((part) => asTrimmedString(part))
    .filter(Boolean);
  const contextText = contextParts.length ? `\nContexto: ${contextParts.join(" | ")}` : "";

  return (
    `*Tu clase en vivo ya inicio*\n` +
    `\n` +
    `Profesor: ${teacherName}\n` +
    `Clase: ${classTitle}${contextText}\n` +
    `\n` +
    `Entra aqui ahora:\n${params.joinUrl}\n` +
    `\n` +
    `Si no puedes entrar, avisa a tu profesor.`
  );
}

function buildLiveStartEventId(params: {
  classId: string;
  startedAtIso: string;
  studentId: string;
}): string {
  return [
    "liveClassStart",
    params.classId,
    params.startedAtIso,
    params.studentId,
  ]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

async function resolveGroupStudentTargets(params: {
  db: FirebaseFirestore.Firestore;
  courseId: string;
}): Promise<Array<{ groupId: string; studentIds: string[] }>> {
  const groupsRef = params.db.collection("groups");
  const [legacySnap, arraySnap] = await Promise.all([
    groupsRef.where("courseId", "==", params.courseId).get(),
    groupsRef.where("courseIds", "array-contains", params.courseId).get(),
  ]);

  const groupsMap = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  [...legacySnap.docs, ...arraySnap.docs].forEach((groupDoc) => {
    if (groupsMap.has(groupDoc.id)) return;
    groupsMap.set(groupDoc.id, groupDoc);
  });

  const studentTargets: Array<{ groupId: string; studentIds: string[] }> = [];
  for (const groupDoc of groupsMap.values()) {
    const groupData = (groupDoc.data() ?? {}) as Record<string, unknown>;
    if (!isActiveStatus(groupData.status)) continue;
    const groupCourseIds = getGroupCourseIds(groupData);
    if (!groupCourseIds.includes(params.courseId)) continue;

    const studentsSnap = await groupDoc.ref.collection("students").get();
    const studentIds = Array.from(
      new Set(
        studentsSnap.docs
          .map((studentDoc) => {
            const studentData = (studentDoc.data() ?? {}) as Record<string, unknown>;
            if (!isActiveStatus(studentData.status)) return "";
            return asTrimmedString(studentData.studentId) || studentDoc.id.trim();
          })
          .filter(Boolean),
      ),
    );

    if (studentIds.length > 0) {
      studentTargets.push({
        groupId: groupDoc.id,
        studentIds,
      });
    }
  }

  return studentTargets;
}

async function notifyStudentsByWhatsApp(params: {
  db: FirebaseFirestore.Firestore;
  startedAtIso: string;
  requesterUid: string;
  teacherName: string;
  classId: string;
  classTitle: string;
  courseId: string;
  lessonId: string;
  origin: string;
}): Promise<LiveStartNotificationSummary> {
  const summary: LiveStartNotificationSummary = {
    attempted: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    groups: 0,
  };

  const [courseSnap, lessonSnap, groupTargets] = await Promise.all([
    params.db.collection("courses").doc(params.courseId).get(),
    params.db
      .collection("courses")
      .doc(params.courseId)
      .collection("lessons")
      .doc(params.lessonId)
      .get(),
    resolveGroupStudentTargets({
      db: params.db,
      courseId: params.courseId,
    }),
  ]);

  summary.groups = groupTargets.length;

  const uniqueStudents = new Map<string, string>();
  groupTargets.forEach((group) => {
    group.studentIds.forEach((studentId) => {
      if (!uniqueStudents.has(studentId)) {
        uniqueStudents.set(studentId, group.groupId);
      }
    });
  });

  const joinUrl = `${params.origin}${buildLiveJoinPath({
    classId: params.classId,
    courseId: params.courseId,
    lessonId: params.lessonId,
  })}`;
  const message = buildLiveStartMessage({
    teacherName: params.teacherName,
    classTitle: params.classTitle,
    courseTitle: asTrimmedString(courseSnap.data()?.title) || undefined,
    lessonTitle: asTrimmedString(lessonSnap.data()?.title) || undefined,
    joinUrl,
  });

  for (const [studentId, groupId] of uniqueStudents.entries()) {
    summary.attempted += 1;
    const eventId = buildLiveStartEventId({
      classId: params.classId,
      startedAtIso: params.startedAtIso,
      studentId,
    });
    const eventRef = params.db.collection(WHATSAPP_EVENTS_COLLECTION).doc(eventId);
    const eventSnap = await eventRef.get();
    if (eventSnap.exists) {
      summary.skipped += 1;
      continue;
    }

    const outcome = await sendWhatsAppTextToStudent({
      studentId,
      groupId,
      message,
      preferredOwnerUid: params.requesterUid,
    });

    if (outcome.notified) {
      summary.sent += 1;
      await eventRef.set({
        type: "liveClassStart",
        classId: params.classId,
        courseId: params.courseId,
        lessonId: params.lessonId,
        studentId,
        groupId,
        triggeredBy: params.requesterUid,
        createdAt: new Date(),
        messageId: outcome.messageId ?? null,
      });
      continue;
    }

    summary.failed += 1;
    await eventRef.set({
      type: "liveClassStart",
      classId: params.classId,
      courseId: params.courseId,
      lessonId: params.lessonId,
      studentId,
      groupId,
      triggeredBy: params.requesterUid,
      createdAt: new Date(),
      sent: false,
      reason: outcome.reason,
      retryable: outcome.retryable === true,
    });
  }

  return summary;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await context.params;
    const courseId = asTrimmedString(request.nextUrl.searchParams.get("courseId"));
    const lessonId = asTrimmedString(request.nextUrl.searchParams.get("lessonId"));
    const access = await resolveAuthorizedLiveClassAccess({
      request,
      classId,
      courseId: courseId || undefined,
      lessonId: lessonId || undefined,
      requireTeacher: true,
    });

    const db = getAdminFirestore();
    const classRef = access.classContext.classRef;
    const startedAtIso = new Date().toISOString();
    const startedAtMs = Date.now();

    let roomName = "";
    let shouldStartRecording = false;
    let shouldNotifyStudents = false;
    let preparedOutputPaths: LiveRecordingOutputPaths | null = null;
    let preparedSession = access.classContext.liveSession;

    await db.runTransaction(async (tx) => {
      const classSnap = await tx.get(classRef);
      if (!classSnap.exists) {
        throw new Error("Clase no encontrada");
      }
      const classData = (classSnap.data() ?? {}) as Record<string, unknown>;
      const session = mergeTeacherEditableLiveSession({
        courseId: access.classContext.courseId,
        lessonId: access.classContext.lessonId,
        classId: access.classContext.classId,
        current: classData.liveSession,
      });

      const isFinalized =
        Boolean(session.lastEndedAt) ||
        session.status === "ended" ||
        session.status === "recording_ready";
      if (isFinalized) {
        throw new LiveAccessError(
          409,
          "Esta clase en vivo ya fue finalizada y no puede volver a iniciarse.",
        );
      }

      roomName = session.roomName;
      const recordingAlreadyRunning =
        Boolean(session.recording.egressId) ||
        session.recording.status === "recording" ||
        session.recording.status === "processing";

      const wasAlreadyLive = session.status === "live" || session.teacherActive === true;

      const nextSession = {
        ...session,
        status: "live" as const,
        teacherActive: true,
        lastStartedAt: startedAtIso,
      };

      if (nextSession.recording.auto && !recordingAlreadyRunning) {
        preparedOutputPaths = buildRecordingOutputPaths({
          courseId: access.classContext.courseId,
          classId: access.classContext.classId,
          startedAtMs,
        });
        shouldStartRecording = true;
        nextSession.recording = {
          ...nextSession.recording,
          status: "processing",
          storagePath: preparedOutputPaths.mp4ObjectPath,
          backupManifestPath: preparedOutputPaths.backupManifestPath,
          backupLiveManifestPath: preparedOutputPaths.backupLiveManifestPath,
          playbackReadyAt: null,
          durationSec: null,
          errorMessage: null,
          errorCode: null,
          retryCount: 0,
          maxRetryCount: nextSession.recording.maxRetryCount || resolveDefaultRecordingMaxRetryCount(),
          lastRetryAt: null,
        };
      }

      shouldNotifyStudents = !wasAlreadyLive;
      preparedSession = nextSession;
      tx.set(
        classRef,
        {
          liveSession: nextSession,
        },
        { merge: true },
      );
    });

    if (!roomName) {
      throw new Error("No se pudo resolver roomName");
    }

    await ensureLiveKitRoom(roomName);

    let egressId: string | null = null;
    if (shouldStartRecording && preparedOutputPaths) {
      const outputPaths = preparedOutputPaths;
      try {
        const recordingStart = await ensureRoomCompositeRecordingStarted({
          roomName,
          outputPaths,
        });
        egressId = recordingStart.egressInfo.egressId || null;
        const objectPath =
          extractRecordingObjectPath(recordingStart.egressInfo) ||
          recordingStart.outputPaths.mp4ObjectPath ||
          null;
        const backupManifestPath =
          extractRecordingBackupManifestPath(recordingStart.egressInfo) ||
          recordingStart.outputPaths.backupManifestPath ||
          null;
        const backupLiveManifestPath =
          extractRecordingBackupLiveManifestPath(recordingStart.egressInfo) ||
          recordingStart.outputPaths.backupLiveManifestPath ||
          null;
        const retryCountUsed = recordingStart.retryCountUsed;
        await classRef.set(
          {
            liveSession: {
              ...preparedSession,
              recording: {
                ...(preparedSession?.recording ?? {}),
                egressId,
                status: recordingStart.recordingStatus,
                storagePath: objectPath,
                backupManifestPath,
                backupLiveManifestPath,
                retryCount: retryCountUsed,
                maxRetryCount:
                  preparedSession?.recording?.maxRetryCount ||
                  resolveDefaultRecordingMaxRetryCount(),
                lastRetryAt: retryCountUsed > 0 ? new Date().toISOString() : null,
                errorMessage: null,
                errorCode: null,
              },
            },
          },
          { merge: true },
        );
      } catch (egressError) {
        console.error("No se pudo iniciar egress LiveKit", egressError);
        const errorWithCode = egressError as { message?: unknown; code?: unknown };
        await classRef.set(
          {
            liveSession: {
              ...preparedSession,
              recording: {
                ...(preparedSession?.recording ?? {}),
                status: "failed",
                egressId: null,
                storagePath: preparedSession?.recording?.storagePath ?? null,
                backupManifestPath: preparedSession?.recording?.backupManifestPath ?? null,
                backupLiveManifestPath:
                  preparedSession?.recording?.backupLiveManifestPath ?? null,
                errorMessage:
                  typeof errorWithCode.message === "string" && errorWithCode.message.trim()
                    ? errorWithCode.message.trim()
                    : "No se pudo iniciar egress LiveKit",
                errorCode:
                  typeof errorWithCode.code === "number" && Number.isFinite(errorWithCode.code)
                    ? errorWithCode.code
                    : null,
                maxRetryCount:
                  preparedSession?.recording?.maxRetryCount ||
                  resolveDefaultRecordingMaxRetryCount(),
              },
            },
          },
          { merge: true },
        );
      }
    }

    let notificationSummary: LiveStartNotificationSummary | null = null;
    if (shouldNotifyStudents) {
      try {
        notificationSummary = await notifyStudentsByWhatsApp({
          db,
          startedAtIso,
          requesterUid: access.user.uid,
          teacherName: access.user.displayName,
          classId: access.classContext.classId,
          classTitle:
            asTrimmedString(access.classContext.classData.title) || "Clase en vivo",
          courseId: access.classContext.courseId,
          lessonId: access.classContext.lessonId,
          origin: request.nextUrl.origin,
        });
      } catch (notifyError) {
        console.error("No se pudieron enviar notificaciones WhatsApp de clase en vivo", notifyError);
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          classId: access.classContext.classId,
          roomName,
          recordingStarted: shouldStartRecording,
          egressId,
          notifications: notificationSummary ?? undefined,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const handled = toLiveAccessErrorResponse(error);
    if (handled.status === 500) {
      console.error("Error iniciando clase en vivo", error);
    }
    return NextResponse.json(
      { success: false, error: handled.message },
      { status: handled.status },
    );
  }
}
