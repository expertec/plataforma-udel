import { EgressStatus } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminFirestore } from "@/lib/firebase/admin";
import { normalizeLiveSession } from "@/lib/live-classes/types";
import { getLiveKitEgressConfig, listActiveLiveKitEgress } from "@/lib/server/livekit";
import {
  requireAdminTeacherAccess,
  toAdminTeacherRouteErrorResponse,
} from "@/lib/server/require-admin-teacher-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROCESSING_STALE_AFTER_MS = 45 * 60 * 1000;

function asText(value: unknown): string {
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

function toMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

type ObjectLocation = {
  bucketName: string;
  objectPath: string;
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
      asText(parsed.searchParams.get("bucket")) || asText(parsed.searchParams.get("b"));
    const queryObjectPath = normalizeObjectPath(
      decodePathComponent(asText(parsed.searchParams.get("name"))),
    );

    if (queryBucket && queryObjectPath) {
      return { bucketName: queryBucket, objectPath: queryObjectPath };
    }

    const bucketIndex = pathParts.indexOf("b");
    const objectIndex = pathParts.indexOf("o");
    if (bucketIndex >= 0 && objectIndex > bucketIndex + 1) {
      const bucketName = asText(pathParts[bucketIndex + 1]);
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
        return { bucketName, objectPath };
      }
    }

    if (hostname === "firebasestorage.googleapis.com" && queryObjectPath) {
      return {
        bucketName: queryBucket || defaultBucketName,
        objectPath: queryObjectPath,
      };
    }
  } catch {
    // Ignore malformed URLs.
  }

  return null;
}

function extractObjectLocation(rawStoragePath: string, defaultBucketName: string): ObjectLocation | null {
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
  return { bucketName: defaultBucketName, objectPath };
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
  startedAt: string | null | undefined;
  endedAt: string | null | undefined;
  readyAt: string | null | undefined;
}): string[] {
  const candidates = [
    buildRecordingPrefixForDate(params.egressPrefix, params.courseId, params.startedAt),
    buildRecordingPrefixForDate(params.egressPrefix, params.courseId, params.endedAt),
    buildRecordingPrefixForDate(params.egressPrefix, params.courseId, params.readyAt),
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

function isMatchingBackupManifestObject(objectPath: string, classId: string): boolean {
  const normalized = objectPath.toLowerCase();
  return normalized.includes(`/${classId.toLowerCase()}-`) && normalized.endsWith("/index.m3u8");
}

async function findExistingRecordingObject(params: {
  bucketName: string;
  egressPrefix: string;
  courseId: string;
  classId: string;
  startedAt: string | null | undefined;
  endedAt: string | null | undefined;
  readyAt: string | null | undefined;
}): Promise<ObjectLocation | null> {
  const bucket = getAdminApp().storage().bucket(params.bucketName);
  const prefixes = buildRecordingSearchPrefixes({
    egressPrefix: params.egressPrefix,
    courseId: params.courseId,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    readyAt: params.readyAt,
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

async function findExistingBackupManifestObject(params: {
  bucketName: string;
  egressPrefix: string;
  courseId: string;
  classId: string;
  startedAt: string | null | undefined;
  endedAt: string | null | undefined;
  readyAt: string | null | undefined;
}): Promise<ObjectLocation | null> {
  const bucket = getAdminApp().storage().bucket(params.bucketName);
  const prefixes = buildRecordingSearchPrefixes({
    egressPrefix: params.egressPrefix,
    courseId: params.courseId,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    readyAt: params.readyAt,
  });

  for (const prefix of prefixes) {
    const [files] = await bucket.getFiles({
      prefix,
      autoPaginate: false,
      maxResults: 200,
    });
    const matches = files
      .map((file) => normalizeObjectPath(file.name))
      .filter((objectPath) => isMatchingBackupManifestObject(objectPath, params.classId))
      .sort((a, b) => b.localeCompare(a, "en"));

    if (matches[0]) {
      return {
        bucketName: params.bucketName,
        objectPath: matches[0],
      };
    }
  }

  return null;
}

function describeActiveEgressStatus(status: EgressStatus | number | undefined): string | null {
  switch (status) {
    case EgressStatus.EGRESS_STARTING:
      return "starting";
    case EgressStatus.EGRESS_ACTIVE:
      return "active";
    case EgressStatus.EGRESS_ENDING:
      return "ending";
    case EgressStatus.EGRESS_COMPLETE:
      return "complete";
    case EgressStatus.EGRESS_FAILED:
      return "failed";
    case EgressStatus.EGRESS_ABORTED:
      return "aborted";
    case EgressStatus.EGRESS_LIMIT_REACHED:
      return "limit_reached";
    default:
      return null;
  }
}

function isProcessingStalled(params: {
  teacherActive: boolean;
  recordingStatus: string;
  lastRetryAt: string | null | undefined;
  lastEndedAt: string | null | undefined;
  lastStartedAt: string | null | undefined;
}): boolean {
  if (params.teacherActive) return false;
  if (params.recordingStatus !== "recording" && params.recordingStatus !== "processing") {
    return false;
  }

  const latestKnownMs = Math.max(
    toMs(params.lastRetryAt),
    toMs(params.lastEndedAt),
    toMs(params.lastStartedAt),
  );
  if (!latestKnownMs) return false;
  return Date.now() - latestKnownMs >= PROCESSING_STALE_AFTER_MS;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ classId: string }> },
) {
  try {
    await requireAdminTeacherAccess(request);
    const { classId } = await context.params;
    const courseId = asText(request.nextUrl.searchParams.get("courseId"));
    const lessonId = asText(request.nextUrl.searchParams.get("lessonId"));
    if (!courseId || !lessonId || !classId.trim()) {
      return NextResponse.json(
        { success: false, error: "classId, courseId y lessonId son requeridos" },
        { status: 400 },
      );
    }

    const classSnap = await getAdminFirestore()
      .collection("courses")
      .doc(courseId)
      .collection("lessons")
      .doc(lessonId)
      .collection("classes")
      .doc(classId.trim())
      .get();

    if (!classSnap.exists) {
      return NextResponse.json(
        { success: false, error: "Clase no encontrada" },
        { status: 404 },
      );
    }

    const classData = (classSnap.data() ?? {}) as Record<string, unknown>;
    const liveSession = normalizeLiveSession(classData.liveSession);
    if (!liveSession) {
      return NextResponse.json(
        { success: false, error: "La clase no tiene liveSession" },
        { status: 400 },
      );
    }

    const egressConfig = getLiveKitEgressConfig();
    const currentStoragePath = liveSession.recording.storagePath ?? "";
    let objectLocation = extractObjectLocation(currentStoragePath, egressConfig.egressBucket);
    let storageObjectExists = false;
    const currentBackupManifestPath = liveSession.recording.backupManifestPath ?? "";
    let backupManifestLocation = extractObjectLocation(
      currentBackupManifestPath,
      egressConfig.egressBucket,
    );
    let backupManifestExists = false;

    if (objectLocation) {
      const bucket = getAdminApp().storage().bucket(objectLocation.bucketName);
      const [exists] = await bucket.file(objectLocation.objectPath).exists();
      storageObjectExists = exists;
      if (!exists) objectLocation = null;
    }

    if (backupManifestLocation) {
      const bucket = getAdminApp().storage().bucket(backupManifestLocation.bucketName);
      const [exists] = await bucket.file(backupManifestLocation.objectPath).exists();
      backupManifestExists = exists;
      if (!exists) backupManifestLocation = null;
    }

    if (!objectLocation) {
      objectLocation = await findExistingRecordingObject({
        bucketName: egressConfig.egressBucket,
        egressPrefix: egressConfig.egressPrefix,
        courseId,
        classId: classId.trim(),
        startedAt: liveSession.lastStartedAt,
        endedAt: liveSession.lastEndedAt,
        readyAt: liveSession.recording.playbackReadyAt,
      });
      storageObjectExists = Boolean(objectLocation);
    }

    if (!backupManifestLocation) {
      backupManifestLocation = await findExistingBackupManifestObject({
        bucketName: egressConfig.egressBucket,
        egressPrefix: egressConfig.egressPrefix,
        courseId,
        classId: classId.trim(),
        startedAt: liveSession.lastStartedAt,
        endedAt: liveSession.lastEndedAt,
        readyAt: liveSession.recording.playbackReadyAt,
      });
      backupManifestExists = Boolean(backupManifestLocation);
    }

    const activeEgressItems = liveSession.roomName
      ? await listActiveLiveKitEgress(liveSession.roomName)
      : [];
    const activeEgress =
      activeEgressItems.find((item) => item.egressId === liveSession.recording.egressId) ??
      activeEgressItems[0] ??
      null;
    const activeEgressStatus = describeActiveEgressStatus(activeEgress?.status);
    const stalledProcessing = isProcessingStalled({
      teacherActive: liveSession.teacherActive,
      recordingStatus: liveSession.recording.status,
      lastRetryAt: liveSession.recording.lastRetryAt,
      lastEndedAt: liveSession.lastEndedAt,
      lastStartedAt: liveSession.lastStartedAt,
    });

    let recoverable: boolean | null = null;
    let summary = "No hay suficiente información para recuperar esta clase todavía.";

    if (liveSession.recording.auto === false) {
      recoverable = false;
      summary = "La clase se configuró sin grabación automática.";
    } else if (storageObjectExists && objectLocation) {
      recoverable = true;
      summary =
        "Se encontró un archivo en storage. La clase es recuperable desde la plataforma aunque el estado haya quedado inconsistente.";
    } else if (backupManifestExists && backupManifestLocation) {
      recoverable = true;
      summary =
        "No quedó un MP4 final, pero sí existe un respaldo HLS en storage. Hay material suficiente para recuperación técnica y para evitar pérdida total.";
    } else if (
      activeEgressStatus === "starting" ||
      activeEgressStatus === "active" ||
      activeEgressStatus === "ending"
    ) {
      recoverable = null;
      summary =
        "LiveKit todavía reporta un egress activo para esta room. Conviene esperar o refrescar antes de marcarla como perdida.";
    } else if (
      activeEgressStatus === "failed" ||
      activeEgressStatus === "aborted" ||
      activeEgressStatus === "limit_reached"
    ) {
      recoverable = false;
      summary =
        "LiveKit ya no está procesando esta grabación: el egress terminó en estado terminal y no se encontró archivo en storage.";
    } else if (liveSession.recording.status === "failed") {
      recoverable = false;
      summary =
        "LiveKit marcó el egress como fallido y no se encontró archivo en storage. Desde la plataforma ya no hay nada que recuperar.";
    } else if (stalledProcessing) {
      recoverable = false;
      summary =
        "La clase quedó atorada: Firestore sigue marcando la grabación como recording/processing, pero no hay MP4, no hay respaldo HLS y LiveKit ya no reporta un egress activo.";
    } else if (
      liveSession.recording.status === "recording" ||
      liveSession.recording.status === "processing"
    ) {
      recoverable = null;
      summary =
        "La grabación sigue en proceso y todavía no aparece un archivo en storage. Aún no se puede descartar.";
    } else {
      recoverable = false;
      summary =
        "No se encontró un archivo asociado en storage y no hay egress activo. La recuperación desde la plataforma es poco probable.";
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          classId: classId.trim(),
          courseId,
          lessonId,
          roomName: liveSession.roomName,
          sessionStatus: liveSession.status,
          recordingStatus: liveSession.recording.status,
          egressId: liveSession.recording.egressId,
          errorMessage: liveSession.recording.errorMessage,
          errorCode: liveSession.recording.errorCode,
          storagePath: liveSession.recording.storagePath,
          resolvedObjectPath: objectLocation?.objectPath ?? null,
          storageObjectExists,
          backupManifestPath: liveSession.recording.backupManifestPath,
          resolvedBackupManifestPath: backupManifestLocation?.objectPath ?? null,
          backupManifestExists,
          activeEgressStatus,
          activeEgressError: activeEgress?.error ?? null,
          activeEgressErrorCode:
            typeof activeEgress?.errorCode === "number" ? activeEgress.errorCode : null,
          recoverable,
          summary,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toAdminTeacherRouteErrorResponse(
      error,
      "Error generando diagnóstico de clase en vivo",
    );
  }
}
