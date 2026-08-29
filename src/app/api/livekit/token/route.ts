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
  type LiveClassSession,
} from "@/lib/live-classes/types";
import {
  createJoinToken,
  ensureLiveKitRoom,
  getLiveKitConfig,
} from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TokenRequestBody = {
  classId?: unknown;
  courseId?: unknown;
  lessonId?: unknown;
  admissionRetry?: unknown;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function isLiveSessionFinalized(session: LiveClassSession): boolean {
  return (
    Boolean(session.lastEndedAt) ||
    session.status === "ended" ||
    session.status === "recording_ready"
  );
}

function isLiveSessionJoinable(session: LiveClassSession): boolean {
  return session.status === "live" || session.teacherActive;
}

async function resolveStudentWaitingRoomGate(params: {
  access: Awaited<ReturnType<typeof resolveAuthorizedLiveClassAccess>>;
  fallbackSession: LiveClassSession;
  retryRejectedRequest: boolean;
}): Promise<{
  session: LiveClassSession;
  joinAllowed: boolean;
  waitingReason: "waiting_teacher" | "waiting_approval" | "admission_rejected" | "session_ended" | null;
}> {
  const { access, fallbackSession, retryRejectedRequest } = params;
  const db = getAdminFirestore();
  const nowIso = new Date().toISOString();
  let result: {
    session: LiveClassSession;
    joinAllowed: boolean;
    waitingReason: "waiting_teacher" | "waiting_approval" | "admission_rejected" | "session_ended" | null;
  } = {
    session: fallbackSession,
    joinAllowed: false,
    waitingReason: "waiting_teacher",
  };

  await db.runTransaction(async (tx) => {
    const classSnap = await tx.get(access.classContext.classRef);
    if (!classSnap.exists) {
      throw new Error("Clase no encontrada");
    }
    const classData = (classSnap.data() ?? {}) as Record<string, unknown>;
    const latestSession =
      normalizeLiveSession(classData.liveSession) ??
      createLiveSessionForClass({
        courseId: access.classContext.courseId,
        lessonId: access.classContext.lessonId,
        classId: access.classContext.classId,
        input: fallbackSession,
      });

    if (isLiveSessionFinalized(latestSession)) {
      result = {
        session: latestSession,
        joinAllowed: false,
        waitingReason: "session_ended",
      };
      return;
    }

    if (!isLiveSessionJoinable(latestSession)) {
      result = {
        session: latestSession,
        joinAllowed: false,
        waitingReason: "waiting_teacher",
      };
      return;
    }

    if (!latestSession.waitingRoom.enabled) {
      result = {
        session: latestSession,
        joinAllowed: true,
        waitingReason: null,
      };
      return;
    }

    const currentRequest = latestSession.waitingRoom.participants[access.user.uid];
    if (currentRequest?.status === "admitted") {
      const nextSession = {
        ...latestSession,
        waitingRoom: {
          ...latestSession.waitingRoom,
          participants: {
            ...latestSession.waitingRoom.participants,
            [access.user.uid]: {
              ...currentRequest,
              displayName: access.user.displayName || currentRequest.displayName,
              email: access.user.email || currentRequest.email,
              updatedAt: nowIso,
            },
          },
        },
      };
      tx.set(access.classContext.classRef, { liveSession: nextSession }, { merge: true });
      result = {
        session: nextSession,
        joinAllowed: true,
        waitingReason: null,
      };
      return;
    }

    if (currentRequest?.status === "rejected" && !retryRejectedRequest) {
      result = {
        session: latestSession,
        joinAllowed: false,
        waitingReason: "admission_rejected",
      };
      return;
    }

    const nextSession = {
      ...latestSession,
      waitingRoom: {
        ...latestSession.waitingRoom,
        participants: {
          ...latestSession.waitingRoom.participants,
          [access.user.uid]: {
            uid: access.user.uid,
            displayName: access.user.displayName || currentRequest?.displayName || "Alumno",
            email: access.user.email || currentRequest?.email || "",
            status: "pending" as const,
            requestedAt: retryRejectedRequest ? nowIso : currentRequest?.requestedAt ?? nowIso,
            decidedAt: null,
            decidedBy: null,
            updatedAt: nowIso,
          },
        },
      },
    };
    tx.set(access.classContext.classRef, { liveSession: nextSession }, { merge: true });
    result = {
      session: nextSession,
      joinAllowed: false,
      waitingReason: "waiting_approval",
    };
  });

  return result;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as TokenRequestBody;
    const classId = asTrimmedString(body.classId);
    const courseId = asTrimmedString(body.courseId);
    const lessonId = asTrimmedString(body.lessonId);
    const admissionRetry = asBoolean(body.admissionRetry);
    if (!classId) {
      return NextResponse.json(
        { success: false, error: "classId es requerido" },
        { status: 400 },
      );
    }

    const access = await resolveAuthorizedLiveClassAccess({
      request,
      classId,
      courseId: courseId || undefined,
      lessonId: lessonId || undefined,
      requireTeacher: false,
      allowLiveLinkStudentFallback: true,
    });

    const currentSession = access.classContext.liveSession;
    const normalizedCurrentSession = normalizeLiveSession(currentSession);
    const fallbackSession = createLiveSessionForClass({
      courseId: access.classContext.courseId,
      lessonId: access.classContext.lessonId,
      classId: access.classContext.classId,
      input: currentSession,
    });

    const roomName =
      normalizedCurrentSession?.roomName ||
      buildLiveRoomName({
        courseId: access.classContext.courseId,
        lessonId: access.classContext.lessonId,
        classId: access.classContext.classId,
      });

    let session = {
      ...(normalizedCurrentSession ?? fallbackSession),
      roomName,
    };

    const isTeacher = access.accessRole === "teacher";
    const isSessionFinalized = isLiveSessionFinalized(session);
    const isSessionLive = isLiveSessionJoinable(session);
    let joinAllowed = !isSessionFinalized && (isTeacher || isSessionLive);
    let waitingReason:
      | "waiting_teacher"
      | "waiting_approval"
      | "admission_rejected"
      | "session_ended"
      | null = isSessionFinalized ? "session_ended" : "waiting_teacher";

    if (!isTeacher && !isSessionFinalized && isSessionLive) {
      const gate = await resolveStudentWaitingRoomGate({
        access,
        fallbackSession: session,
        retryRejectedRequest: admissionRetry,
      });
      session = gate.session;
      joinAllowed = gate.joinAllowed;
      waitingReason = gate.waitingReason;
    }

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
            waitingReason,
            asRole: access.accessRole,
            liveSession: session,
            roomMode: null,
          },
        },
        { status: 200 },
      );
    }

    if (isTeacher && !isSessionLive) {
      await ensureLiveKitRoom(session.roomName);
    }

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
          livekitUrl: getLiveKitConfig().clientUrl,
          roomName: session.roomName,
          classId: access.classContext.classId,
          classTitle:
            asTrimmedString(access.classContext.classData.title) || "Clase en vivo",
          joinAllowed: true,
          asRole: access.accessRole,
          liveSession: session,
          roomMode: isTeacher && !isSessionLive ? "preview" : "live",
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
