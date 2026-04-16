import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
} from "@/lib/live-classes/access";
import { mergeTeacherEditableLiveSession } from "@/lib/live-classes/types";
import {
  buildRecordingObjectPath,
  ensureLiveKitRoom,
  extractRecordingObjectPath,
  startRoomCompositeRecording,
} from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await context.params;
    const access = await resolveAuthorizedLiveClassAccess({
      request,
      classId,
      requireTeacher: true,
    });

    const db = getAdminFirestore();
    const classRef = access.classContext.classRef;
    const startedAtIso = new Date().toISOString();
    const startedAtMs = Date.now();

    let roomName = "";
    let shouldStartRecording = false;
    let preparedObjectPath: string | null = null;
    let preparedSession = access.classContext.liveSession;

    await db.runTransaction(async (tx) => {
      const classSnap = await tx.get(classRef);
      if (!classSnap.exists) {
        throw new Error("Clase no encontrada");
      }
      const classData = (classSnap.data() ?? {}) as Record<string, unknown>;
      const session = mergeTeacherEditableLiveSession({
        courseId: access.classContext.courseId,
        lessonId: access.classContext.lessonId,
        classId: access.classContext.classId,
        current: classData.liveSession,
      });

      roomName = session.roomName;
      const recordingAlreadyRunning =
        Boolean(session.recording.egressId) ||
        session.recording.status === "recording" ||
        session.recording.status === "processing";

      const nextSession = {
        ...session,
        status: "live" as const,
        teacherActive: true,
        lastStartedAt: startedAtIso,
      };

      if (nextSession.recording.auto && !recordingAlreadyRunning) {
        preparedObjectPath = buildRecordingObjectPath({
          courseId: access.classContext.courseId,
          classId: access.classContext.classId,
          startedAtMs,
        });
        shouldStartRecording = true;
        nextSession.recording = {
          ...nextSession.recording,
          status: "processing",
          storagePath: preparedObjectPath,
          playbackReadyAt: null,
          durationSec: null,
        };
      }

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
      throw new Error("No se pudo resolver roomName");
    }

    await ensureLiveKitRoom(roomName);

    let egressId: string | null = null;
    if (shouldStartRecording) {
      try {
        const egressInfo = await startRoomCompositeRecording({
          roomName,
          objectPath: preparedObjectPath ?? "",
        });
        egressId = egressInfo.egressId || null;
        const objectPath = extractRecordingObjectPath(egressInfo) || preparedObjectPath || null;
        await classRef.set(
          {
            liveSession: {
              ...preparedSession,
              recording: {
                ...(preparedSession?.recording ?? {}),
                egressId,
                status: "recording",
                storagePath: objectPath,
              },
            },
          },
          { merge: true },
        );
      } catch (egressError) {
        console.error("No se pudo iniciar egress LiveKit", egressError);
        await classRef.set(
          {
            liveSession: {
              ...preparedSession,
              recording: {
                ...(preparedSession?.recording ?? {}),
                status: "failed",
                egressId: null,
              },
            },
          },
          { merge: true },
        );
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          classId: access.classContext.classId,
          roomName,
          recordingStarted: shouldStartRecording,
          egressId,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const handled = toLiveAccessErrorResponse(error);
    if (handled.status === 500) {
      console.error("Error iniciando clase en vivo", error);
    }
    return NextResponse.json(
      { success: false, error: handled.message },
      { status: handled.status },
    );
  }
}

