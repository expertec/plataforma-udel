import { NextRequest, NextResponse } from "next/server";
import { getAdminApp } from "@/lib/firebase/admin";
import { getLiveKitEgressConfig } from "@/lib/server/livekit";
import {
  requireAdminTeacherAccess,
  toAdminTeacherRouteErrorResponse,
} from "@/lib/server/require-admin-teacher-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toPositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

type FileMetadataLike = {
  updated?: unknown;
  size?: unknown;
  contentType?: unknown;
};

type StorageFileLike = {
  name: string;
  metadata?: FileMetadataLike | null;
  getMetadata: () => Promise<[FileMetadataLike, ...unknown[]]>;
  getSignedUrl: (options: { action: "read"; expires: number }) => Promise<[string, ...unknown[]]>;
};

const RAW_PAGE_SIZE = 200;
const MAX_SCAN_PAGES = 25;

function isRecordingArtifact(objectPath: string): boolean {
  const normalizedName = objectPath.toLowerCase();
  return normalizedName.endsWith(".mp4") || normalizedName.endsWith(".m3u8");
}

function matchesSearch(objectPath: string, query: string): boolean {
  if (!query) return true;
  return objectPath.toLowerCase().includes(query);
}

function toDisplayArtifactKey(objectPath: string): string {
  const normalizedName = objectPath.toLowerCase();
  if (normalizedName.endsWith(".m3u8")) {
    return objectPath.replace(/\/(?:index|live)\.m3u8$/i, "");
  }
  return objectPath;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdminTeacherAccess(request);

    const egressConfig = getLiveKitEgressConfig();
    const limit = toPositiveInt(request.nextUrl.searchParams.get("limit"), 12, 24);
    const pageToken = asText(request.nextUrl.searchParams.get("pageToken")) || undefined;
    const query = asText(request.nextUrl.searchParams.get("query")).toLowerCase();
    const bucket = getAdminApp().storage().bucket(egressConfig.egressBucket);
    const recordingFilesByPath = new Map<string, StorageFileLike>();
    const displayArtifactKeys = new Set<string>();
    let cursor = pageToken;
    let scans = 0;

    while (displayArtifactKeys.size < limit && scans < MAX_SCAN_PAGES) {
      const [files, nextQuery] = await bucket.getFiles({
        prefix: egressConfig.egressPrefix,
        autoPaginate: false,
        maxResults: RAW_PAGE_SIZE,
        pageToken: cursor,
      });

      files.forEach((file) => {
        if (!isRecordingArtifact(file.name) || !matchesSearch(file.name, query)) return;
        recordingFilesByPath.set(file.name, file);
        displayArtifactKeys.add(toDisplayArtifactKey(file.name));
      });

      cursor =
        nextQuery && typeof nextQuery.pageToken === "string" && nextQuery.pageToken
          ? nextQuery.pageToken
          : undefined;
      scans += 1;
      if (!cursor) break;
    }

    const recordingFiles = Array.from(recordingFilesByPath.values());
    const nextPageToken = cursor ?? null;

    const items = await Promise.all(
      recordingFiles.map(async (file) => {
        let metadata = (file.metadata ?? null) as FileMetadataLike | null;
        if (!metadata || Object.keys(metadata).length === 0) {
          try {
            const [fetchedMetadata] = await file.getMetadata();
            metadata = fetchedMetadata;
          } catch {
            metadata = null;
          }
        }

        const expiresAtMs = Date.now() + 10 * 60 * 1000;
        const [signedUrl] = await file.getSignedUrl({
          action: "read",
          expires: expiresAtMs,
        });

        return {
          objectPath: file.name,
          fileName: file.name.split("/").pop() ?? file.name,
          bucketName: egressConfig.egressBucket,
          signedUrl,
          artifactType: file.name.toLowerCase().endsWith(".m3u8") ? "hls_manifest" : "mp4",
          urlExpiresAt: new Date(expiresAtMs).toISOString(),
          updatedAt: asText(metadata?.updated) || null,
          sizeBytes: metadata?.size ? Number(metadata.size) : null,
          contentType:
            asText(metadata?.contentType) ||
            (file.name.toLowerCase().endsWith(".m3u8")
              ? "application/vnd.apple.mpegurl"
              : "video/mp4"),
        };
      }),
    );

    items.sort((a, b) => {
      const aMs = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bMs = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bMs - aMs;
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          items,
          prefix: egressConfig.egressPrefix,
          bucketName: egressConfig.egressBucket,
          limit,
          nextPageToken,
          fetchedAt: new Date().toISOString(),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toAdminTeacherRouteErrorResponse(error, "Error listando videos live-recordings");
  }
}
