import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AllowedRole = "teacher" | "coordinadorPlantel" | "director" | "adminTeacher" | "superAdminTeacher";

class RouteAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((item) => asTrimmedString(item)).filter(Boolean)),
  );
}

function asAllowedRole(value: unknown): AllowedRole | null {
  return value === "teacher" ||
    value === "coordinadorPlantel" ||
    value === "director" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher"
    ? value
    : null;
}

function getUserPlantelIds(data: Record<string, unknown>): string[] {
  const plantelIds = asUniqueStringArray(data.plantelIds);
  if (plantelIds.length > 0) return plantelIds;
  const legacyPlantelId = asTrimmedString(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function toGroupCourses(groupData: Record<string, unknown>): Array<{ courseId: string; courseName: string }> {
  if (Array.isArray(groupData.courses) && groupData.courses.length > 0) {
    return groupData.courses
      .map((course) => {
        if (!course || typeof course !== "object") return null;
        const item = course as Record<string, unknown>;
        const courseId = asTrimmedString(item.courseId);
        if (!courseId) return null;
        return {
          courseId,
          courseName: asTrimmedString(item.courseName),
        };
      })
      .filter((course): course is { courseId: string; courseName: string } => course !== null);
  }

  const legacyCourseId = asTrimmedString(groupData.courseId);
  return legacyCourseId
    ? [{ courseId: legacyCourseId, courseName: asTrimmedString(groupData.courseName) }]
    : [];
}

async function resolveAccessContext(request: NextRequest, groupId: string) {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) throw new RouteAccessError(401, "Authorization Bearer token requerido");

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new RouteAccessError(401, "Token inválido o expirado");
  }

  const uid = decodedToken.uid;
  const db = getAdminFirestore();
  const [userSnap, groupSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("groups").doc(groupId).get(),
  ]);
  if (!groupSnap.exists) throw new RouteAccessError(404, "Grupo no encontrado");

  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const role = asAllowedRole(userData.role) ?? asAllowedRole(decodedToken.role);
  if (!role) throw new RouteAccessError(403, "Missing or insufficient permissions.");

  const groupData = (groupSnap.data() ?? {}) as Record<string, unknown>;
  const plantelIds = getUserPlantelIds(userData);
  const groupPlantelId = asTrimmedString(groupData.plantelId);
  const coordinatorId = asTrimmedString(groupData.coordinatorId);
  const teacherId = asTrimmedString(groupData.teacherId);
  const assistantTeacherIds = asUniqueStringArray(groupData.assistantTeacherIds);
  const isOnlineGroup = !(typeof groupData.isInPerson === "boolean" && groupData.isInPerson === true);

  const canManage =
    role === "adminTeacher" ||
    role === "superAdminTeacher" ||
    (role === "teacher" && (teacherId === uid || assistantTeacherIds.includes(uid))) ||
    ((role === "coordinadorPlantel" || role === "director") &&
      ((groupPlantelId.length > 0 && plantelIds.includes(groupPlantelId)) ||
        (isOnlineGroup && coordinatorId === uid)));

  if (!canManage) throw new RouteAccessError(403, "Missing or insufficient permissions.");
  return { groupSnap, groupData };
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }

  console.error("Error al asignar materia extra:", error);
  return NextResponse.json({ success: false, error: "Error interno del servidor" }, { status: 500 });
}

type RouteContext = {
  params?: { groupId?: string } | Promise<{ groupId?: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const resolvedParams = await Promise.resolve(context.params);
    const groupIdFromParams = resolvedParams?.groupId?.trim() ?? "";
    const pathnameSegments = new URL(request.url).pathname.split("/").filter(Boolean);
    const groupIdFromPath =
      pathnameSegments[1] === "groups" && pathnameSegments[3] === "course-enrollments"
        ? pathnameSegments[2]?.trim() ?? ""
        : "";
    const groupId = groupIdFromParams || groupIdFromPath;
    if (!groupId) throw new RouteAccessError(400, "groupId es requerido");

    const payload = (await request.json().catch(() => ({}))) as {
      courseId?: unknown;
      studentIds?: unknown;
    };
    const courseId = asTrimmedString(payload.courseId);
    const studentIds = asUniqueStringArray(payload.studentIds);
    if (!courseId) throw new RouteAccessError(400, "courseId es requerido");
    if (studentIds.length === 0) throw new RouteAccessError(400, "Selecciona al menos un alumno");

    const { groupData } = await resolveAccessContext(request, groupId);
    const course = toGroupCourses(groupData).find((item) => item.courseId === courseId);
    if (!course) {
      throw new RouteAccessError(400, "La materia no pertenece a este grupo");
    }

    const db = getAdminFirestore();
    const now = FieldValue.serverTimestamp();
    const batch = db.batch();
    const assigned: string[] = [];
    const skippedGroupMembers: string[] = [];

    const studentDocs = await Promise.all(
      studentIds.map(async (studentId) => {
        const [userSnap, memberSnap] = await Promise.all([
          db.collection("users").doc(studentId).get(),
          db.collection("groups").doc(groupId).collection("students").doc(studentId).get(),
        ]);
        return { studentId, userSnap, memberSnap };
      }),
    );

    studentDocs.forEach(({ studentId, userSnap, memberSnap }) => {
      if (memberSnap.exists) {
        skippedGroupMembers.push(studentId);
        return;
      }
      if (!userSnap.exists) return;
      const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
      const studentName =
        asTrimmedString(userData.displayName) ||
        asTrimmedString(userData.name) ||
        "Alumno";
      const studentEmail = asTrimmedString(userData.email);
      const enrollmentId = `__courseOverride__${groupId}_${studentId}`;
      const enrollmentRef = db.collection("studentEnrollments").doc(enrollmentId);
      batch.set(
        enrollmentRef,
        {
          studentId,
          studentName,
          studentEmail,
          groupId,
          groupName: asTrimmedString(groupData.groupName),
          courseId,
          courseIds: FieldValue.arrayUnion(courseId),
          excludedCourseIds: FieldValue.arrayRemove(courseId),
          courseName: course.courseName,
          teacherName: asTrimmedString(groupData.teacherName),
          plantelId: asTrimmedString(groupData.plantelId),
          plantelName: asTrimmedString(groupData.plantelName),
          status: "active",
          source: "courseOverride",
          scope: "course",
          isCourseOverride: true,
          enrolledAt: now,
          updatedAt: now,
          finalGrade: null,
        },
        { merge: true },
      );
      assigned.push(studentId);
    });

    if (assigned.length > 0) await batch.commit();

    return NextResponse.json(
      {
        success: true,
        data: {
          assignedCount: assigned.length,
          assignedStudentIds: assigned,
          skippedGroupMemberIds: skippedGroupMembers,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
