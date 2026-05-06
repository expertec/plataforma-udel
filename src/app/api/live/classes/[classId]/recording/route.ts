import { NextRequest, NextResponse } from "next/server";
import { getAdminApp } from "@/lib/firebase/admin";
import {
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
  LiveAccessError,
} from "@/lib/live-classes/access";
import { createLiveSessionForClass } from "@/lib/live-classes/types";
import { getLiveKitEgressConfig } from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeObjectPath(value: string): string {
  return value.replace(/^\/+/, "").trim();
}

type ObjectLocation = {
  bucketName: string;
  objectPath: string;
};

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
    const directMatch = value.match(/\/([^/]+)\/o\/([^?]+)/);
    if (directMatch) {
      const bucketName = asTrimmedString(directMatch[1]);
      const objectPath = normalizeObjectPath(decodeURIComponent(directMatch[2]));
      if (!bucketName || !objectPath) return null;
      return { bucketName, objectPath };
    }
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
    });

    const egressConfig = getLiveKitEgressConfig();
    let liveSession = access.classContext.liveSession;
    let recordingReady = isRecordingReady(liveSession);

    let storagePath = liveSession?.recording.storagePath ?? "";
    let objectLocation = extractObjectLocation(storagePath, egressConfig.egressBucket);

    if (!recordingReady && objectLocation) {
      const storageBucket = getAdminApp().storage().bucket(objectLocation.bucketName);
      const [fileExists] = await storageBucket.file(objectLocation.objectPath).exists();
      if (fileExists) {
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
            storagePath: baseSession.recording.storagePath || objectLocation.objectPath,
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
        storagePath = liveSession.recording.storagePath ?? storagePath;
        objectLocation = extractObjectLocation(storagePath, egressConfig.egressBucket);
      }
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
