import { NextRequest, NextResponse } from "next/server";
import { getAdminApp } from "@/lib/firebase/admin";
import {
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
  LiveAccessError,
} from "@/lib/live-classes/access";
import { getLiveKitConfig } from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeObjectPath(value: string): string {
  return value.replace(/^\/+/, "").trim();
}

function extractObjectPath(rawStoragePath: string, bucketName: string): string | null {
  const value = rawStoragePath.trim();
  if (!value) return null;
  if (value.startsWith("gs://")) {
    const withoutScheme = value.slice("gs://".length);
    const slashIdx = withoutScheme.indexOf("/");
    if (slashIdx < 0) return null;
    const bucket = withoutScheme.slice(0, slashIdx);
    if (bucket !== bucketName) return null;
    return normalizeObjectPath(withoutScheme.slice(slashIdx + 1));
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    const directMatch = value.match(/\/([^/]+)\/o\/([^?]+)/);
    if (directMatch && directMatch[1] === bucketName) {
      return normalizeObjectPath(decodeURIComponent(directMatch[2]));
    }
  }
  return normalizeObjectPath(value);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await context.params;
    const access = await resolveAuthorizedLiveClassAccess({
      request,
      classId,
      requireTeacher: false,
    });

    const liveSession = access.classContext.liveSession;
    const recordingReady =
      liveSession?.status === "recording_ready" || liveSession?.recording.status === "ready";
    if (!recordingReady) {
      throw new LiveAccessError(409, "La grabación aún se está procesando");
    }
    const storagePath = liveSession?.recording.storagePath ?? "";
    if (!storagePath) {
      throw new LiveAccessError(404, "La grabación aún no está disponible");
    }

    const config = getLiveKitConfig();
    const objectPath = extractObjectPath(storagePath, config.egressBucket);
    if (!objectPath) {
      throw new LiveAccessError(404, "No se encontró un archivo válido de grabación");
    }

    const bucket = getAdminApp().storage().bucket(config.egressBucket);
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const [signedUrl] = await bucket.file(objectPath).getSignedUrl({
      action: "read",
      expires: expiresAt,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          url: signedUrl,
          expiresAt: new Date(expiresAt).toISOString(),
          objectPath,
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
