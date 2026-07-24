import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  resolveAuthorizedLiveClassAccess,
  toLiveAccessErrorResponse,
} from "@/lib/live-classes/access";
import {
  finalizeLiveAttendanceForClass,
  loadLiveAttendanceRecords,
} from "@/lib/live-classes/attendance";
import { normalizeLiveSession } from "@/lib/live-classes/types";
import { isStudentStatusActive } from "@/lib/students/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AttendanceReportRow = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  attended: boolean;
  attendanceSeconds: number;
  attendancePercentage: number;
  joinCount: number;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function toMillis(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

function minIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function maxIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function resolveClassDurationSeconds(params: {
  lastStartedAt?: string | null;
  lastEndedAt?: string | null;
  recordingDurationSec?: number | null;
}): number | null {
  const startedMs = toMillis(params.lastStartedAt);
  const endedMs = toMillis(params.lastEndedAt);
  if (startedMs !== null && endedMs !== null && endedMs > startedMs) {
    return Math.round((endedMs - startedMs) / 1000);
  }
  return asPositiveNumber(params.recordingDurationSec);
}

async function loadLinkedGroupStudents(groupId: string): Promise<AttendanceReportRow[]> {
  if (!groupId) return [];
  const studentsSnap = await getAdminFirestore()
    .collection("groups")
    .doc(groupId)
    .collection("students")
    .get();

  return studentsSnap.docs
    .map((docSnap): AttendanceReportRow | null => {
      const data = (docSnap.data() ?? {}) as Record<string, unknown>;
      const status = asTrimmedString(data.status) || "active";
      if (!isStudentStatusActive(status)) return null;
      return {
        studentId: asTrimmedString(data.studentId) || docSnap.id,
        studentName: asTrimmedString(data.studentName) || "Sin nombre",
        studentEmail: asTrimmedString(data.studentEmail),
        attended: false,
        attendanceSeconds: 0,
        attendancePercentage: 0,
        joinCount: 0,
        firstJoinedAt: null,
        lastLeftAt: null,
      };
    })
    .filter((row): row is AttendanceReportRow => row !== null);
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

    const liveSession = normalizeLiveSession(access.classContext.classData.liveSession);
    const isEnded =
      Boolean(liveSession?.lastEndedAt) ||
      liveSession?.status === "ended" ||
      liveSession?.status === "recording_ready";
    if (!liveSession || !isEnded) {
      return NextResponse.json(
        { success: false, error: "El reporte estará disponible cuando termine la sesión." },
        { status: 409 },
      );
    }

    if (liveSession.lastEndedAt) {
      await finalizeLiveAttendanceForClass(access.classContext.classRef, liveSession.lastEndedAt);
    }

    const classDurationSeconds = resolveClassDurationSeconds({
      lastStartedAt: liveSession.lastStartedAt,
      lastEndedAt: liveSession.lastEndedAt,
      recordingDurationSec: liveSession.recording.durationSec,
    });
    if (!classDurationSeconds) {
      return NextResponse.json(
        { success: false, error: "La clase no tiene duración suficiente para calcular asistencia." },
        { status: 409 },
      );
    }

    const linkedGroupId = asTrimmedString(access.classContext.classData.linkedGroupId);
    const rosterRows = await loadLinkedGroupStudents(linkedGroupId);
    const rowsByStudentId = new Map<string, AttendanceReportRow>();
    rosterRows.forEach((row) => rowsByStudentId.set(row.studentId, row));

    const attendanceRecords = await loadLiveAttendanceRecords(access.classContext.classRef);
    attendanceRecords.forEach((record) => {
      const studentId = record.studentId || record.participantIdentity;
      if (!studentId) return;
      const current =
        rowsByStudentId.get(studentId) ??
        {
          studentId,
          studentName: record.studentName || "Sin nombre",
          studentEmail: "",
          attended: false,
          attendanceSeconds: 0,
          attendancePercentage: 0,
          joinCount: 0,
          firstJoinedAt: null,
          lastLeftAt: null,
        };

      const attendanceSeconds = current.attendanceSeconds + Math.max(0, Math.round(record.totalSeconds));
      rowsByStudentId.set(studentId, {
        ...current,
        studentName:
          current.studentName && current.studentName !== "Sin nombre"
            ? current.studentName
            : record.studentName || current.studentName,
        attended: attendanceSeconds > 0 || record.joinCount > 0,
        attendanceSeconds,
        attendancePercentage: Math.min(100, (attendanceSeconds / classDurationSeconds) * 100),
        joinCount: current.joinCount + record.joinCount,
        firstJoinedAt: minIso(current.firstJoinedAt, record.firstJoinedAt),
        lastLeftAt: maxIso(current.lastLeftAt, record.lastLeftAt),
      });
    });

    const rows = Array.from(rowsByStudentId.values()).sort((left, right) => {
      if (left.attended !== right.attended) return Number(right.attended) - Number(left.attended);
      return left.studentName.localeCompare(right.studentName, "es-MX", { sensitivity: "base" });
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          classId: access.classContext.classId,
          courseId: access.classContext.courseId,
          lessonId: access.classContext.lessonId,
          title: asTrimmedString(access.classContext.classData.title) || "Clase en vivo",
          linkedGroupId: linkedGroupId || null,
          linkedGroupName: asTrimmedString(access.classContext.classData.linkedGroupName) || null,
          roomName: liveSession.roomName,
          startedAt: liveSession.lastStartedAt,
          endedAt: liveSession.lastEndedAt,
          classDurationSeconds,
          generatedAt: new Date().toISOString(),
          rows,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const handled = toLiveAccessErrorResponse(error);
    if (handled.status === 500) {
      console.error("Error generando reporte de asistencia en vivo", error);
    }
    return NextResponse.json(
      { success: false, error: handled.message },
      { status: handled.status },
    );
  }
}
