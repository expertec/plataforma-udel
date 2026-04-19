import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
} from "@/lib/live-classes/access";
import { mergeTeacherEditableLiveSession } from "@/lib/live-classes/types";
import { stopLiveKitEgress } from "@/lib/server/livekit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

    const db = getAdminFirestore();
    const classRef = access.classContext.classRef;
    const endedAtIso = new Date().toISOString();
    let egressId: string | null = null;
    let shouldStopEgress = false;

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

      egressId = session.recording.egressId;
      shouldStopEgress =
        Boolean(egressId) &&
        (session.recording.status === "recording" || session.recording.status === "processing");

      const recordingLikelyProcessing =
        session.recording.status === "recording" || session.recording.status === "processing";
      const nextSession = {
        ...session,
        teacherActive: false,
        lastEndedAt: endedAtIso,
        status: session.recording.status === "ready" ? ("recording_ready" as const) : ("ended" as const),
        recording: {
          ...session.recording,
          status: recordingLikelyProcessing ? ("processing" as const) : session.recording.status,
        },
      };

      tx.set(
        classRef,
        {
          liveSession: nextSession,
        },
        { merge: true },
      );
    });

    const warnings: string[] = [];
    let egressStopRequested = false;
    if (shouldStopEgress && egressId) {
      try {
        egressStopRequested = await stopLiveKitEgress(egressId);
      } catch (error) {
        console.error("No se pudo detener egress LiveKit", error);
        warnings.push("No se pudo detener la grabación en este momento.");
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          classId: access.classContext.classId,
          egressStopRequested,
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const handled = toLiveAccessErrorResponse(error);
    if (handled.status === 500) {
      console.error("Error terminando clase en vivo", error);
    }
    return NextResponse.json(
      { success: false, error: handled.message },
      { status: handled.status },
    );
  }
}
