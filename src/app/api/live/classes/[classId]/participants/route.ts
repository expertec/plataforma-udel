import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  LiveAccessError,
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
} from "@/lib/live-classes/access";
import {
  buildLiveRoomName,
  createLiveSessionForClass,
  normalizeLiveSession,
  type LiveClassSession,
  type LiveWaitingRoomParticipant,
} from "@/lib/live-classes/types";
import {
  admitAllWaitingRoomParticipantDocs,
  listPendingWaitingRoomParticipantSummaries,
  updateWaitingRoomParticipantStatus,
  type LiveWaitingRoomParticipantSummary,
} from "@/lib/live-classes/waiting-room";
import {
  isLiveKitNotFoundError,
  listLiveKitRoomParticipants,
  muteAllLiveKitParticipantMicrophones,
  muteLiveKitParticipantMicrophones,
  unmuteLiveKitParticipantMicrophones,
} from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LiveParticipantsActionBody = {
  action?: unknown;
  participantIdentity?: unknown;
  waitingParticipantId?: unknown;
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

function isLiveSessionFinalized(session: LiveClassSession): boolean {
  if (session.status === "live" || session.teacherActive === true) return false;
  return (
    Boolean(session.lastEndedAt) ||
    session.status === "ended" ||
    session.status === "recording_ready"
  );
}

function isLiveSessionJoinable(session: LiveClassSession): boolean {
  return session.status === "live" || session.teacherActive;
}

function toWaitingRoomParticipantSummary(
  participant: LiveWaitingRoomParticipant,
): LiveWaitingRoomParticipantSummary {
  return {
    uid: participant.uid,
    displayName: participant.displayName,
    email: participant.email,
    status: participant.status,
    requestedAt: participant.requestedAt,
    decidedAt: participant.decidedAt,
    decidedBy: participant.decidedBy,
    updatedAt: participant.updatedAt,
  };
}

async function listPendingWaitingRoomParticipants(
  access: Awaited<ReturnType<typeof resolveAuthorizedLiveClassAccess>>,
): Promise<LiveWaitingRoomParticipantSummary[]> {
  return listPendingWaitingRoomParticipantSummaries({
    classRef: access.classContext.classRef,
    session: access.classContext.liveSession,
  });
}

async function updateWaitingRoomParticipant(params: {
  access: Awaited<ReturnType<typeof resolveAuthorizedLiveClassAccess>>;
  waitingParticipantId: string;
  nextStatus: "admitted" | "rejected";
}): Promise<LiveWaitingRoomParticipantSummary> {
  const documentParticipant = await updateWaitingRoomParticipantStatus({
    classRef: params.access.classContext.classRef,
    uid: params.waitingParticipantId,
    nextStatus: params.nextStatus,
    decidedBy: params.access.user.uid,
  });
  if (documentParticipant) return documentParticipant;

  const db = getAdminFirestore();
  const nowIso = new Date().toISOString();
  let updatedParticipant: LiveWaitingRoomParticipantSummary | null = null;

  await db.runTransaction(async (tx) => {
    const classSnap = await tx.get(params.access.classContext.classRef);
    if (!classSnap.exists) {
      throw new LiveAccessError(404, "Clase no encontrada");
    }
    const classData = (classSnap.data() ?? {}) as Record<string, unknown>;
    const session =
      normalizeLiveSession(classData.liveSession) ??
      createLiveSessionForClass({
        courseId: params.access.classContext.courseId,
        lessonId: params.access.classContext.lessonId,
        classId: params.access.classContext.classId,
        input: classData.liveSession,
      });

    if (isLiveSessionFinalized(session) || !isLiveSessionJoinable(session)) {
      throw new LiveAccessError(409, "La clase no está abierta para admitir alumnos.");
    }

    const currentParticipant = session.waitingRoom.participants[params.waitingParticipantId];
    if (!currentParticipant) {
      throw new LiveAccessError(404, "Alumno no encontrado en la sala de espera.");
    }

    const nextParticipant = {
      ...currentParticipant,
      status: params.nextStatus,
      decidedAt: nowIso,
      decidedBy: params.access.user.uid,
      updatedAt: nowIso,
    };
    const nextSession = {
      ...session,
      waitingRoom: {
        ...session.waitingRoom,
        participants: {
          ...session.waitingRoom.participants,
          [params.waitingParticipantId]: nextParticipant,
        },
      },
    };
    tx.set(params.access.classContext.classRef, { liveSession: nextSession }, { merge: true });
    updatedParticipant = toWaitingRoomParticipantSummary(nextParticipant);
  });

  if (!updatedParticipant) {
    throw new LiveAccessError(500, "No se pudo actualizar la sala de espera.");
  }
  return updatedParticipant;
}

async function admitAllWaitingRoomParticipants(params: {
  access: Awaited<ReturnType<typeof resolveAuthorizedLiveClassAccess>>;
}): Promise<LiveWaitingRoomParticipantSummary[]> {
  const documentParticipants = await admitAllWaitingRoomParticipantDocs({
    classRef: params.access.classContext.classRef,
    decidedBy: params.access.user.uid,
  });
  const db = getAdminFirestore();
  const nowIso = new Date().toISOString();
  let updatedParticipants: LiveWaitingRoomParticipantSummary[] = [];

  await db.runTransaction(async (tx) => {
    const classSnap = await tx.get(params.access.classContext.classRef);
    if (!classSnap.exists) {
      throw new LiveAccessError(404, "Clase no encontrada");
    }
    const classData = (classSnap.data() ?? {}) as Record<string, unknown>;
    const session =
      normalizeLiveSession(classData.liveSession) ??
      createLiveSessionForClass({
        courseId: params.access.classContext.courseId,
        lessonId: params.access.classContext.lessonId,
        classId: params.access.classContext.classId,
        input: classData.liveSession,
      });

    if (isLiveSessionFinalized(session) || !isLiveSessionJoinable(session)) {
      throw new LiveAccessError(409, "La clase no está abierta para admitir alumnos.");
    }

    const nextParticipants = { ...session.waitingRoom.participants };
    updatedParticipants = Object.values(nextParticipants)
      .filter((participant) => participant.status === "pending")
      .map((participant) => {
        const nextParticipant = {
          ...participant,
          status: "admitted" as const,
          decidedAt: nowIso,
          decidedBy: params.access.user.uid,
          updatedAt: nowIso,
        };
        nextParticipants[participant.uid] = nextParticipant;
        return toWaitingRoomParticipantSummary(nextParticipant);
      });

    const nextSession = {
      ...session,
      waitingRoom: {
        ...session.waitingRoom,
        participants: nextParticipants,
      },
    };
    tx.set(params.access.classContext.classRef, { liveSession: nextSession }, { merge: true });
  });

  return [...documentParticipants, ...updatedParticipants];
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
      const waitingParticipants = await listPendingWaitingRoomParticipants(access);
      return NextResponse.json(
        {
          success: true,
          data: {
            classId: access.classContext.classId,
            roomName,
            participants,
            waitingParticipants,
          },
        },
        { status: 200 },
      );
    } catch (error) {
      if (!isLiveKitNotFoundError(error)) {
        throw error;
      }
      const waitingParticipants = await listPendingWaitingRoomParticipants(access);
      return NextResponse.json(
        {
          success: true,
          data: {
            classId: access.classContext.classId,
            roomName,
            participants: [],
            waitingParticipants,
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

    if (action === "admit_waiting_student" || action === "reject_waiting_student") {
      const waitingParticipantId =
        asTrimmedString(body.waitingParticipantId) || asTrimmedString(body.participantIdentity);
      if (!waitingParticipantId) {
        return NextResponse.json(
          { success: false, error: "waitingParticipantId es requerido" },
          { status: 400 },
        );
      }

      const waitingParticipant = await updateWaitingRoomParticipant({
        access,
        waitingParticipantId,
        nextStatus: action === "admit_waiting_student" ? "admitted" : "rejected",
      });
      return NextResponse.json(
        {
          success: true,
          data: {
            action,
            classId: access.classContext.classId,
            roomName,
            waitingParticipant,
          },
        },
        { status: 200 },
      );
    }

    if (action === "admit_all_waiting") {
      const waitingParticipants = await admitAllWaitingRoomParticipants({ access });
      return NextResponse.json(
        {
          success: true,
          data: {
            action,
            classId: access.classContext.classId,
            roomName,
            waitingParticipants,
          },
        },
        { status: 200 },
      );
    }

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

    if (action === "unmute_participant") {
      const participantIdentity = asTrimmedString(body.participantIdentity);
      if (!participantIdentity) {
        return NextResponse.json(
          { success: false, error: "participantIdentity es requerido" },
          { status: 400 },
        );
      }

      try {
        const result = await unmuteLiveKitParticipantMicrophones({
          roomName,
          participantIdentity,
        });
        return NextResponse.json(
          {
            success: true,
            data: {
              action: "unmute_participant",
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
      {
        success: false,
        error:
          "Acción inválida. Usa mute_participant, unmute_participant, mute_all, admit_waiting_student, reject_waiting_student o admit_all_waiting.",
      },
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
