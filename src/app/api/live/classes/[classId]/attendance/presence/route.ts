import { NextRequest, NextResponse } from "next/server";
import {
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
} from "@/lib/live-classes/access";
import {
  recordLiveAttendanceJoin,
  recordLiveAttendanceLeave,
  recordLiveAttendanceCamera,
  type LiveAttendanceParticipantInput,
} from "@/lib/live-classes/attendance";
import { buildLiveRoomName } from "@/lib/live-classes/types";
import { isLiveKitNotFoundError, isLiveKitParticipantConnected, listLiveKitRoomParticipants } from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PresenceAction = "join" | "leave" | "sync" | "camera";

type PresenceBody = {
  action?: unknown;
  cameraEnabled?: unknown;
  roomConnected?: unknown;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asPresenceAction(value: unknown): PresenceAction | null {
  const action = asTrimmedString(value).toLowerCase();
  if (action === "join" || action === "leave" || action === "sync" || action === "camera") return action;
  return null;
}

function resolveLiveRoomName(params: {
  classId: string;
  courseId: string;
  lessonId: string;
  liveSessionRoomName: unknown;
}): string {
  const roomFromSession = asTrimmedString(params.liveSessionRoomName);
  if (roomFromSession) return roomFromSession;
  return buildLiveRoomName({
    courseId: params.courseId,
    lessonId: params.lessonId,
    classId: params.classId,
  });
}

function toStudentParticipant(access: Awaited<ReturnType<typeof resolveAuthorizedLiveClassAccess>>): LiveAttendanceParticipantInput {
  return {
    identity: access.user.uid,
    uid: access.user.uid,
    name: access.user.displayName,
    role: "student",
  };
}

export async function POST(
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
      allowCoordinatorAccess: true,
    });

    const body = (await request.json().catch(() => ({}))) as PresenceBody;
    const action = asPresenceAction(body.action);
    if (!action) {
      return NextResponse.json(
        { success: false, error: "Accion invalida. Usa join, leave, sync o camera." },
        { status: 400 },
      );
    }

    const roomName = resolveLiveRoomName({
      classId: access.classContext.classId,
      courseId: access.classContext.courseId,
      lessonId: access.classContext.lessonId,
      liveSessionRoomName: access.classContext.liveSession?.roomName,
    });
    const now = new Date().toISOString();

    if (action === "camera") {
      if (access.accessRole !== "student") {
        return NextResponse.json({ success: false, error: "Solo el alumno puede registrar su propia cámara." }, { status: 403 });
      }
      if (typeof body.cameraEnabled !== "boolean" || typeof body.roomConnected !== "boolean" || (body.cameraEnabled && !body.roomConnected)) {
        return NextResponse.json({ success: false, error: "El estado de cámara y conexión no es válido." }, { status: 400 });
      }
      if (access.classContext.liveSession?.status !== "live" || access.classContext.liveSession?.lastEndedAt) {
        return NextResponse.json({ success: true, ignored: true }, { status: 200 });
      }
      const attendanceContext = {
        classRef: access.classContext.classRef,
        classId: access.classContext.classId,
        courseId: access.classContext.courseId,
        lessonId: access.classContext.lessonId,
        roomName,
      };
      const participant = toStudentParticipant(access);
      const connected = body.roomConnected && await isLiveKitParticipantConnected(roomName, access.user.uid);
      await recordLiveAttendanceCamera(attendanceContext, participant, body.cameraEnabled && connected, now, connected);
      return NextResponse.json({ success: true }, { status: 200 });
    }

    if (action === "join") {
      if (access.accessRole !== "student") {
        return NextResponse.json({ success: true, ignored: true }, { status: 200 });
      }
      await recordLiveAttendanceJoin(
        {
          classRef: access.classContext.classRef,
          classId: access.classContext.classId,
          courseId: access.classContext.courseId,
          lessonId: access.classContext.lessonId,
          roomName,
        },
        toStudentParticipant(access),
        now,
      );
      return NextResponse.json({ success: true }, { status: 200 });
    }

    if (action === "leave") {
      if (access.accessRole !== "student") {
        return NextResponse.json({ success: true, ignored: true }, { status: 200 });
      }
      await recordLiveAttendanceLeave(
        {
          classRef: access.classContext.classRef,
          classId: access.classContext.classId,
          courseId: access.classContext.courseId,
          lessonId: access.classContext.lessonId,
          roomName,
        },
        toStudentParticipant(access),
        now,
      );
      return NextResponse.json({ success: true }, { status: 200 });
    }

    if (access.accessRole !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Missing or insufficient permissions." },
        { status: 403 },
      );
    }

    try {
      const participants = await listLiveKitRoomParticipants(roomName);
      const studentParticipants = participants.filter((participant) => participant.role === "student");
      await Promise.all(
        studentParticipants.map((participant) =>
          recordLiveAttendanceJoin(
            {
              classRef: access.classContext.classRef,
              classId: access.classContext.classId,
              courseId: access.classContext.courseId,
              lessonId: access.classContext.lessonId,
              roomName,
            },
            {
              identity: participant.identity,
              uid: participant.identity,
              name: participant.name,
              role: "student",
            },
            now,
          ),
        ),
      );

      return NextResponse.json(
        {
          success: true,
          data: {
            syncedParticipants: studentParticipants.length,
          },
        },
        { status: 200 },
      );
    } catch (error) {
      if (!isLiveKitNotFoundError(error)) throw error;
      return NextResponse.json(
        {
          success: true,
          data: {
            syncedParticipants: 0,
          },
        },
        { status: 200 },
      );
    }
  } catch (error: unknown) {
    const handled = toLiveAccessErrorResponse(error);
    if (handled.status === 500) {
      console.error("Error registrando presencia de asistencia en vivo", error);
    }
    return NextResponse.json(
      { success: false, error: handled.message },
      { status: handled.status },
    );
  }
}
