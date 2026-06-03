import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TeacherRole =
  | "teacher"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel"
  | "director";

type VimeoVideoResponse = {
  name?: unknown;
  duration?: unknown;
  download?: unknown;
  files?: unknown;
};

type VimeoPlayerConfigResponse = {
  video?: unknown;
  request?: unknown;
};

type VimeoDownloadCandidate = {
  link: string;
  width: number;
  height: number;
  size: number;
};

type VimeoResolveResult = {
  selected: VimeoDownloadCandidate;
  videoTitle: string;
  source: "player-config" | "api";
};

type ImportVimeoRequest = {
  sourceUrl?: unknown;
  lessonId?: unknown;
  classId?: unknown;
  title?: unknown;
};

class RouteAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asTeacherRole(value: unknown): TeacherRole | null {
  if (
    value === "teacher" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher" ||
    value === "coordinadorPlantel" ||
    value === "director"
  ) {
    return value;
  }
  return null;
}

function sanitizeBucketName(value: string): string {
  return value.replace(/^gs:\/\//i, "").trim();
}

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseVimeoVideoInfo(sourceUrl: string): { videoId: string | null; unlistedHash: string | null } {
  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.toLowerCase();
    if (!host.includes("vimeo.com")) return { videoId: null, unlistedHash: null };

    const queryHash = asTrimmedString(url.searchParams.get("h"));

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return { videoId: null, unlistedHash: queryHash || null };

    // player.vimeo.com/video/{id}
    if (parts[0] === "video" && /^\d+$/.test(parts[1] ?? "")) {
      return {
        videoId: parts[1] ?? null,
        unlistedHash: queryHash || null,
      };
    }

    // vimeo.com/{id}/{hash?}
    const numericIndex = parts.findIndex((part) => /^\d+$/.test(part));
    if (numericIndex < 0) {
      return { videoId: null, unlistedHash: queryHash || null };
    }
    const nextPart = parts[numericIndex + 1] ?? "";
    const pathHash = /^[a-zA-Z0-9]+$/.test(nextPart) ? nextPart : "";
    return {
      videoId: parts[numericIndex] ?? null,
      unlistedHash: queryHash || pathHash || null,
    };
  } catch {
    return { videoId: null, unlistedHash: null };
  }
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pushDownloadCandidate(
  candidates: VimeoDownloadCandidate[],
  link: unknown,
  width: unknown,
  height: unknown,
  size: unknown,
) {
  const normalizedLink = asTrimmedString(link);
  if (!normalizedLink) return;
  candidates.push({
    link: normalizedLink,
    width: toNumber(width),
    height: toNumber(height),
    size: toNumber(size),
  });
}

function parseVimeoDownloadCandidates(payload: VimeoVideoResponse): VimeoDownloadCandidate[] {
  const candidates: VimeoDownloadCandidate[] = [];

  if (Array.isArray(payload.download)) {
    payload.download.forEach((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const data = entry as Record<string, unknown>;
      pushDownloadCandidate(candidates, data.link, data.width, data.height, data.size);
    });
  }

  if (Array.isArray(payload.files)) {
    payload.files.forEach((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const data = entry as Record<string, unknown>;
      const mimeType = asTrimmedString(data.mime_type);
      const type = asTrimmedString(data.type);
      const looksPlayable =
        mimeType.includes("video/mp4") || type === "video/mp4" || type === "video";
      if (!looksPlayable) return;
      pushDownloadCandidate(candidates, data.link, data.width, data.height, data.size);
    });
  }

  return candidates;
}

function parseVimeoDownloadCandidatesFromPlayerConfig(
  payload: VimeoPlayerConfigResponse,
): { candidates: VimeoDownloadCandidate[]; videoTitle: string } {
  const root = asRecord(payload);
  const videoTitle = asTrimmedString(asRecord(root.video).title);
  const request = asRecord(root.request);
  const files = asRecord(request.files);

  const candidates: VimeoDownloadCandidate[] = [];

  if (Array.isArray(files.progressive)) {
    files.progressive.forEach((entry) => {
      const data = asRecord(entry);
      pushDownloadCandidate(candidates, data.url, data.width, data.height, data.size);
    });
  }

  if (Array.isArray(files.download)) {
    files.download.forEach((entry) => {
      const data = asRecord(entry);
      pushDownloadCandidate(candidates, data.link, data.width, data.height, data.size);
    });
  }

  return { candidates, videoTitle };
}

function pickBestCandidate(candidates: VimeoDownloadCandidate[]): VimeoDownloadCandidate | null {
  if (candidates.length === 0) return null;

  const withScore = candidates.map((candidate) => {
    const width = candidate.width || 0;
    const under1080Penalty = width > 1080 ? width - 1080 : 0;
    const preference = under1080Penalty === 0 ? width : -under1080Penalty;
    return { candidate, preference };
  });

  withScore.sort((left, right) => {
    if (right.preference !== left.preference) {
      return right.preference - left.preference;
    }
    return right.candidate.size - left.candidate.size;
  });

  return withScore[0]?.candidate ?? null;
}

async function resolveVimeoDownloadViaPlayerConfig(params: {
  videoId: string;
  unlistedHash: string | null;
}): Promise<VimeoResolveResult | null> {
  const { videoId, unlistedHash } = params;

  const endpoints = [
    `https://player.vimeo.com/video/${encodeURIComponent(videoId)}/config${
      unlistedHash ? `?h=${encodeURIComponent(unlistedHash)}` : ""
    }`,
    `https://player.vimeo.com/video/${encodeURIComponent(videoId)}/config`,
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) continue;

      const payload = (await response.json()) as VimeoPlayerConfigResponse;
      const { candidates, videoTitle } = parseVimeoDownloadCandidatesFromPlayerConfig(payload);
      const selected = pickBestCandidate(candidates);
      if (!selected) continue;

      return {
        selected,
        videoTitle,
        source: "player-config",
      };
    } catch {
      // Continuar con el siguiente endpoint (o fallback a API con token).
      continue;
    }
  }

  return null;
}

async function resolveVimeoDownloadViaApi(params: {
  videoId: string;
  accessToken: string;
}): Promise<VimeoResolveResult> {
  const vimeoInfoResponse = await fetch(
    `https://api.vimeo.com/videos/${encodeURIComponent(params.videoId)}?fields=name,duration,download,files`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: "application/vnd.vimeo.*+json;version=3.4",
      },
      cache: "no-store",
    },
  );

  if (!vimeoInfoResponse.ok) {
    const reason = await vimeoInfoResponse.text().catch(() => "");
    throw new RouteAccessError(
      400,
      reason
        ? `Vimeo rechazó la descarga (${vimeoInfoResponse.status}): ${reason.slice(0, 160)}`
        : `Vimeo rechazó la descarga (${vimeoInfoResponse.status})`,
    );
  }

  const payload = (await vimeoInfoResponse.json()) as VimeoVideoResponse;
  const candidates = parseVimeoDownloadCandidates(payload);
  const selected = pickBestCandidate(candidates);
  if (!selected) {
    throw new RouteAccessError(
      400,
      "No hay archivo descargable disponible en Vimeo para este video.",
    );
  }

  return {
    selected,
    videoTitle: asTrimmedString(payload.name),
    source: "api",
  };
}

async function resolveTeacherContext(request: NextRequest): Promise<{ uid: string; role: TeacherRole }> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    throw new RouteAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new RouteAccessError(401, "Token inválido o expirado");
  }

  const uid = decodedToken.uid;
  const userSnap = await getAdminFirestore().collection("users").doc(uid).get();
  const role = asTeacherRole(userSnap.data()?.role) ?? asTeacherRole(decodedToken.role);
  if (!role) {
    throw new RouteAccessError(403, "Acceso restringido a docentes");
  }

  return { uid, role };
}

async function assertCourseAccess(params: {
  courseId: string;
  uid: string;
  role: TeacherRole;
}) {
  const { courseId, uid, role } = params;
  const courseSnap = await getAdminFirestore().collection("courses").doc(courseId).get();
  if (!courseSnap.exists) {
    throw new RouteAccessError(404, "Curso no encontrado");
  }

  if (
    role === "adminTeacher" ||
    role === "superAdminTeacher" ||
    role === "coordinadorPlantel" ||
    role === "director"
  ) {
    return;
  }

  const courseData = (courseSnap.data() ?? {}) as Record<string, unknown>;
  const teacherId = asTrimmedString(courseData.teacherId);
  if (teacherId && teacherId === uid) return;

  const mentorIds = Array.isArray(courseData.mentorIds)
    ? courseData.mentorIds.filter(
        (mentorId): mentorId is string => typeof mentorId === "string" && mentorId.trim().length > 0,
      )
    : [];
  if (mentorIds.includes(uid)) return;

  throw new RouteAccessError(403, "Missing or insufficient permissions.");
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }

  console.error("Error importando video de Vimeo", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ courseId: string }> },
) {
  try {
    const { courseId } = await context.params;
    const normalizedCourseId = asTrimmedString(courseId);
    if (!normalizedCourseId) {
      throw new RouteAccessError(400, "courseId inválido");
    }

    const teacherContext = await resolveTeacherContext(request);
    await assertCourseAccess({
      courseId: normalizedCourseId,
      uid: teacherContext.uid,
      role: teacherContext.role,
    });

    const rawBody = (await request.json().catch(() => null)) as ImportVimeoRequest | null;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new RouteAccessError(400, "Body inválido");
    }

    const sourceUrl = asTrimmedString(rawBody.sourceUrl);
    if (!sourceUrl) {
      throw new RouteAccessError(400, "sourceUrl es requerido");
    }

    const { videoId: vimeoVideoId, unlistedHash } = parseVimeoVideoInfo(sourceUrl);
    if (!vimeoVideoId) {
      throw new RouteAccessError(400, "La URL no corresponde a un video válido de Vimeo");
    }

    const vimeoAccessToken = asTrimmedString(process.env.VIMEO_ACCESS_TOKEN);
    const playerConfigResolved = await resolveVimeoDownloadViaPlayerConfig({
      videoId: vimeoVideoId,
      unlistedHash,
    });
    const resolved =
      playerConfigResolved ??
      (vimeoAccessToken
        ? await resolveVimeoDownloadViaApi({
            videoId: vimeoVideoId,
            accessToken: vimeoAccessToken,
          })
        : null);

    if (!resolved) {
      throw new RouteAccessError(
        400,
        "No se pudo obtener un archivo descargable desde Vimeo. Configura VIMEO_ACCESS_TOKEN o verifica permisos del video.",
      );
    }

    const videoResponse = await fetch(resolved.selected.link, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
    });
    if (!videoResponse.ok || !videoResponse.body) {
      throw new RouteAccessError(
        400,
        `No se pudo descargar el archivo de Vimeo (${videoResponse.status})`,
      );
    }

    const contentLength = Number(videoResponse.headers.get("content-length") ?? "0");
    const configuredMaxBytes = Number(process.env.VIMEO_IMPORT_MAX_BYTES ?? `${1024 * 1024 * 1024}`);
    const maxBytes = Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
      ? configuredMaxBytes
      : 1024 * 1024 * 1024;
    if (contentLength > 0 && contentLength > maxBytes) {
      throw new RouteAccessError(
        413,
        `El video excede el tamaño máximo permitido (${Math.round(maxBytes / (1024 * 1024))}MB).`,
      );
    }

    const bucketFromEnv =
      asTrimmedString(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET) ||
      asTrimmedString(process.env.FIREBASE_STORAGE_BUCKET) ||
      asTrimmedString((getAdminApp().options.storageBucket as string | undefined) ?? "");
    const bucketName = sanitizeBucketName(bucketFromEnv);
    if (!bucketName) {
      throw new RouteAccessError(500, "No se pudo resolver el bucket de Firebase Storage");
    }

    const lessonId = sanitizePathSegment(asTrimmedString(rawBody.lessonId), "sin-leccion");
    const classId = sanitizePathSegment(asTrimmedString(rawBody.classId), "sin-clase");
    const videoTitle = sanitizePathSegment(
      asTrimmedString(rawBody.title) || resolved.videoTitle,
      `video-${vimeoVideoId}`,
    );

    const objectPath = `course-videos/${sanitizePathSegment(normalizedCourseId, "curso")}/${lessonId}/${classId}/${Date.now()}-${videoTitle}.mp4`;
    const contentType = videoResponse.headers.get("content-type")?.split(";")[0] || "video/mp4";
    const downloadToken = randomUUID();

    const bucket = getAdminApp().storage().bucket(bucketName);
    const file = bucket.file(objectPath);

    await pipeline(
      Readable.fromWeb(
        videoResponse.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      ),
      file.createWriteStream({
        resumable: false,
        metadata: {
          contentType,
          cacheControl: "public,max-age=31536000",
          metadata: {
            firebaseStorageDownloadTokens: downloadToken,
            source: "vimeo",
            sourceUrl,
            vimeoVideoId,
            vimeoResolveMethod: resolved.source,
            importedBy: teacherContext.uid,
            importedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(objectPath)}?alt=media&token=${downloadToken}`;

    return NextResponse.json({
      success: true,
      data: {
        downloadUrl,
        objectPath,
        bucketName: bucket.name,
        vimeoVideoId,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
