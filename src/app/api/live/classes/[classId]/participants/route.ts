import { NextRequest, NextResponse } from "next/server";
import {
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
} from "@/lib/live-classes/access";
import { buildLiveRoomName } from "@/lib/live-classes/types";
import {
  isLiveKitNotFoundError,
  listLiveKitRoomParticipants,
  muteAllLiveKitParticipantMicrophones,
  muteLiveKitParticipantMicrophones,
} from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LiveParticipantsActionBody = {
  action?: unknown;
  participantIdentity?: unknown;
  includeTeacherParticipants?: unknown;
  excludeSelf?: unknown;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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
      requireTeacher: true,
    });

    const roomName = resolveLiveRoomName({
      classId: access.classContext.classId,
      courseId: access.classContext.courseId,
      lessonId: access.classContext.lessonId,
      liveSessionRoomName: access.classContext.liveSession?.roomName,
    });

    try {
      const participants = await listLiveKitRoomParticipants(roomName);
      return NextResponse.json(
        {
          success: true,
          data: {
            classId: access.classContext.classId,
            roomName,
            participants,
          },
        },
        { status: 200 },
      );
    } catch (error) {
      if (!isLiveKitNotFoundError(error)) {
        throw error;
      }
      return NextResponse.json(
        {
          success: true,
          data: {
            classId: access.classContext.classId,
            roomName,
            participants: [],
          },
        },
        { status: 200 },
      );
    }
  } catch (error: unknown) {
    const handled = toLiveAccessErrorResponse(error);
    if (handled.status === 500) {
      console.error("Error listando participantes de clase en vivo", error);
    }
    return NextResponse.json(
      { success: false, error: handled.message },
      { status: handled.status },
    );
  }
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
      requireTeacher: true,
    });

    const roomName = resolveLiveRoomName({
      classId: access.classContext.classId,
      courseId: access.classContext.courseId,
      lessonId: access.classContext.lessonId,
      liveSessionRoomName: access.classContext.liveSession?.roomName,
    });

    const body = (await request.json().catch(() => ({}))) as LiveParticipantsActionBody;
    const action = asTrimmedString(body.action).toLowerCase();

    if (action === "mute_participant") {
      const participantIdentity = asTrimmedString(body.participantIdentity);
      if (!participantIdentity) {
        return NextResponse.json(
          { success: false, error: "participantIdentity es requerido" },
          { status: 400 },
        );
      }

      try {
        const result = await muteLiveKitParticipantMicrophones({
          roomName,
          participantIdentity,
        });
        return NextResponse.json(
          {
            success: true,
            data: {
              action: "mute_participant",
              classId: access.classContext.classId,
              roomName,
              result,
            },
          },
          { status: 200 },
        );
      } catch (error) {
        if (!isLiveKitNotFoundError(error)) {
          throw error;
        }
        return NextResponse.json(
          { success: false, error: "La sala o el participante no están disponibles." },
          { status: 409 },
        );
      }
    }

    if (action === "mute_all") {
      const includeTeacherParticipants = asBoolean(body.includeTeacherParticipants, false);
      const excludeSelf = asBoolean(body.excludeSelf, true);
      try {
        const result = await muteAllLiveKitParticipantMicrophones({
          roomName,
          excludeIdentities: excludeSelf ? [access.user.uid] : [],
          excludeTeacherRoleParticipants: !includeTeacherParticipants,
        });
        return NextResponse.json(
          {
            success: true,
            data: {
              action: "mute_all",
              classId: access.classContext.classId,
              roomName,
              result,
            },
          },
          { status: 200 },
        );
      } catch (error) {
        if (!isLiveKitNotFoundError(error)) {
          throw error;
        }
        return NextResponse.json(
          { success: false, error: "La sala no está disponible." },
          { status: 409 },
        );
      }
    }

    return NextResponse.json(
      { success: false, error: "Acción inválida. Usa mute_participant o mute_all." },
      { status: 400 },
    );
  } catch (error: unknown) {
    const handled = toLiveAccessErrorResponse(error);
    if (handled.status === 500) {
      console.error("Error moderando participantes de clase en vivo", error);
    }
    return NextResponse.json(
      { success: false, error: handled.message },
      { status: handled.status },
    );
  }
}
