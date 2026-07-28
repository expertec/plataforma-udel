import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminFirestore } from "@/lib/firebase/admin";
import {
  LiveAccessError,
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
} from "@/lib/live-classes/access";
import {
  createLiveSessionForClass,
  mergeTeacherEditableLiveSession,
  normalizeLiveSession,
  type LiveClassSession,
} from "@/lib/live-classes/types";
import {
  buildRecordingOutputPaths,
  ensureLiveKitRoom,
  ensureRoomCompositeRecordingStarted,
  extractRecordingBackupLiveManifestPath,
  extractRecordingBackupManifestPath,
  extractRecordingObjectPath,
  getLiveKitEgressConfig,
  resolveDefaultRecordingMaxRetryCount,
  stopActiveLiveKitEgressForRoom,
  stopLiveKitEgress,
} from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeObjectPath(value: string): string {
  return value.replace(/^\/+/, "").trim();
}

function decodePathComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type ObjectLocation = {
  bucketName: string;
  objectPath: string;
};

type RecordingControlAction = "start" | "stop" | "status";

type RecordingControlBody = {
  action?: unknown;
};

type RecordingControlResult = {
  action: RecordingControlAction;
  sessionStatus: string;
  recordingStatus: string;
  egressId: string | null;
  storagePath: string | null;
  playbackReadyAt: string | null;
  durationSec: number | null;
  errorMessage: string | null;
  errorCode: number | null;
  retryCount: number;
  maxRetryCount: number;
  canStart: boolean;
  canStop: boolean;
  egressStopRequested?: boolean;
};

function extractObjectLocationFromUrl(
  rawUrl: string,
  defaultBucketName: string,
): ObjectLocation | null {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.trim().toLowerCase();
    const pathParts = parsed.pathname
      .split("/")
      .map((part) => decodePathComponent(part))
      .filter(Boolean);
    const queryBucket =
      asTrimmedString(parsed.searchParams.get("bucket")) ||
      asTrimmedString(parsed.searchParams.get("b"));
    const queryObjectPath = normalizeObjectPath(
      decodePathComponent(asTrimmedString(parsed.searchParams.get("name"))),
    );

    if (queryBucket && queryObjectPath) {
      return {
        bucketName: queryBucket,
        objectPath: queryObjectPath,
      };
    }

    const bucketIndex = pathParts.indexOf("b");
    const objectIndex = pathParts.indexOf("o");
    if (bucketIndex >= 0 && objectIndex > bucketIndex + 1) {
      const bucketName = asTrimmedString(pathParts[bucketIndex + 1]);
      const objectPath = normalizeObjectPath(pathParts.slice(objectIndex + 1).join("/"));
      if (bucketName && objectPath) {
        return { bucketName, objectPath };
      }
    }

    if (
      (hostname === "storage.googleapis.com" || hostname === "storage.cloud.google.com") &&
      pathParts.length >= 2
    ) {
      const [bucketName, ...rest] = pathParts;
      const objectPath = normalizeObjectPath(rest.join("/"));
      if (bucketName && objectPath) {
        return {
          bucketName,
          objectPath,
        };
      }
    }

    if (hostname === "firebasestorage.googleapis.com" && queryObjectPath) {
      return {
        bucketName: queryBucket || defaultBucketName,
        objectPath: queryObjectPath,
      };
    }
  } catch {
    // Ignore invalid URLs and continue with the remaining strategies.
  }

  return null;
}

function extractObjectLocation(
  rawStoragePath: string,
  defaultBucketName: string,
): ObjectLocation | null {
  const value = rawStoragePath.trim();
  if (!value) return null;

  if (value.startsWith("gs://")) {
    const withoutScheme = value.slice("gs://".length);
    const slashIdx = withoutScheme.indexOf("/");
    if (slashIdx < 0) return null;
    const bucketName = withoutScheme.slice(0, slashIdx).trim();
    const objectPath = normalizeObjectPath(withoutScheme.slice(slashIdx + 1));
    if (!bucketName || !objectPath) return null;
    return { bucketName, objectPath };
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return extractObjectLocationFromUrl(value, defaultBucketName);
  }

  const objectPath = normalizeObjectPath(value);
  if (!objectPath) return null;
  return {
    bucketName: defaultBucketName,
    objectPath,
  };
}

function isRecordingReady(liveSession: {
  status?: string;
  recording?: { status?: string };
} | null): boolean {
  if (!liveSession) return false;
  return liveSession.status === "recording_ready" || liveSession.recording?.status === "ready";
}

function resolveRecordingControlAction(value: unknown): RecordingControlAction {
  const normalized = asTrimmedString(value).toLowerCase();
  if (normalized === "start" || normalized === "stop" || normalized === "status") {
    return normalized;
  }
  return "status";
}

function mapRecordingStatusLabel(status: string): string {
  if (status === "recording") return "recording";
  if (status === "processing") return "processing";
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  return "idle";
}

function buildRecordingControlResult(
  action: RecordingControlAction,
  liveSession: LiveClassSession | null,
): RecordingControlResult {
  const recording = liveSession?.recording;
  const recordingStatus = mapRecordingStatusLabel(recording?.status ?? "idle");
  const canStart =
    recordingStatus === "idle" || recordingStatus === "failed" || recordingStatus === "ready";
  const canStop = recordingStatus === "recording" || recordingStatus === "processing";
  return {
    action,
    sessionStatus: liveSession?.status ?? "scheduled",
    recordingStatus,
    egressId: recording?.egressId ?? null,
    storagePath: recording?.storagePath ?? null,
    playbackReadyAt: recording?.playbackReadyAt ?? null,
    durationSec: recording?.durationSec ?? null,
    errorMessage: recording?.errorMessage ?? null,
    errorCode: recording?.errorCode ?? null,
    retryCount: recording?.retryCount ?? 0,
    maxRetryCount: recording?.maxRetryCount ?? resolveDefaultRecordingMaxRetryCount(),
    canStart,
    canStop,
  };
}

function isLiveSessionFinalized(session: LiveClassSession): boolean {
  return (
    Boolean(session.lastEndedAt) ||
    session.status === "ended" ||
    session.status === "recording_ready"
  );
}

function buildRecordingPrefixForDate(
  egressPrefix: string,
  courseId: string,
  rawDate: string | null | undefined,
): string | null {
  const value = rawDate?.trim();
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  const yyyy = parsed.getUTCFullYear().toString();
  const mm = (parsed.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = parsed.getUTCDate().toString().padStart(2, "0");
  return [normalizeObjectPath(egressPrefix), courseId, yyyy, mm, dd].filter(Boolean).join("/");
}

function buildRecordingSearchPrefixes(params: {
  egressPrefix: string;
  courseId: string;
  liveSession: LiveClassSession | null;
}): string[] {
  const candidates = [
    buildRecordingPrefixForDate(
      params.egressPrefix,
      params.courseId,
      params.liveSession?.lastStartedAt,
    ),
    buildRecordingPrefixForDate(
      params.egressPrefix,
      params.courseId,
      params.liveSession?.lastEndedAt,
    ),
    buildRecordingPrefixForDate(
      params.egressPrefix,
      params.courseId,
      params.liveSession?.recording.playbackReadyAt,
    ),
    [normalizeObjectPath(params.egressPrefix), params.courseId].filter(Boolean).join("/"),
  ];

  return Array.from(new Set(candidates.filter((value): value is string => Boolean(value))));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractRecordingTimestamp(objectPath: string, classId: string): number {
  const fileName = objectPath.split("/").pop() ?? "";
  const match = fileName.match(new RegExp(`^${escapeRegExp(classId)}-(\\d+)\\.mp4$`, "i"));
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMatchingRecordingObject(objectPath: string, classId: string): boolean {
  const fileName = objectPath.split("/").pop()?.toLowerCase() ?? "";
  return fileName.startsWith(`${classId.toLowerCase()}-`) && fileName.endsWith(".mp4");
}

async function findExistingRecordingObject(params: {
  bucketName: string;
  egressPrefix: string;
  courseId: string;
  classId: string;
  liveSession: LiveClassSession | null;
}): Promise<ObjectLocation | null> {
  const bucket = getAdminApp().storage().bucket(params.bucketName);
  const prefixes = buildRecordingSearchPrefixes({
    egressPrefix: params.egressPrefix,
    courseId: params.courseId,
    liveSession: params.liveSession,
  });

  for (const prefix of prefixes) {
    const [files] = await bucket.getFiles({
      prefix,
      autoPaginate: false,
      maxResults: 100,
    });
    const matches = files
      .map((file) => normalizeObjectPath(file.name))
      .filter((objectPath) => isMatchingRecordingObject(objectPath, params.classId))
      .sort(
        (a, b) =>
          extractRecordingTimestamp(b, params.classId) -
          extractRecordingTimestamp(a, params.classId),
      );

    if (matches[0]) {
      return {
        bucketName: params.bucketName,
        objectPath: matches[0],
      };
    }
  }

  return null;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await context.params;
    const courseId = asTrimmedString(request.nextUrl.searchParams.get("courseId"));
    const lessonId = asTrimmedString(request.nextUrl.searchParams.get("lessonId"));
    const body = (await request.json().catch(() => ({}))) as RecordingControlBody;
    const action = resolveRecordingControlAction(body.action);

    const access = await resolveAuthorizedLiveClassAccess({
      request,
      classId,
      courseId: courseId || undefined,
      lessonId: lessonId || undefined,
      requireTeacher: true,
    });

    const classRef = access.classContext.classRef;
    const db = getAdminFirestore();

    if (action === "status") {
      const snap = await classRef.get();
      const classData = (snap.data() ?? {}) as Record<string, unknown>;
      const session = mergeTeacherEditableLiveSession({
        courseId: access.classContext.courseId,
        lessonId: access.classContext.lessonId,
        classId: access.classContext.classId,
        current: classData.liveSession,
      });
      return NextResponse.json(
        {
          success: true,
          data: buildRecordingControlResult(action, session),
        },
        { status: 200 },
      );
    }

    const nowIso = new Date().toISOString();
    let roomName = "";
    let targetEgressId: string | null = null;
    let shouldStartRecording = false;
    let shouldStopRecording = false;
    let preparedSession: LiveClassSession | null = null;
    const preparedOutputPaths = buildRecordingOutputPaths({
      courseId: access.classContext.courseId,
      classId: access.classContext.classId,
      startedAtMs: Date.now(),
    });

    await db.runTransaction(async (tx) => {
      const classSnap = await tx.get(classRef);
      if (!classSnap.exists) {
        throw new LiveAccessError(404, "Clase no encontrada");
      }
      const classData = (classSnap.data() ?? {}) as Record<string, unknown>;
      const session = mergeTeacherEditableLiveSession({
        courseId: access.classContext.courseId,
        lessonId: access.classContext.lessonId,
        classId: access.classContext.classId,
        current: classData.liveSession,
      });
      roomName = session.roomName;

      if (action === "start") {
        if (isLiveSessionFinalized(session)) {
          throw new LiveAccessError(409, "La clase ya finalizó y no permite iniciar grabación.");
        }
        const sessionIsLive = session.status === "live" || session.teacherActive === true;
        if (!sessionIsLive) {
          throw new LiveAccessError(409, "Primero inicia la clase en vivo para grabar.");
        }
        const recordingActive =
          session.recording.status === "recording" || session.recording.status === "processing";
        if (recordingActive && session.recording.egressId) {
          preparedSession = session;
          return;
        }

        const maxRetryCount =
          typeof session.recording.maxRetryCount === "number" &&
          Number.isFinite(session.recording.maxRetryCount)
            ? Math.max(0, Math.floor(session.recording.maxRetryCount))
            : resolveDefaultRecordingMaxRetryCount();

        const nextSession: LiveClassSession = {
          ...session,
          recording: {
            ...session.recording,
            auto: false,
            egressId: null,
            status: "processing",
            storagePath: preparedOutputPaths.mp4ObjectPath,
            backupManifestPath: preparedOutputPaths.backupManifestPath,
            backupLiveManifestPath: preparedOutputPaths.backupLiveManifestPath,
            playbackReadyAt: null,
            durationSec: null,
            errorMessage: null,
            errorCode: null,
            retryCount: 0,
            maxRetryCount,
            lastRetryAt: null,
          },
        };

        preparedSession = nextSession;
        shouldStartRecording = true;
        tx.set(
          classRef,
          {
            liveSession: nextSession,
          },
          { merge: true },
        );
        return;
      }

      const recordingActive =
        session.recording.status === "recording" || session.recording.status === "processing";
      if (!recordingActive && !session.recording.egressId) {
        preparedSession = session;
        return;
      }

      targetEgressId = session.recording.egressId;
      shouldStopRecording = true;
      const nextSession: LiveClassSession = {
        ...session,
        recording: {
          ...session.recording,
          status: "processing",
          lastRetryAt: session.recording.lastRetryAt ?? nowIso,
        },
      };
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
      throw new LiveAccessError(500, "No se pudo resolver la sala para la grabación.");
    }

    let egressStopRequested = false;

    if (action === "start" && shouldStartRecording) {
      const startSession = preparedSession as unknown as LiveClassSession;
      await ensureLiveKitRoom(roomName);
      try {
        const recordingStart = await ensureRoomCompositeRecordingStarted({
          roomName,
          outputPaths: preparedOutputPaths,
        });
        const egressId = recordingStart.egressInfo.egressId || null;
        const nextRecording = {
          ...(startSession.recording ?? {}),
          egressId,
          status: recordingStart.recordingStatus,
          storagePath:
            extractRecordingObjectPath(recordingStart.egressInfo) ||
            recordingStart.outputPaths.mp4ObjectPath ||
            null,
          backupManifestPath:
            extractRecordingBackupManifestPath(recordingStart.egressInfo) ||
            recordingStart.outputPaths.backupManifestPath ||
            null,
          backupLiveManifestPath:
            extractRecordingBackupLiveManifestPath(recordingStart.egressInfo) ||
            recordingStart.outputPaths.backupLiveManifestPath ||
            null,
          retryCount: recordingStart.retryCountUsed,
          lastRetryAt: recordingStart.retryCountUsed > 0 ? nowIso : null,
          errorMessage: null,
          errorCode: null,
        };
        await classRef.set(
          {
            liveSession: {
              ...startSession,
              recording: nextRecording,
            },
          },
          { merge: true },
        );
      } catch (startError) {
        console.error("[livekit:recording] No se pudo iniciar grabación manual", startError);
        const errorWithCode = startError as { message?: unknown; code?: unknown };
        await classRef.set(
          {
            liveSession: {
              ...startSession,
              recording: {
                ...(startSession.recording ?? {}),
                status: "failed",
                egressId: null,
                errorMessage:
                  typeof errorWithCode.message === "string" && errorWithCode.message.trim()
                    ? errorWithCode.message.trim()
                    : "No se pudo iniciar la grabación manual",
                errorCode:
                  typeof errorWithCode.code === "number" && Number.isFinite(errorWithCode.code)
                    ? errorWithCode.code
                    : null,
              },
            },
          },
          { merge: true },
        );
      }
    } else if (action === "stop" && shouldStopRecording) {
      try {
        if (targetEgressId) {
          egressStopRequested = await stopLiveKitEgress(targetEgressId);
        } else {
          const stopSummary = await stopActiveLiveKitEgressForRoom(roomName);
          egressStopRequested = stopSummary.stopped > 0;
        }
      } catch (stopError) {
        console.error("[livekit:recording] No se pudo detener grabación manual", stopError);
      }
    }

    const latestSnap = await classRef.get();
    const latestData = (latestSnap.data() ?? {}) as Record<string, unknown>;
    const latestSession =
      normalizeLiveSession(latestData.liveSession) ??
      createLiveSessionForClass({
        courseId: access.classContext.courseId,
        lessonId: access.classContext.lessonId,
        classId: access.classContext.classId,
      });

    const result = buildRecordingControlResult(action, latestSession);
    if (action === "stop") {
      result.egressStopRequested = egressStopRequested;
    }

    return NextResponse.json(
      {
        success: true,
        data: result,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const handled = toLiveAccessErrorResponse(error);
    if (handled.status === 500) {
      console.error("Error controlando grabación de clase en vivo", error);
    }
    return NextResponse.json(
      { success: false, error: handled.message },
      { status: handled.status },
    );
  }
}

export async function GET(
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
      requireTeacher: false,
      allowCoordinatorAccess: true,
    });

    const egressConfig = getLiveKitEgressConfig();
    let liveSession = access.classContext.liveSession;
    let recordingReady = isRecordingReady(liveSession);

    const currentStoragePath = liveSession?.recording.storagePath ?? "";
    let objectLocation = extractObjectLocation(currentStoragePath, egressConfig.egressBucket);

    if (objectLocation) {
      const storageBucket = getAdminApp().storage().bucket(objectLocation.bucketName);
      const [fileExists] = await storageBucket.file(objectLocation.objectPath).exists();
      if (!fileExists) {
        objectLocation = null;
      }
    }

    if (!objectLocation) {
      objectLocation = await findExistingRecordingObject({
        bucketName: egressConfig.egressBucket,
        egressPrefix: egressConfig.egressPrefix,
        courseId: access.classContext.courseId,
        classId: access.classContext.classId,
        liveSession,
      });
    }

    if (!recordingReady && objectLocation) {
      const nowIso = new Date().toISOString();
      const baseSession =
        liveSession ??
        createLiveSessionForClass({
          courseId: access.classContext.courseId,
          lessonId: access.classContext.lessonId,
          classId: access.classContext.classId,
        });
      const nextSession = {
        ...baseSession,
        status: "recording_ready" as const,
        teacherActive: false,
        recording: {
          ...baseSession.recording,
          status: "ready" as const,
          storagePath: objectLocation.objectPath,
          playbackReadyAt: baseSession.recording.playbackReadyAt ?? nowIso,
        },
      };
      await access.classContext.classRef.set(
        {
          liveSession: nextSession,
        },
        { merge: true },
      );
      liveSession = nextSession;
      recordingReady = true;
    } else if (
      objectLocation &&
      currentStoragePath.trim() &&
      currentStoragePath.trim() !== objectLocation.objectPath &&
      recordingReady
    ) {
      await access.classContext.classRef.set(
        {
          liveSession: {
            ...(liveSession ?? {}),
            recording: {
              ...(liveSession?.recording ?? {}),
              storagePath: objectLocation.objectPath,
            },
          },
        },
        { merge: true },
      );
    }

    if (!recordingReady) {
      if (liveSession?.recording.status === "failed") {
        throw new LiveAccessError(409, "La grabación falló y no pudo guardarse.");
      }
      throw new LiveAccessError(409, "La grabación aún se está procesando");
    }
    if (!objectLocation) {
      throw new LiveAccessError(404, "La grabación aún no está disponible");
    }

    const bucket = getAdminApp().storage().bucket(objectLocation.bucketName);
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const [signedUrl] = await bucket.file(objectLocation.objectPath).getSignedUrl({
      action: "read",
      expires: expiresAt,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          url: signedUrl,
          expiresAt: new Date(expiresAt).toISOString(),
          objectPath: objectLocation.objectPath,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const handled = toLiveAccessErrorResponse(error);
    if (handled.status === 500) {
      console.error("Error obteniendo grabación de clase en vivo", error);
    }
    return NextResponse.json(
      { success: false, error: handled.message },
      { status: handled.status },
    );
  }
}
