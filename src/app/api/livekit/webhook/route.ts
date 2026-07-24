import { EgressStatus } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  finalizeLiveAttendanceForClass,
  recordLiveAttendanceJoin,
  recordLiveAttendanceLeave,
  type LiveAttendanceParticipantInput,
} from "@/lib/live-classes/attendance";
import { resolveLiveClassByRoomName } from "@/lib/live-classes/access";
import { createLiveSessionForClass } from "@/lib/live-classes/types";
import {
  extractRecordingBackupLiveManifestPath,
  extractRecordingBackupManifestPath,
  extractRecordingObjectPath,
  getWebhookReceiver,
  stopActiveLiveKitEgressForRoom,
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

function parseParticipantMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed metadata
  }
  return {};
}

function parseRoleFromParticipantMetadata(raw: string | null | undefined): string {
  const role = parseParticipantMetadata(raw).role;
  return typeof role === "string" ? role.trim() : "";
}

function parseUidFromParticipantMetadata(raw: string | null | undefined): string | null {
  const uid = parseParticipantMetadata(raw).uid;
  return typeof uid === "string" && uid.trim() ? uid.trim() : null;
}

function toAttendanceParticipant(
  participant: {
    identity?: string | null;
    name?: string | null;
    metadata?: string | null;
  } | null | undefined,
): LiveAttendanceParticipantInput | null {
  const identity = participant?.identity?.trim() ?? "";
  if (!identity) return null;
  const name = participant?.name?.trim() || null;
  const metadata = participant?.metadata;
  return {
    identity,
    name,
    role: parseRoleFromParticipantMetadata(metadata) || null,
    uid: parseUidFromParticipantMetadata(metadata) ?? identity,
  };
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
    const sessionWasLive = isSessionLive(currentSession);

    const now = asIsoNow();
    if (event.event === "room_started") {
      if (sessionWasLive) {
        nextSession.status = "live";
        nextSession.teacherActive = true;
        nextSession.lastStartedAt = now;
      }
    } else if (event.event === "room_finished") {
      if (sessionWasLive) {
        const shouldForceProcessing =
          nextSession.recording.status === "recording" ||
          nextSession.recording.status === "processing";
        nextSession.teacherActive = false;
        nextSession.lastEndedAt = now;
        if (shouldForceProcessing) {
          nextSession.recording.status = "processing";
        }
        if (nextSession.recording.status === "ready") {
          nextSession.status = "recording_ready";
        } else if (nextSession.status !== "recording_ready") {
          nextSession.status = "ended";
        }
        try {
          console.info("[livekit:webhook] room_finished: stopping active egress", {
            classId: liveClass.classId,
            roomName,
            currentEgressId: nextSession.recording.egressId,
          });
          const stopSummary = await stopActiveLiveKitEgressForRoom(roomName);
          console.info("[livekit:webhook] room_finished: egress stop summary", {
            classId: liveClass.classId,
            roomName,
            ...stopSummary,
          });
        } catch (stopError) {
          console.error("[livekit:webhook] room_finished: failed to stop egress", {
            classId: liveClass.classId,
            roomName,
            error: stopError,
          });
        }
        try {
          await finalizeLiveAttendanceForClass(liveClass.classRef, now);
        } catch (attendanceError) {
          console.error("[livekit:webhook] room_finished: failed to finalize attendance", {
            classId: liveClass.classId,
            roomName,
            error: attendanceError,
          });
        }
      }
    } else if (event.event === "participant_joined") {
      const attendanceParticipant = toAttendanceParticipant(event.participant);
      if (attendanceParticipant) {
        try {
          await recordLiveAttendanceJoin(
            {
              classRef: liveClass.classRef,
              classId: liveClass.classId,
              courseId: liveClass.courseId,
              lessonId: liveClass.lessonId,
              roomName,
            },
            attendanceParticipant,
            now,
          );
        } catch (attendanceError) {
          console.error("[livekit:webhook] participant_joined: failed to record attendance", {
            classId: liveClass.classId,
            roomName,
            participantIdentity: attendanceParticipant.identity,
            error: attendanceError,
          });
        }
      }
      const role = parseRoleFromParticipantMetadata(event.participant?.metadata);
      if (role === "teacher" && sessionWasLive) {
        nextSession.teacherActive = true;
        nextSession.status = "live";
        nextSession.lastStartedAt = now;
      }
    } else if (event.event === "participant_left") {
      const attendanceParticipant = toAttendanceParticipant(event.participant);
      if (attendanceParticipant) {
        try {
          await recordLiveAttendanceLeave(
            {
              classRef: liveClass.classRef,
              classId: liveClass.classId,
              courseId: liveClass.courseId,
              lessonId: liveClass.lessonId,
              roomName,
            },
            attendanceParticipant,
            now,
          );
        } catch (attendanceError) {
          console.error("[livekit:webhook] participant_left: failed to record attendance", {
            classId: liveClass.classId,
            roomName,
            participantIdentity: attendanceParticipant.identity,
            error: attendanceError,
          });
        }
      }
      const role = parseRoleFromParticipantMetadata(event.participant?.metadata);
      if (role === "teacher" && sessionWasLive) {
        const shouldForceProcessing =
          nextSession.recording.status === "recording" ||
          nextSession.recording.status === "processing";
        nextSession.teacherActive = false;
        nextSession.lastEndedAt = now;
        if (shouldForceProcessing) {
          nextSession.recording.status = "processing";
        }
        if (nextSession.recording.status === "ready") {
          nextSession.status = "recording_ready";
        } else if (nextSession.status !== "recording_ready") {
          nextSession.status = "ended";
        }
        try {
          console.info("[livekit:webhook] participant_left(teacher): stopping active egress", {
            classId: liveClass.classId,
            roomName,
            currentEgressId: nextSession.recording.egressId,
          });
          const stopSummary = await stopActiveLiveKitEgressForRoom(roomName);
          console.info("[livekit:webhook] participant_left(teacher): egress stop summary", {
            classId: liveClass.classId,
            roomName,
            ...stopSummary,
          });
        } catch (stopError) {
          console.error("[livekit:webhook] participant_left(teacher): failed to stop egress", {
            classId: liveClass.classId,
            roomName,
            error: stopError,
          });
        }
        try {
          await finalizeLiveAttendanceForClass(liveClass.classRef, now);
        } catch (attendanceError) {
          console.error("[livekit:webhook] participant_left(teacher): failed to finalize attendance", {
            classId: liveClass.classId,
            roomName,
            error: attendanceError,
          });
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
        nextSession.recording.status = "failed";
        nextSession.status = sessionStillLive ? "live" : "ended";
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
