import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
} from "@/lib/live-classes/access";
import {
  buildLiveRoomName,
  createLiveSessionForClass,
  normalizeLiveSession,
} from "@/lib/live-classes/types";
import { createJoinToken, ensureLiveKitRoom, getLiveKitConfig } from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TokenRequestBody = {
  classId?: unknown;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as TokenRequestBody;
    const classId = asTrimmedString(body.classId);
    if (!classId) {
      return NextResponse.json(
        { success: false, error: "classId es requerido" },
        { status: 400 },
      );
    }

    const access = await resolveAuthorizedLiveClassAccess({
      request,
      classId,
      requireTeacher: false,
    });

    const currentSession = access.classContext.liveSession;
    const fallbackSession = createLiveSessionForClass({
      courseId: access.classContext.courseId,
      lessonId: access.classContext.lessonId,
      classId: access.classContext.classId,
      input: currentSession,
    });

    const roomName =
      normalizeLiveSession(currentSession)?.roomName ||
      buildLiveRoomName({
        courseId: access.classContext.courseId,
        lessonId: access.classContext.lessonId,
        classId: access.classContext.classId,
      });

    const session = {
      ...fallbackSession,
      roomName,
    };

    const isTeacher = access.accessRole === "teacher";
    const isSessionLive = session.status === "live" || session.teacherActive;
    const joinAllowed = isTeacher || isSessionLive;

    if (!joinAllowed) {
      if (!currentSession || currentSession.roomName !== session.roomName) {
        await getAdminFirestore()
          .doc(access.classContext.classRef.path)
          .set(
            {
              liveSession: {
                ...session,
              },
            },
            { merge: true },
          );
      }
      return NextResponse.json(
        {
          success: true,
          data: {
            classId: access.classContext.classId,
            roomName: session.roomName,
            joinAllowed: false,
            waitingReason:
              session.status === "recording_ready" || session.status === "ended"
                ? "session_ended"
                : "waiting_teacher",
            asRole: access.accessRole,
            liveSession: session,
          },
        },
        { status: 200 },
      );
    }

    await ensureLiveKitRoom(session.roomName);

    const token = await createJoinToken({
      roomName: session.roomName,
      identity: access.user.uid,
      participantName: access.user.displayName,
      isTeacher,
      metadata: {
        uid: access.user.uid,
        role: access.accessRole,
        classId: access.classContext.classId,
        courseId: access.classContext.courseId,
      },
    });

    if (!currentSession || currentSession.roomName !== session.roomName) {
      await getAdminFirestore()
        .doc(access.classContext.classRef.path)
        .set(
          {
            liveSession: {
              ...session,
            },
          },
          { merge: true },
        );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          token,
          livekitUrl: getLiveKitConfig().url,
          roomName: session.roomName,
          classId: access.classContext.classId,
          classTitle:
            asTrimmedString(access.classContext.classData.title) || "Clase en vivo",
          joinAllowed: true,
          asRole: access.accessRole,
          liveSession: session,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const handled = toLiveAccessErrorResponse(error);
    if (handled.status === 500) {
      console.error("Error generando token LiveKit", error);
    }
    return NextResponse.json(
      { success: false, error: handled.message },
      { status: handled.status },
    );
  }
}
