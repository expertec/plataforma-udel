import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AllowedRole = "teacher" | "coordinadorPlantel" | "director" | "adminTeacher" | "superAdminTeacher";

type RouteContext = {
  uid: string;
  role: AllowedRole | null;
  rawRole: unknown;
  plantelIds: string[];
};

type CourseClosure = {
  status?: "open" | "closed";
  finalGrade?: number;
  autoGrade?: number | null;
  globalExamGrade?: number | null;
  globalExamScore?: number | null;
  extraordinaryExamGrade?: number | null;
  extraordinaryExamScore?: number | null;
  gradeSource?: string;
  pendingUngradedCount?: number;
  courseName?: unknown;
  closedAt?: unknown;
  updatedAt?: unknown;
};

type GradeRow = {
  id: string;
  groupId: string;
  courseId: string;
  groupName: string;
  courseName: string;
  status: "open" | "closed";
  finalGrade: number | null;
  autoGrade: number | null;
  globalExamGrade: number | null;
  globalExamSource: "closure" | "regularization" | null;
  extraordinaryExamGrade: number | null;
  extraordinaryExamSource: "closure" | "regularization" | null;
  pendingUngradedCount: number | null;
  closedAt: string | null;
  updatedAt: string | null;
};

class RouteAccessError extends Error {
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
    new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)),
  );
}

function asAllowedRole(value: unknown): AllowedRole | null {
  return value === "coordinadorPlantel" ||
    value === "director" ||
    value === "teacher" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher"
    ? value
    : null;
}

function isLegacyAdminTeacherRole(value: unknown): boolean {
  return (
    value === "adminteacher" ||
    value === "superadminteacher" ||
    value === "admin_teacher" ||
    value === "super_admin_teacher"
  );
}

function getUserPlantelIds(data: Record<string, unknown>): string[] {
  const plantelIds = asUniqueStringArray(data.plantelIds);
  if (plantelIds.length > 0) return plantelIds;
  const legacyPlantelId = asTrimmedString(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  return trimmed.slice(7).trim() || null;
}

function toIsoStringOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "object" && value !== null) {
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        return (value as { toDate: () => Date }).toDate().toISOString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getRowTs(row: GradeRow): number {
  return Math.max(
    row.closedAt ? new Date(row.closedAt).getTime() : 0,
    row.updatedAt ? new Date(row.updatedAt).getTime() : 0,
  );
}

function buildRowKey(groupId: string, groupName: string, courseId: string, courseName: string): string {
  const g = groupId.trim() || groupName.trim() || "sin-grupo";
  const c = courseId.trim() || courseName.trim() || "sin-materia";
  return `${g}::${c}`;
}

function buildGroupCourseKey(groupId: string, courseId: string): string {
  return `${groupId.trim()}::${courseId.trim()}`;
}

function getCourseNameFromGroupData(groupData: {
  courseId?: unknown;
  courseName?: unknown;
  courses?: unknown;
}): Map<string, string> {
  const courseNameById = new Map<string, string>();
  if (Array.isArray(groupData.courses)) {
    groupData.courses.forEach((course) => {
      if (!course || typeof course !== "object") return;
      const courseId = asTrimmedString((course as { courseId?: unknown }).courseId);
      const courseName = asTrimmedString((course as { courseName?: unknown }).courseName);
      if (courseId && courseName) courseNameById.set(courseId, courseName);
    });
  }
  const legacyCourseId = asTrimmedString(groupData.courseId);
  const legacyCourseName = asTrimmedString(groupData.courseName);
  if (legacyCourseId && legacyCourseName && !courseNameById.has(legacyCourseId)) {
    courseNameById.set(legacyCourseId, legacyCourseName);
  }
  return courseNameById;
}

async function resolveRouteContext(request: NextRequest): Promise<RouteContext> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) throw new RouteAccessError(401, "Authorization Bearer token requerido");

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new RouteAccessError(401, "Token inválido o expirado");
  }

  const userSnap = await getAdminFirestore().collection("users").doc(decodedToken.uid).get();
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const rawRole = userData.role ?? decodedToken.role;
  const role = asAllowedRole(rawRole);
  if (!role && !isLegacyAdminTeacherRole(rawRole)) {
    const teacherGroupIds = await getTeacherScopeGroupIds(decodedToken.uid);
    if (teacherGroupIds.size === 0) {
      throw new RouteAccessError(403, "Missing or insufficient permissions.");
    }
  }

  return {
    uid: decodedToken.uid,
    role,
    rawRole,
    plantelIds: getUserPlantelIds(userData),
  };
}

async function getCoordinatorScopeGroupIds(uid: string, plantelIds: string[]): Promise<Set<string>> {
  const db = getAdminFirestore();
  const [plantelGroupSnaps, assignedGroupSnap] = await Promise.all([
    Promise.all(plantelIds.map((plantelId) => db.collection("groups").where("plantelId", "==", plantelId).get())),
    db.collection("groups").where("coordinatorId", "==", uid).get(),
  ]);

  const groupIds = new Set<string>();
  plantelGroupSnaps.forEach((snap) => snap.docs.forEach((docSnap) => groupIds.add(docSnap.id)));
  assignedGroupSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    if (data.isInPerson === true) return;
    groupIds.add(docSnap.id);
  });
  return groupIds;
}

async function getTeacherScopeGroupIds(uid: string): Promise<Set<string>> {
  const db = getAdminFirestore();
  const [principalSnap, assistantSnap] = await Promise.all([
    db.collection("groups").where("teacherId", "==", uid).get(),
    db.collection("groups").where("assistantTeacherIds", "array-contains", uid).get(),
  ]);

  const groupIds = new Set<string>();
  principalSnap.docs.forEach((docSnap) => groupIds.add(docSnap.id));
  assistantSnap.docs.forEach((docSnap) => groupIds.add(docSnap.id));
  return groupIds;
}

async function assertCanReadStudentGrades(context: RouteContext, studentId: string): Promise<Set<string> | null> {
  if (
    context.role === "adminTeacher" ||
    context.role === "superAdminTeacher" ||
    isLegacyAdminTeacherRole(context.rawRole)
  ) {
    return null;
  }

  if (context.role === "teacher" || !context.role) {
    const teacherGroupIds = await getTeacherScopeGroupIds(context.uid);
    if (teacherGroupIds.size === 0) {
      throw new RouteAccessError(403, "No tienes grupos asignados");
    }

    const db = getAdminFirestore();
    const enrollmentChecks = await Promise.allSettled(
      Array.from(teacherGroupIds).map((groupId) =>
        db.collection("studentEnrollments").doc(`${groupId}_${studentId}`).get(),
      ),
    );
    const hasStudentInTeacherScope = enrollmentChecks.some(
      (result) => result.status === "fulfilled" && result.value.exists,
    );
    if (!hasStudentInTeacherScope) {
      throw new RouteAccessError(403, "Alumno fuera del alcance del profesor");
    }
    return teacherGroupIds;
  }

  if (context.plantelIds.length === 0) throw new RouteAccessError(403, "Sin plantel asignado");

  const db = getAdminFirestore();
  const studentSnap = await db.collection("users").doc(studentId).get();
  const studentPlantelIds = getUserPlantelIds((studentSnap.data() ?? {}) as Record<string, unknown>);
  const hasStudentPlantelScope = studentPlantelIds.some((plantelId) => context.plantelIds.includes(plantelId));
  if (!hasStudentPlantelScope) throw new RouteAccessError(403, "Alumno fuera del alcance del plantel");

  return getCoordinatorScopeGroupIds(context.uid, context.plantelIds);
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  console.error("Error cargando kardex por API:", error);
  const message = error instanceof Error ? error.message : "Error interno del servidor";
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ studentId: string }> },
) {
  try {
    const { studentId } = await params;
    const normalizedStudentId = asTrimmedString(studentId);
    if (!normalizedStudentId) throw new RouteAccessError(400, "studentId requerido");

    const context = await resolveRouteContext(request);
    const allowedGroupIds = await assertCanReadStudentGrades(context, normalizedStudentId);
    const db = getAdminFirestore();

    const [enrollmentsSnap, archiveSnap] = await Promise.all([
      db.collection("studentEnrollments").where("studentId", "==", normalizedStudentId).get(),
      db.collection("studentEnrollmentsArchive").where("studentId", "==", normalizedStudentId).get(),
    ]);

    const groupIds = new Set<string>();
    const enrollmentGroupNames = new Map<string, string>();
    const enrollmentCourseFallbackByGroup = new Map<string, string>();
    const enrollmentSources: Array<{
      groupId: string;
      groupName: string;
      fallbackCourseName: string;
      closures: Record<string, unknown>;
    }> = [];

    [...enrollmentsSnap.docs, ...archiveSnap.docs].forEach((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      const groupId = asTrimmedString(data.groupId);
      if (allowedGroupIds && (!groupId || !allowedGroupIds.has(groupId))) return;
      const groupName = asTrimmedString(data.groupName) || "Sin grupo";
      const fallbackCourseName = asTrimmedString(data.courseName);
      if (groupId) {
        groupIds.add(groupId);
        if (!enrollmentGroupNames.has(groupId)) enrollmentGroupNames.set(groupId, groupName);
        if (fallbackCourseName && !enrollmentCourseFallbackByGroup.has(groupId)) {
          enrollmentCourseFallbackByGroup.set(groupId, fallbackCourseName);
        }
      }
      enrollmentSources.push({
        groupId,
        groupName,
        fallbackCourseName,
        closures: (data.courseClosures ?? {}) as Record<string, unknown>,
      });
    });

    const groupCourseNameByKey = new Map<string, string>();
    const groupDocs = await Promise.allSettled(
      Array.from(groupIds).map((groupId) => db.collection("groups").doc(groupId).get()),
    );
    groupDocs.forEach((result, index) => {
      if (result.status !== "fulfilled" || !result.value.exists) return;
      const groupId = Array.from(groupIds)[index];
      const data = result.value.data() as { groupName?: unknown; courseName?: unknown; courseId?: unknown; courses?: unknown };
      const groupName = asTrimmedString(data.groupName);
      const fallbackCourseName = asTrimmedString(data.courseName);
      if (groupName) enrollmentGroupNames.set(groupId, groupName);
      if (fallbackCourseName) enrollmentCourseFallbackByGroup.set(groupId, fallbackCourseName);
      getCourseNameFromGroupData(data).forEach((courseName, courseId) => {
        groupCourseNameByKey.set(buildGroupCourseKey(groupId, courseId), courseName);
      });
    });

    const resolveCourseName = (groupId: string, courseId: string, ...candidates: string[]): string => {
      const groupCourseName = groupCourseNameByKey.get(buildGroupCourseKey(groupId, courseId)) ?? "";
      for (const candidate of [groupCourseName, ...candidates]) {
        if (candidate.trim()) return candidate.trim();
      }
      return courseId.trim() || "Sin materia";
    };

    const rows = new Map<string, GradeRow>();

    enrollmentSources.forEach(({ groupId, groupName, fallbackCourseName, closures }) => {
      Object.entries(closures).forEach(([courseIdRaw, closureRaw]) => {
        const closure = closureRaw as CourseClosure;
        if (!closure || typeof closure !== "object") return;
        const courseId = courseIdRaw.trim();
        const resolvedGroupName = enrollmentGroupNames.get(groupId) ?? groupName;
        const courseName = resolveCourseName(groupId, courseId, asTrimmedString(closure.courseName), fallbackCourseName);
        const globalExamGrade = toNumberOrNull(closure.globalExamGrade);
        const extraordinaryExamGrade = toNumberOrNull(closure.extraordinaryExamGrade);
        const row: GradeRow = {
          id: buildRowKey(groupId, resolvedGroupName, courseId, courseName),
          groupId,
          courseId,
          groupName: resolvedGroupName,
          courseName,
          status: closure.status === "closed" ? "closed" : "open",
          finalGrade: toNumberOrNull(closure.finalGrade),
          autoGrade: toNumberOrNull(closure.autoGrade),
          globalExamGrade:
            globalExamGrade ??
            (closure.gradeSource === "globalRegularizationExam"
              ? toNumberOrNull(closure.globalExamScore) ?? toNumberOrNull(closure.finalGrade)
              : null),
          globalExamSource:
            globalExamGrade !== null
              ? "closure"
              : closure.gradeSource === "globalRegularizationExam"
                ? "regularization"
                : null,
          extraordinaryExamGrade:
            extraordinaryExamGrade ??
            (closure.gradeSource === "extraordinaryRegularizationExam"
              ? toNumberOrNull(closure.extraordinaryExamScore) ?? toNumberOrNull(closure.finalGrade)
              : null),
          extraordinaryExamSource:
            extraordinaryExamGrade !== null
              ? "closure"
              : closure.gradeSource === "extraordinaryRegularizationExam"
                ? "regularization"
                : null,
          pendingUngradedCount:
            typeof closure.pendingUngradedCount === "number" ? closure.pendingUngradedCount : null,
          closedAt: toIsoStringOrNull(closure.closedAt),
          updatedAt: toIsoStringOrNull(closure.updatedAt),
        };
        const previous = rows.get(row.id);
        if (!previous || getRowTs(row) >= getRowTs(previous)) rows.set(row.id, row);
      });
    });

    const submissionResults = await Promise.allSettled(
      Array.from(groupIds).map(async (groupId) => {
        const snap = await db
          .collection("groups")
          .doc(groupId)
          .collection("submissions")
          .where("studentId", "==", normalizedStudentId)
          .get();
        return { groupId, docs: snap.docs };
      }),
    );

    const submissionAgg = new Map<
      string,
      { row: GradeRow; total: number; graded: number; numericCount: number; numericSum: number }
    >();
    submissionResults.forEach((result) => {
      if (result.status !== "fulfilled") return;
      const groupName = enrollmentGroupNames.get(result.value.groupId) ?? "Sin grupo";
      const fallbackCourseName = enrollmentCourseFallbackByGroup.get(result.value.groupId) ?? "Sin materia";
      result.value.docs.forEach((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        const courseId = asTrimmedString(data.courseId);
        const courseName = resolveCourseName(result.value.groupId, courseId, asTrimmedString(data.courseTitle), fallbackCourseName);
        const key = buildRowKey(result.value.groupId, groupName, courseId, courseName);
        const current =
          submissionAgg.get(key) ??
          {
            row: {
              id: key,
              groupId: result.value.groupId,
              courseId,
              groupName,
              courseName,
              status: "open",
              finalGrade: null,
              autoGrade: null,
              globalExamGrade: null,
              globalExamSource: null,
              extraordinaryExamGrade: null,
              extraordinaryExamSource: null,
              pendingUngradedCount: null,
              closedAt: null,
              updatedAt: null,
            },
            total: 0,
            graded: 0,
            numericCount: 0,
            numericSum: 0,
          };
        current.total += 1;
        const grade = toNumberOrNull(data.grade);
        if (data.status === "graded" || grade !== null) current.graded += 1;
        if (grade !== null) {
          current.numericCount += 1;
          current.numericSum += grade;
        }
        current.row.updatedAt = toIsoStringOrNull(data.gradedAt) ?? toIsoStringOrNull(data.submittedAt) ?? current.row.updatedAt;
        submissionAgg.set(key, current);
      });
    });

    submissionAgg.forEach((agg, key) => {
      const previous = rows.get(key);
      const submissionRow = {
        ...agg.row,
        autoGrade: agg.numericCount > 0 ? agg.numericSum / agg.numericCount : null,
        pendingUngradedCount: Math.max(agg.total - agg.graded, 0),
      };
      rows.set(key, previous ? { ...submissionRow, ...previous } : submissionRow);
    });

    return NextResponse.json({
      success: true,
      data: {
        rows: Array.from(rows.values()).sort((a, b) => getRowTs(b) - getRowTs(a)),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
