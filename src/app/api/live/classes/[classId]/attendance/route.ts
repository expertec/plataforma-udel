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

type AttendanceGroupContext = {
  groupId: string;
  groupName: string;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => asTrimmedString(item))
        .filter((item) => item.length > 0),
    ),
  );
}

function getGroupCourseIds(groupData: Record<string, unknown>): string[] {
  const explicitIds = asUniqueStringArray(groupData.courseIds);
  if (explicitIds.length > 0) return explicitIds;

  if (Array.isArray(groupData.courses)) {
    const ids = groupData.courses
      .map((course) => {
        if (!course || typeof course !== "object" || Array.isArray(course)) return "";
        return asTrimmedString((course as Record<string, unknown>).courseId);
      })
      .filter((courseId) => courseId.length > 0);
    if (ids.length > 0) return Array.from(new Set(ids));
  }

  const legacyCourseId = asTrimmedString(groupData.courseId);
  return legacyCourseId ? [legacyCourseId] : [];
}

function getMentorAllowedCourseIds(
  groupData: Record<string, unknown>,
  mentorId: string,
): string[] {
  const groupCourseIds = getGroupCourseIds(groupData);
  const mentorAccess = groupData.mentorCourseAccess;
  if (!mentorAccess || typeof mentorAccess !== "object" || Array.isArray(mentorAccess)) {
    return [];
  }
  if (!Object.prototype.hasOwnProperty.call(mentorAccess, mentorId)) {
    return [];
  }
  const rawAllowed = (mentorAccess as Record<string, unknown>)[mentorId];
  const validCourseIds = new Set(groupCourseIds);
  return asUniqueStringArray(rawAllowed).filter((courseId) => validCourseIds.has(courseId));
}

function isCoordinatorRole(role: string | null | undefined): boolean {
  return role === "coordinadorPlantel" || role === "director";
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

async function loadGroupContext(groupId: string): Promise<AttendanceGroupContext | null> {
  const groupSnap = await getAdminFirestore().collection("groups").doc(groupId).get();
  if (!groupSnap.exists) return null;
  const groupData = (groupSnap.data() ?? {}) as Record<string, unknown>;
  return {
    groupId: groupSnap.id,
    groupName: asTrimmedString(groupData.groupName) || "Grupo",
  };
}

async function resolveAttendanceGroups(params: {
  linkedGroupId: string;
  courseId: string;
  user: {
    uid: string;
    role: string | null;
    plantelIds: string[];
  };
}): Promise<AttendanceGroupContext[]> {
  const db = getAdminFirestore();
  if (params.linkedGroupId) {
    const linkedGroup = await loadGroupContext(params.linkedGroupId);
    return linkedGroup ? [linkedGroup] : [];
  }

  const groupsById = new Map<string, AttendanceGroupContext>();
  const addIfCourseMatches = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => {
    docs.forEach((groupDoc) => {
      if (groupsById.has(groupDoc.id)) return;
      const groupData = (groupDoc.data() ?? {}) as Record<string, unknown>;
      if (!getGroupCourseIds(groupData).includes(params.courseId)) return;
      groupsById.set(groupDoc.id, {
        groupId: groupDoc.id,
        groupName: asTrimmedString(groupData.groupName) || "Grupo",
      });
    });
  };

  if (isCoordinatorRole(params.user.role)) {
    const plantelIds = asUniqueStringArray(params.user.plantelIds);
    const [plantelGroupSnaps, assignedOnlineGroupsSnap] = await Promise.all([
      Promise.all(
        plantelIds.map((plantelId) =>
          db.collection("groups").where("plantelId", "==", plantelId).get(),
        ),
      ),
      db
        .collection("groups")
        .where("isInPerson", "==", false)
        .where("coordinatorId", "==", params.user.uid)
        .get(),
    ]);
    plantelGroupSnaps.forEach((snap) => addIfCourseMatches(snap.docs));
    addIfCourseMatches(assignedOnlineGroupsSnap.docs);
    return Array.from(groupsById.values());
  }

  const [principalGroupsSnap, assistantGroupsSnap] = await Promise.all([
    db.collection("groups").where("teacherId", "==", params.user.uid).get(),
    db.collection("groups").where("assistantTeacherIds", "array-contains", params.user.uid).get(),
  ]);
  addIfCourseMatches(principalGroupsSnap.docs);
  assistantGroupsSnap.docs.forEach((groupDoc) => {
    if (groupsById.has(groupDoc.id)) return;
    const groupData = (groupDoc.data() ?? {}) as Record<string, unknown>;
    if (!getMentorAllowedCourseIds(groupData, params.user.uid).includes(params.courseId)) return;
    groupsById.set(groupDoc.id, {
      groupId: groupDoc.id,
      groupName: asTrimmedString(groupData.groupName) || "Grupo",
    });
  });
  return Array.from(groupsById.values());
}

async function loadRosterRowsForGroups(groups: AttendanceGroupContext[]): Promise<AttendanceReportRow[]> {
  const rowsByStudentId = new Map<string, AttendanceReportRow>();
  const groupRows = await Promise.all(groups.map((group) => loadLinkedGroupStudents(group.groupId)));
  groupRows.flat().forEach((row) => {
    if (rowsByStudentId.has(row.studentId)) return;
    rowsByStudentId.set(row.studentId, row);
  });
  return Array.from(rowsByStudentId.values());
}

function formatGroupLabel(groups: AttendanceGroupContext[]): string | null {
  if (groups.length === 0) return null;
  const names = Array.from(new Set(groups.map((group) => group.groupName).filter(Boolean)));
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `Múltiples grupos: ${names.join(", ")}`;
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
      allowCoordinatorAccess: true,
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
    const attendanceGroups = await resolveAttendanceGroups({
      linkedGroupId,
      courseId: access.classContext.courseId,
      user: {
        uid: access.user.uid,
        role: access.user.role,
        plantelIds: access.user.plantelIds,
      },
    });
    const rosterRows = await loadRosterRowsForGroups(attendanceGroups);
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
          linkedGroupName:
            asTrimmedString(access.classContext.classData.linkedGroupName) ||
            formatGroupLabel(attendanceGroups),
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
