import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  requireTeacherAccess,
  type TeacherAccessContext,
  toTeacherAccessErrorResponse,
} from "@/lib/server/require-teacher-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type QuickSummaryBody = {
  groupIds?: unknown;
};

type CourseSummary = {
  courseId: string;
  courseName: string;
  closedCount: number;
  totalCount: number;
  lastClosedAt: string | null;
  lastClosedByName: string | null;
};

type GroupSummary = {
  groupId: string;
  courses: CourseSummary[];
};

class QuickSummaryAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => asTrimmedString(item))
        .filter(Boolean),
    ),
  );
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as { toDate?: () => Date; toMillis?: () => number };
    if (typeof candidate.toDate === "function") {
      const date = candidate.toDate();
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof candidate.toMillis === "function") {
      const date = new Date(candidate.toMillis());
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }
  return null;
}

function getGroupCourseList(data: Record<string, unknown>): Array<{ courseId: string; courseName: string }> {
  if (Array.isArray(data.courses) && data.courses.length > 0) {
    return data.courses
      .map((course) => {
        if (!course || typeof course !== "object" || Array.isArray(course)) return null;
        const courseData = course as Record<string, unknown>;
        const courseId = asTrimmedString(courseData.courseId);
        if (!courseId) return null;
        return {
          courseId,
          courseName: asTrimmedString(courseData.courseName) || "Materia",
        };
      })
      .filter((course): course is { courseId: string; courseName: string } => course !== null);
  }

  const legacyCourseId = asTrimmedString(data.courseId);
  if (!legacyCourseId) return [];
  return [
    {
      courseId: legacyCourseId,
      courseName: asTrimmedString(data.courseName) || "Materia",
    },
  ];
}

function getUserPlantelIds(data: Record<string, unknown>): string[] {
  const explicit = asUniqueStringArray(data.plantelIds);
  if (explicit.length > 0) return explicit;
  const legacy = asTrimmedString(data.plantelId);
  return legacy ? [legacy] : [];
}

async function resolveRequesterPlantelIds(uid: string): Promise<string[]> {
  const userSnap = await getAdminFirestore().collection("users").doc(uid).get();
  return getUserPlantelIds((userSnap.data() ?? {}) as Record<string, unknown>);
}

function canReadGroup(params: {
  teacher: TeacherAccessContext;
  groupData: Record<string, unknown>;
  requesterPlantelIds: string[];
}): boolean {
  const { teacher, groupData, requesterPlantelIds } = params;
  if (teacher.role === "adminTeacher" || teacher.role === "superAdminTeacher") return true;

  const teacherId = asTrimmedString(groupData.teacherId);
  if (teacherId === teacher.uid) return true;

  const assistantTeacherIds = asUniqueStringArray(groupData.assistantTeacherIds);
  if (assistantTeacherIds.includes(teacher.uid)) return true;

  if (teacher.role === "coordinadorPlantel" || teacher.role === "director") {
    const plantelId = asTrimmedString(groupData.plantelId);
    if (plantelId && requesterPlantelIds.includes(plantelId)) return true;
    const isOnlineGroup = groupData.isInPerson !== true;
    const coordinatorId = asTrimmedString(groupData.coordinatorId);
    if (isOnlineGroup && coordinatorId === teacher.uid) return true;
  }

  return false;
}

async function buildGroupSummary(
  groupId: string,
  courses: Array<{ courseId: string; courseName: string }>,
): Promise<GroupSummary> {
  const courseMap = new Map<string, CourseSummary>();
  courses.forEach((course) => {
    courseMap.set(course.courseId, {
      courseId: course.courseId,
      courseName: course.courseName,
      closedCount: 0,
      totalCount: 0,
      lastClosedAt: null,
      lastClosedByName: null,
    });
  });

  const enrollmentsSnap = await getAdminFirestore()
    .collection("studentEnrollments")
    .where("groupId", "==", groupId)
    .get();

  enrollmentsSnap.docs.forEach((enrollmentDoc) => {
    const enrollmentData = (enrollmentDoc.data() ?? {}) as Record<string, unknown>;
    const closures =
      enrollmentData.courseClosures &&
      typeof enrollmentData.courseClosures === "object" &&
      !Array.isArray(enrollmentData.courseClosures)
        ? (enrollmentData.courseClosures as Record<string, unknown>)
        : {};

    courses.forEach((course) => {
      const current = courseMap.get(course.courseId);
      if (!current) return;
      current.totalCount += 1;

      const rawClosure = closures[course.courseId];
      if (!rawClosure || typeof rawClosure !== "object" || Array.isArray(rawClosure)) return;
      const closure = rawClosure as Record<string, unknown>;
      if (closure.status !== "closed") return;

      current.closedCount += 1;
      const closedAt = toIsoString(closure.closedAt);
      if (
        closedAt &&
        (!current.lastClosedAt || Date.parse(closedAt) > Date.parse(current.lastClosedAt))
      ) {
        current.lastClosedAt = closedAt;
        current.lastClosedByName = asTrimmedString(closure.closedByName) || null;
      }
    });
  });

  return {
    groupId,
    courses: Array.from(courseMap.values()),
  };
}

function toErrorResponse(error: unknown) {
  if (error instanceof QuickSummaryAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  return toTeacherAccessErrorResponse(error, "Error cargando resumen rapido de grupos");
}

export async function POST(request: NextRequest) {
  try {
    const teacher = await requireTeacherAccess(request);
    const body = (await request.json()) as QuickSummaryBody;
    const groupIds = asUniqueStringArray(body.groupIds).slice(0, 60);
    if (groupIds.length === 0) {
      return NextResponse.json({ success: true, data: { summaries: [] } }, { status: 200 });
    }

    const requesterPlantelIds =
      teacher.role === "coordinadorPlantel" || teacher.role === "director"
        ? await resolveRequesterPlantelIds(teacher.uid)
        : [];

    const groupSnaps = await Promise.all(
      groupIds.map((groupId) => getAdminFirestore().collection("groups").doc(groupId).get()),
    );

    const summaries: GroupSummary[] = [];
    for (const groupSnap of groupSnaps) {
      if (!groupSnap.exists) continue;
      const groupData = (groupSnap.data() ?? {}) as Record<string, unknown>;
      if (!canReadGroup({ teacher, groupData, requesterPlantelIds })) {
        throw new QuickSummaryAccessError(403, "Missing or insufficient permissions.");
      }
      summaries.push(await buildGroupSummary(groupSnap.id, getGroupCourseList(groupData)));
    }

    return NextResponse.json(
      {
        success: true,
        data: { summaries },
      },
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
