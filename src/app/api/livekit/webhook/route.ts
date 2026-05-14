import { EgressStatus } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { resolveLiveClassByRoomName } from "@/lib/live-classes/access";
import { createLiveSessionForClass } from "@/lib/live-classes/types";
import {
  buildRecordingOutputPaths,
  ensureRoomCompositeRecordingStarted,
  extractRecordingBackupLiveManifestPath,
  extractRecordingBackupManifestPath,
  extractRecordingObjectPath,
  getWebhookReceiver,
} from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asIsoNow(): string {
  return new Date().toISOString();
}

function asNumberFromBigInt(value: bigint | number | null | undefined): number | null {
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseRoleFromParticipantMetadata(raw: string | null | undefined): string {
  if (!raw?.trim()) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const role = (parsed as Record<string, unknown>).role;
      return typeof role === "string" ? role.trim() : "";
    }
  } catch {
    // ignore malformed metadata
  }
  return "";
}

function getRoomNameFromEvent(event: {
  room?: { name?: string | null };
  egressInfo?: { roomName?: string | null };
}): string {
  const fromRoom = event.room?.name?.trim() ?? "";
  if (fromRoom) return fromRoom;
  const fromEgress = event.egressInfo?.roomName?.trim() ?? "";
  return fromEgress;
}

function isSessionLive(session: {
  status?: string | null;
  teacherActive?: boolean | null;
}): boolean {
  return session.status === "live" || session.teacherActive === true;
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const authHeader =
      request.headers.get("authorization") ||
      request.headers.get("Authorize") ||
      request.headers.get("authorize") ||
      undefined;

    const receiver = getWebhookReceiver();
    const event = await receiver.receive(rawBody, authHeader);
    const roomName = getRoomNameFromEvent(event);
    if (!roomName) {
      return NextResponse.json({ success: true, ignored: true }, { status: 200 });
    }

    const liveClass = await resolveLiveClassByRoomName(roomName);
    if (!liveClass) {
      return NextResponse.json({ success: true, ignored: true }, { status: 200 });
    }

    const currentSession =
      liveClass.liveSession ??
      createLiveSessionForClass({
        courseId: liveClass.courseId,
        lessonId: liveClass.lessonId,
        classId: liveClass.classId,
        input: {
          roomName,
        },
      });

    const nextSession = {
      ...currentSession,
      roomName,
    };

    const now = asIsoNow();
    if (event.event === "room_started") {
      nextSession.status = "live";
      nextSession.teacherActive = true;
      nextSession.lastStartedAt = now;
    } else if (event.event === "room_finished") {
      nextSession.teacherActive = false;
      nextSession.lastEndedAt = now;
      if (nextSession.recording.status === "ready") {
        nextSession.status = "recording_ready";
      } else if (nextSession.status !== "recording_ready") {
        nextSession.status = "ended";
      }
    } else if (event.event === "participant_joined") {
      const role = parseRoleFromParticipantMetadata(event.participant?.metadata);
      if (role === "teacher") {
        nextSession.teacherActive = true;
        nextSession.status = "live";
        nextSession.lastStartedAt = now;
      }
    } else if (event.event === "participant_left") {
      const role = parseRoleFromParticipantMetadata(event.participant?.metadata);
      if (role === "teacher") {
        nextSession.teacherActive = false;
        nextSession.lastEndedAt = now;
        if (nextSession.recording.status === "ready") {
          nextSession.status = "recording_ready";
        } else if (nextSession.status !== "recording_ready") {
          nextSession.status = "ended";
        }
      }
    } else if (event.event === "egress_started" || event.event === "egress_updated") {
      const egress = event.egressInfo;
      const egressStatus = egress?.status;
      nextSession.recording.egressId = egress?.egressId || nextSession.recording.egressId;
      nextSession.recording.storagePath =
        (egress ? extractRecordingObjectPath(egress) : null) || nextSession.recording.storagePath;
      nextSession.recording.backupManifestPath =
        (egress ? extractRecordingBackupManifestPath(egress) : null) ||
        nextSession.recording.backupManifestPath;
      nextSession.recording.backupLiveManifestPath =
        (egress ? extractRecordingBackupLiveManifestPath(egress) : null) ||
        nextSession.recording.backupLiveManifestPath;
      nextSession.recording.errorMessage = asNullableString(egress?.error);
      nextSession.recording.errorCode = asNullableNumber(egress?.errorCode);
      if (egressStatus === EgressStatus.EGRESS_ACTIVE) {
        nextSession.recording.status = "recording";
      } else if (
        egressStatus === EgressStatus.EGRESS_STARTING ||
        egressStatus === EgressStatus.EGRESS_ENDING
      ) {
        nextSession.recording.status = "processing";
      }
    } else if (event.event === "egress_ended") {
      const egress = event.egressInfo;
      const objectPath = egress ? extractRecordingObjectPath(egress) : null;
      const backupManifestPath = egress ? extractRecordingBackupManifestPath(egress) : null;
      const backupLiveManifestPath = egress ? extractRecordingBackupLiveManifestPath(egress) : null;
      const fileInfo = egress?.fileResults?.[0];
      const durationSec = asNumberFromBigInt(fileInfo?.duration ?? null);
      const completed = egress?.status === EgressStatus.EGRESS_COMPLETE && Boolean(objectPath);
      const sessionStillLive = isSessionLive(nextSession);

      nextSession.recording.egressId = egress?.egressId || nextSession.recording.egressId;
      nextSession.recording.storagePath = objectPath || nextSession.recording.storagePath;
      nextSession.recording.backupManifestPath =
        backupManifestPath || nextSession.recording.backupManifestPath;
      nextSession.recording.backupLiveManifestPath =
        backupLiveManifestPath || nextSession.recording.backupLiveManifestPath;
      nextSession.recording.durationSec = durationSec ?? nextSession.recording.durationSec;
      nextSession.recording.errorMessage = asNullableString(egress?.error);
      nextSession.recording.errorCode = asNullableNumber(egress?.errorCode);

      if (completed) {
        nextSession.recording.status = "ready";
        nextSession.recording.playbackReadyAt = now;
        nextSession.recording.errorMessage = null;
        nextSession.recording.errorCode = null;
        nextSession.status = sessionStillLive ? "live" : "recording_ready";
      } else {
        const canRetryRecording =
          nextSession.recording.auto !== false &&
          sessionStillLive &&
          nextSession.recording.retryCount < nextSession.recording.maxRetryCount;

        if (canRetryRecording) {
          const retryStartedAtIso = asIsoNow();
          const retryCountBase = nextSession.recording.retryCount + 1;
          const retryOutputPaths = buildRecordingOutputPaths({
            courseId: liveClass.courseId,
            classId: liveClass.classId,
            startedAtMs: Date.now(),
            retryIndex: retryCountBase,
          });

          try {
            const recordingRestart = await ensureRoomCompositeRecordingStarted({
              roomName,
              outputPaths: retryOutputPaths,
            });
            nextSession.recording.egressId =
              recordingRestart.egressInfo.egressId || nextSession.recording.egressId;
            nextSession.recording.status = recordingRestart.recordingStatus;
            nextSession.recording.storagePath =
              extractRecordingObjectPath(recordingRestart.egressInfo) ||
              recordingRestart.outputPaths.mp4ObjectPath;
            nextSession.recording.backupManifestPath =
              extractRecordingBackupManifestPath(recordingRestart.egressInfo) ||
              recordingRestart.outputPaths.backupManifestPath;
            nextSession.recording.backupLiveManifestPath =
              extractRecordingBackupLiveManifestPath(recordingRestart.egressInfo) ||
              recordingRestart.outputPaths.backupLiveManifestPath;
            nextSession.recording.playbackReadyAt = null;
            nextSession.recording.durationSec = null;
            nextSession.recording.retryCount =
              nextSession.recording.retryCount + 1 + recordingRestart.retryCountUsed;
            nextSession.recording.lastRetryAt = retryStartedAtIso;
            nextSession.recording.errorMessage = null;
            nextSession.recording.errorCode = null;
            nextSession.status = "live";
          } catch (restartError) {
            const errorWithCode = restartError as { message?: unknown; code?: unknown };
            nextSession.recording.status = "failed";
            nextSession.recording.retryCount = retryCountBase;
            nextSession.recording.lastRetryAt = retryStartedAtIso;
            nextSession.recording.errorMessage =
              typeof errorWithCode.message === "string" && errorWithCode.message.trim()
                ? errorWithCode.message.trim()
                : "La grabación se cayó y el reinicio automático también falló";
            nextSession.recording.errorCode =
              typeof errorWithCode.code === "number" && Number.isFinite(errorWithCode.code)
                ? errorWithCode.code
                : null;
            nextSession.status = sessionStillLive ? "live" : "ended";
          }
        } else {
          nextSession.recording.status = "failed";
          nextSession.status = sessionStillLive ? "live" : "ended";
        }
      }
    }

    await getAdminFirestore()
      .doc(liveClass.classRef.path)
      .set(
        {
          liveSession: nextSession,
        },
        { merge: true },
      );

    return NextResponse.json(
      {
        success: true,
        data: {
          event: event.event,
          classId: liveClass.classId,
          roomName,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error procesando webhook LiveKit", error);
    return NextResponse.json(
      { success: false, error: "Webhook inválido" },
      { status: 400 },
    );
  }
}
