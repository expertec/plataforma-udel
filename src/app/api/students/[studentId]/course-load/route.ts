import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AllowedRole = "teacher" | "coordinadorPlantel" | "director" | "adminTeacher" | "superAdminTeacher";
type FirestoreRecord = Record<string, unknown>;

type AccessContext = {
  uid: string;
  role: AllowedRole;
  plantelIds: string[];
};

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
  return Array.from(new Set(value.map((item) => asTrimmedString(item)).filter(Boolean)));
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

function getUserPlantelIds(data: FirestoreRecord): string[] {
  const plantelIds = asUniqueStringArray(data.plantelIds);
  if (plantelIds.length > 0) return plantelIds;
  const legacyPlantelId = asTrimmedString(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function isAdminRole(role: AllowedRole): boolean {
  return role === "adminTeacher" || role === "superAdminTeacher";
}

function toGroupCourses(groupData: FirestoreRecord): Array<{ courseId: string; courseName: string }> {
  if (Array.isArray(groupData.courses) && groupData.courses.length > 0) {
    return groupData.courses
      .map((course) => {
        if (!course || typeof course !== "object") return null;
        const item = course as FirestoreRecord;
        const courseId = asTrimmedString(item.courseId);
        if (!courseId) return null;
        return {
          courseId,
          courseName: asTrimmedString(item.courseName) || courseId,
        };
      })
      .filter((course): course is { courseId: string; courseName: string } => course !== null);
  }

  const legacyCourseId = asTrimmedString(groupData.courseId);
  return legacyCourseId
    ? [{ courseId: legacyCourseId, courseName: asTrimmedString(groupData.courseName) || legacyCourseId }]
    : [];
}

function isCourseOverrideEnrollment(enrollmentData: FirestoreRecord): boolean {
  const source = asTrimmedString(enrollmentData.source);
  return (
    enrollmentData.isCourseOverride === true ||
    enrollmentData.scope === "course" ||
    source === "courseOverride" ||
    source === "extraCourse"
  );
}

function canAccessGroup(access: AccessContext, groupData: FirestoreRecord): boolean {
  if (isAdminRole(access.role)) return true;
  const teacherId = asTrimmedString(groupData.teacherId);
  const assistantTeacherIds = asUniqueStringArray(groupData.assistantTeacherIds);
  if (access.role === "teacher" && (teacherId === access.uid || assistantTeacherIds.includes(access.uid))) {
    return true;
  }

  const groupPlantelId = asTrimmedString(groupData.plantelId);
  const isOnlineGroup = groupData.isInPerson !== true;
  const coordinatorId = asTrimmedString(groupData.coordinatorId);
  return (
    (access.role === "coordinadorPlantel" || access.role === "director") &&
    ((groupPlantelId.length > 0 && access.plantelIds.includes(groupPlantelId)) ||
      (isOnlineGroup && coordinatorId === access.uid))
  );
}

async function resolveAccess(request: NextRequest): Promise<AccessContext> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) throw new RouteAccessError(401, "Authorization Bearer token requerido");

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new RouteAccessError(401, "Token inválido o expirado");
  }

  const userSnap = await getAdminFirestore().collection("users").doc(decodedToken.uid).get();
  const userData = (userSnap.data() ?? {}) as FirestoreRecord;
  const role = asAllowedRole(userData.role) ?? asAllowedRole(decodedToken.role);
  if (!role) throw new RouteAccessError(403, "Missing or insufficient permissions.");

  return {
    uid: decodedToken.uid,
    role,
    plantelIds: getUserPlantelIds(userData),
  };
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  console.error("Error al gestionar carga académica del alumno:", error);
  return NextResponse.json({ success: false, error: "Error interno del servidor" }, { status: 500 });
}

type RouteContext = {
  params?: { studentId?: string } | Promise<{ studentId?: string }>;
};

async function resolveStudentId(request: NextRequest, context: RouteContext): Promise<string> {
  const resolvedParams = await Promise.resolve(context.params);
  const studentIdFromParams = resolvedParams?.studentId?.trim() ?? "";
  const pathnameSegments = new URL(request.url).pathname.split("/").filter(Boolean);
  const studentIdFromPath =
    pathnameSegments[1] === "students" && pathnameSegments[3] === "course-load"
      ? pathnameSegments[2]?.trim() ?? ""
      : "";
  const studentId = studentIdFromParams || studentIdFromPath;
  if (!studentId) throw new RouteAccessError(400, "studentId es requerido");
  return studentId;
}

async function buildCourseLoad(studentId: string, access: AccessContext) {
  const db = getAdminFirestore();
  const enrollmentsSnap = await db
    .collection("studentEnrollments")
    .where("studentId", "==", studentId)
    .get();

  const groupIds = Array.from(
    new Set(
      enrollmentsSnap.docs
        .map((docSnap) => asTrimmedString((docSnap.data() as FirestoreRecord).groupId))
        .filter(Boolean),
    ),
  );

  const groupSnaps = await Promise.all(groupIds.map((groupId) => db.collection("groups").doc(groupId).get()));
  const groupsById = new Map<string, FirestoreRecord>();
  groupSnaps.forEach((groupSnap) => {
    if (groupSnap.exists) groupsById.set(groupSnap.id, (groupSnap.data() ?? {}) as FirestoreRecord);
  });

  const enrollments = enrollmentsSnap.docs
    .map((docSnap) => {
      const enrollmentData = (docSnap.data() ?? {}) as FirestoreRecord;
      const status = asTrimmedString(enrollmentData.status) || "active";
      if (status === "archived" || status === "inactive" || status === "baja") return null;

      const groupId = asTrimmedString(enrollmentData.groupId);
      const groupData = groupId ? groupsById.get(groupId) : undefined;
      if (!groupData || !canAccessGroup(access, groupData)) return null;

      const excludedCourseIds = asUniqueStringArray(enrollmentData.excludedCourseIds);
      const excludedSet = new Set(excludedCourseIds);
      const override = isCourseOverrideEnrollment(enrollmentData);
      const overrideCourseIds = new Set(asUniqueStringArray(enrollmentData.courseIds));
      const legacyCourseId = asTrimmedString(enrollmentData.courseId);
      if (legacyCourseId) overrideCourseIds.add(legacyCourseId);

      const groupCourses = toGroupCourses(groupData);
      const courses = groupCourses
        .filter((course) => !override || overrideCourseIds.has(course.courseId))
        .map((course) => ({
          courseId: course.courseId,
          courseName: course.courseName,
          checked: !excludedSet.has(course.courseId),
        }));

      if (courses.length === 0) return null;

      return {
        enrollmentId: docSnap.id,
        groupId,
        groupName: asTrimmedString(groupData.groupName) || asTrimmedString(enrollmentData.groupName) || "Grupo",
        isCourseOverride: override,
        excludedCourseIds,
        courses,
      };
    })
    .filter(
      (item): item is {
        enrollmentId: string;
        groupId: string;
        groupName: string;
        isCourseOverride: boolean;
        excludedCourseIds: string[];
        courses: Array<{ courseId: string; courseName: string; checked: boolean }>;
      } => item !== null,
    );

  return enrollments.sort((left, right) =>
    left.groupName.localeCompare(right.groupName, "es-MX", { numeric: true, sensitivity: "base" }),
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const studentId = await resolveStudentId(request, context);
    const access = await resolveAccess(request);
    const enrollments = await buildCourseLoad(studentId, access);
    return NextResponse.json({ success: true, data: { enrollments } }, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const studentId = await resolveStudentId(request, context);
    const access = await resolveAccess(request);
    const body = (await request.json().catch(() => ({}))) as {
      updates?: Array<{ enrollmentId?: unknown; excludedCourseIds?: unknown }>;
    };
    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (updates.length === 0) throw new RouteAccessError(400, "No hay cambios para guardar");

    const db = getAdminFirestore();
    const currentLoad = await buildCourseLoad(studentId, access);
    const editableByEnrollmentId = new Map(currentLoad.map((item) => [item.enrollmentId, item]));
    const batch = db.batch();
    let writes = 0;

    updates.forEach((update) => {
      const enrollmentId = asTrimmedString(update.enrollmentId);
      const editable = editableByEnrollmentId.get(enrollmentId);
      if (!editable) return;
      const validCourseIds = new Set(editable.courses.map((course) => course.courseId));
      const excludedCourseIds = asUniqueStringArray(update.excludedCourseIds).filter((courseId) =>
        validCourseIds.has(courseId),
      );
      batch.set(
        db.collection("studentEnrollments").doc(enrollmentId),
        {
          excludedCourseIds,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      writes += 1;
    });

    if (writes === 0) throw new RouteAccessError(403, "No tienes permiso para actualizar esas materias");
    await batch.commit();

    const enrollments = await buildCourseLoad(studentId, access);
    return NextResponse.json({ success: true, data: { enrollments } }, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
