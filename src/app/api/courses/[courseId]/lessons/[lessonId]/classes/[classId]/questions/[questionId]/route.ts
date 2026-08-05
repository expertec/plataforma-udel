import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { resolveCourseManagementAccess } from "@/lib/server/course-management-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TeacherRole =
  | "teacher"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel"
  | "director";

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

function asTeacherRole(value: unknown): TeacherRole | null {
  if (
    value === "teacher" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher" ||
    value === "coordinadorPlantel" ||
    value === "director"
  ) {
    return value;
  }
  return null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function resolveTeacherContext(request: NextRequest): Promise<{ uid: string; role: TeacherRole }> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    throw new RouteAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new RouteAccessError(401, "Token inválido o expirado");
  }

  const uid = decodedToken.uid;
  const userSnap = await getAdminFirestore().collection("users").doc(uid).get();
  const roleFromDoc = asTeacherRole(userSnap.data()?.role);
  const roleFromClaims = asTeacherRole(decodedToken.role);
  const role = roleFromDoc ?? roleFromClaims;
  if (!role) {
    throw new RouteAccessError(403, "Acceso restringido a docentes");
  }

  return { uid, role };
}

async function canUserManageCourse(params: {
  courseId: string;
  uid: string;
  role: TeacherRole;
}): Promise<boolean> {
  const access = await resolveCourseManagementAccess({
    ...params,
    AccessError: RouteAccessError,
  });
  return access.allowed;
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }

  console.error("Error eliminando pregunta de quiz vía API segura", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ courseId: string; lessonId: string; classId: string; questionId: string }> },
) {
  try {
    const { courseId, lessonId, classId, questionId } = await context.params;
    const normalizedCourseId = asTrimmedString(courseId);
    const normalizedLessonId = asTrimmedString(lessonId);
    const normalizedClassId = asTrimmedString(classId);
    const normalizedQuestionId = asTrimmedString(questionId);
    if (!normalizedCourseId || !normalizedLessonId || !normalizedClassId || !normalizedQuestionId) {
      throw new RouteAccessError(400, "courseId, lessonId, classId o questionId inválido");
    }

    const teacherContext = await resolveTeacherContext(request);
    const courseAllowed = await canUserManageCourse({
      courseId: normalizedCourseId,
      uid: teacherContext.uid,
      role: teacherContext.role,
    });
    if (!courseAllowed) {
      throw new RouteAccessError(403, "Missing or insufficient permissions.");
    }

    const db = getAdminFirestore();
    const questionRef = db
      .collection("courses")
      .doc(normalizedCourseId)
      .collection("lessons")
      .doc(normalizedLessonId)
      .collection("classes")
      .doc(normalizedClassId)
      .collection("questions")
      .doc(normalizedQuestionId);
    const questionSnap = await questionRef.get();
    if (!questionSnap.exists) {
      throw new RouteAccessError(404, "Pregunta no encontrada");
    }

    await questionRef.delete();
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
