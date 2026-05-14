import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { normalizeLiveSession, type LiveClassSession } from "@/lib/live-classes/types";
import {
  requireAdminTeacherAccess,
  toAdminTeacherRouteErrorResponse,
} from "@/lib/server/require-admin-teacher-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MonitorStatus =
  | "scheduled"
  | "live"
  | "ready"
  | "retrying"
  | "processing"
  | "stalled_processing"
  | "failed"
  | "finalized"
  | "finalized_without_recording";

const PROCESSING_STALE_AFTER_MS = 45 * 60 * 1000;
const RECENT_RETRY_WINDOW_MS = 20 * 60 * 1000;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as { toDate?: () => Date };
    if (typeof candidate.toDate === "function") {
      const date = candidate.toDate();
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }
  return null;
}

function parseClassPath(path: string): { courseId: string; lessonId: string; classId: string } | null {
  const parts = path.split("/").filter(Boolean);
  if (
    parts.length !== 6 ||
    parts[0] !== "courses" ||
    parts[2] !== "lessons" ||
    parts[4] !== "classes"
  ) {
    return null;
  }

  const courseId = asText(parts[1]);
  const lessonId = asText(parts[3]);
  const classId = asText(parts[5]);
  if (!courseId || !lessonId || !classId) return null;
  return { courseId, lessonId, classId };
}

function parseLessonPath(path: string): { courseId: string; lessonId: string } | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "courses" || parts[2] !== "lessons") {
    return null;
  }

  const courseId = asText(parts[1]);
  const lessonId = asText(parts[3]);
  if (!courseId || !lessonId) return null;
  return { courseId, lessonId };
}

function isSessionFinalized(session: LiveClassSession | null): boolean {
  if (!session) return false;
  return (
    Boolean(session.lastEndedAt) ||
    session.status === "ended" ||
    session.status === "recording_ready"
  );
}

function isSessionLive(session: LiveClassSession | null): boolean {
  return Boolean(session && (session.status === "live" || session.teacherActive === true));
}

function toMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isProcessingStalled(session: LiveClassSession | null): boolean {
  if (!session) return false;
  if (isSessionLive(session)) return false;
  if (session.recording.status !== "recording" && session.recording.status !== "processing") {
    return false;
  }

  const latestKnownMs = Math.max(
    toMs(session.recording.lastRetryAt),
    toMs(session.lastEndedAt),
    toMs(session.lastStartedAt),
  );
  if (!latestKnownMs) return false;
  return Date.now() - latestKnownMs >= PROCESSING_STALE_AFTER_MS;
}

function hasRecentAutoRetry(session: LiveClassSession | null): boolean {
  if (!session) return false;
  if (session.recording.retryCount <= 0 || !session.recording.lastRetryAt) return false;
  return Date.now() - toMs(session.recording.lastRetryAt) <= RECENT_RETRY_WINDOW_MS;
}

function deriveMonitorStatus(session: LiveClassSession | null): MonitorStatus {
  if (!session) return "scheduled";
  const recordingStatus = session.recording.status;
  const recordingReady = session.status === "recording_ready" || recordingStatus === "ready";

  if (recordingStatus === "failed") return "failed";
  if (recordingReady) return "ready";
  if (isProcessingStalled(session)) return "stalled_processing";
  if (recordingStatus === "recording" || recordingStatus === "processing") {
    if (hasRecentAutoRetry(session)) return "retrying";
    if (isSessionLive(session)) return "live";
    return "processing";
  }
  if (isSessionLive(session)) return "live";
  if (isSessionFinalized(session) && session.recording.auto === false) {
    return "finalized_without_recording";
  }
  if (isSessionFinalized(session)) return "finalized";
  return "scheduled";
}

function latestRelevantAt(params: {
  session: LiveClassSession | null;
  updatedAt: string | null;
  createdAt: string | null;
}): string | null {
  return (
    params.session?.recording.playbackReadyAt ??
    params.session?.recording.lastRetryAt ??
    params.session?.lastEndedAt ??
    params.session?.lastStartedAt ??
    params.updatedAt ??
    params.createdAt
  );
}

function toSortMs(value: string | null): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdminTeacherAccess(request);

    const db = getAdminFirestore();
    const liveClassSnap = await db.collectionGroup("classes").get();

    const parsedClasses = liveClassSnap.docs
      .map((classDoc) => {
        const pathData = parseClassPath(classDoc.ref.path);
        if (!pathData) return null;
        const data = classDoc.data() as Record<string, unknown>;
        const rawType = asText(data.type).toLowerCase();
        const hasLiveSession =
          typeof data.liveSession === "object" && data.liveSession !== null && !Array.isArray(data.liveSession);
        if (rawType !== "live" && !hasLiveSession) return null;
        const liveSession = normalizeLiveSession(data.liveSession);
        const createdAt = toIsoString(data.createdAt);
        const updatedAt = toIsoString(data.updatedAt);

        return {
          pathData,
          refPath: classDoc.ref.path,
          title: asText(data.title) || pathData.classId,
          liveSession,
          createdAt,
          updatedAt,
        };
      })
      .filter(
        (
          item,
        ): item is {
          pathData: { courseId: string; lessonId: string; classId: string };
          refPath: string;
          title: string;
          liveSession: LiveClassSession | null;
          createdAt: string | null;
          updatedAt: string | null;
        } => Boolean(item),
      );

    const courseRefs = new Map<string, FirebaseFirestore.DocumentReference>();
    const lessonRefs = new Map<string, FirebaseFirestore.DocumentReference>();

    parsedClasses.forEach(({ pathData }) => {
      courseRefs.set(pathData.courseId, db.doc(`courses/${pathData.courseId}`));
      lessonRefs.set(
        `${pathData.courseId}::${pathData.lessonId}`,
        db.doc(`courses/${pathData.courseId}/lessons/${pathData.lessonId}`),
      );
    });

    const courseTitleMap = new Map<string, string>();
    const lessonTitleMap = new Map<string, string>();

    if (courseRefs.size > 0) {
      const courseSnaps = await db.getAll(...Array.from(courseRefs.values()));
      courseSnaps.forEach((snap) => {
        courseTitleMap.set(snap.id, asText(snap.data()?.title) || snap.id);
      });
    }

    if (lessonRefs.size > 0) {
      const lessonSnaps = await db.getAll(...Array.from(lessonRefs.values()));
      lessonSnaps.forEach((snap) => {
        const pathData = parseLessonPath(snap.ref.path);
        if (!pathData) return;
        lessonTitleMap.set(
          `${pathData.courseId}::${pathData.lessonId}`,
          asText(snap.data()?.title) || snap.id,
        );
      });
    }

    const items = parsedClasses
      .map(({ pathData, refPath, title, liveSession, createdAt, updatedAt }) => {
        const courseTitle = courseTitleMap.get(pathData.courseId) || pathData.courseId;
        const lessonTitle =
          lessonTitleMap.get(`${pathData.courseId}::${pathData.lessonId}`) || pathData.lessonId;
        const monitorStatus = deriveMonitorStatus(liveSession);
        const lastRelevantAt = latestRelevantAt({
          session: liveSession,
          updatedAt,
          createdAt,
        });

        return {
          classId: pathData.classId,
          courseId: pathData.courseId,
          lessonId: pathData.lessonId,
          title,
          courseTitle,
          lessonTitle,
          docPath: refPath,
          roomName: liveSession?.roomName ?? null,
          sessionStatus: liveSession?.status ?? "scheduled",
          egressId: liveSession?.recording.egressId ?? null,
          recordingStatus: liveSession?.recording.status ?? "idle",
          errorMessage: liveSession?.recording.errorMessage ?? null,
          errorCode: liveSession?.recording.errorCode ?? null,
          monitorStatus,
          teacherActive: liveSession?.teacherActive ?? false,
          recordingAuto: liveSession?.recording.auto !== false,
          storagePath: liveSession?.recording.storagePath ?? null,
          backupManifestPath: liveSession?.recording.backupManifestPath ?? null,
          backupLiveManifestPath: liveSession?.recording.backupLiveManifestPath ?? null,
          playbackReadyAt: liveSession?.recording.playbackReadyAt ?? null,
          durationSec: liveSession?.recording.durationSec ?? null,
          retryCount: liveSession?.recording.retryCount ?? 0,
          maxRetryCount: liveSession?.recording.maxRetryCount ?? 2,
          lastRetryAt: liveSession?.recording.lastRetryAt ?? null,
          lastStartedAt: liveSession?.lastStartedAt ?? null,
          lastEndedAt: liveSession?.lastEndedAt ?? null,
          createdAt,
          updatedAt,
          lastRelevantAt,
        };
      })
      .sort((a, b) => toSortMs(b.lastRelevantAt) - toSortMs(a.lastRelevantAt));

    const counts = items.reduce<Record<MonitorStatus, number>>(
      (acc, item) => {
        acc[item.monitorStatus] += 1;
        return acc;
      },
      {
        scheduled: 0,
        live: 0,
        ready: 0,
        retrying: 0,
        processing: 0,
        stalled_processing: 0,
        failed: 0,
        finalized: 0,
        finalized_without_recording: 0,
      },
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          items,
          counts,
          total: items.length,
          fetchedAt: new Date().toISOString(),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toAdminTeacherRouteErrorResponse(error, "Error listando clases en vivo admin");
  }
}
