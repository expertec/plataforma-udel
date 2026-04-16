import { EgressStatus } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { resolveLiveClassByRoomName } from "@/lib/live-classes/access";
import { createLiveSessionForClass } from "@/lib/live-classes/types";
import { extractRecordingObjectPath, getWebhookReceiver } from "@/lib/server/livekit";

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
      }
    } else if (event.event === "egress_started" || event.event === "egress_updated") {
      const egress = event.egressInfo;
      const egressStatus = egress?.status;
      nextSession.recording.egressId = egress?.egressId || nextSession.recording.egressId;
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
      const fileInfo = egress?.fileResults?.[0];
      const durationSec = asNumberFromBigInt(fileInfo?.duration ?? null);
      const completed = egress?.status === EgressStatus.EGRESS_COMPLETE && Boolean(objectPath);

      nextSession.recording.egressId = egress?.egressId || nextSession.recording.egressId;
      nextSession.recording.storagePath = objectPath || nextSession.recording.storagePath;
      nextSession.recording.durationSec = durationSec ?? nextSession.recording.durationSec;
      nextSession.teacherActive = false;
      nextSession.lastEndedAt = now;

      if (completed) {
        nextSession.recording.status = "ready";
        nextSession.recording.playbackReadyAt = now;
        nextSession.status = "recording_ready";
      } else {
        nextSession.recording.status = "failed";
        if (nextSession.status !== "recording_ready") {
          nextSession.status = "ended";
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

