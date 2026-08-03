import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TeacherRole =
  | "teacher"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel"
  | "director";

type CreateLessonRequest = {
  title?: unknown;
  description?: unknown;
  lessonNumber?: unknown;
  order?: unknown;
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

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
    ),
  );
}

function normalizePositiveInt(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RouteAccessError(400, `${fieldName} debe ser un entero`);
  }
  if (value < 0) {
    throw new RouteAccessError(400, `${fieldName} debe ser >= 0`);
  }
  return value;
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
}): Promise<{ allowed: boolean; mentorIds: string[]; shouldBackfillMentor: boolean }> {
  const { courseId, uid, role } = params;
  const db = getAdminFirestore();

  const courseRef = db.collection("courses").doc(courseId);
  const courseSnap = await courseRef.get();
  if (!courseSnap.exists) {
    throw new RouteAccessError(404, "Curso no encontrado");
  }

  const courseData = (courseSnap.data() ?? {}) as Record<string, unknown>;
  const mentorIds = asUniqueStringArray(courseData.mentorIds);
  const teacherId = asTrimmedString(courseData.teacherId);

  if (role === "adminTeacher" || role === "superAdminTeacher") {
    return { allowed: true, mentorIds, shouldBackfillMentor: false };
  }

  if (teacherId && teacherId === uid) {
    return { allowed: true, mentorIds, shouldBackfillMentor: false };
  }

  return { allowed: false, mentorIds, shouldBackfillMentor: false };
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }

  console.error("Error creando lección vía API segura", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ courseId: string }> },
) {
  try {
    const { courseId } = await context.params;
    const normalizedCourseId = asTrimmedString(courseId);
    if (!normalizedCourseId) {
      throw new RouteAccessError(400, "courseId inválido");
    }

    const teacherContext = await resolveTeacherContext(request);
    const body = (await request.json()) as CreateLessonRequest;

    const title = asTrimmedString(body?.title);
    if (!title) {
      throw new RouteAccessError(400, "title es requerido");
    }

    const description =
      typeof body?.description === "string" ? body.description.trim() : "";
    const lessonNumber = normalizePositiveInt(body?.lessonNumber, "lessonNumber");
    if (lessonNumber < 1) {
      throw new RouteAccessError(400, "lessonNumber debe ser >= 1");
    }
    const order = normalizePositiveInt(body?.order, "order");

    const access = await canUserManageCourse({
      courseId: normalizedCourseId,
      uid: teacherContext.uid,
      role: teacherContext.role,
    });

    if (!access.allowed) {
      throw new RouteAccessError(403, "Missing or insufficient permissions.");
    }

    const db = getAdminFirestore();
    const courseRef = db.collection("courses").doc(normalizedCourseId);
    const lessonRef = courseRef.collection("lessons").doc();
    const nextMentorIds = access.shouldBackfillMentor
      ? Array.from(new Set([...access.mentorIds, teacherContext.uid]))
      : access.mentorIds;

    const batch = db.batch();
    batch.set(lessonRef, {
      lessonNumber,
      title,
      description,
      order,
      createdAt: FieldValue.serverTimestamp(),
    });
    batch.set(
      courseRef,
      {
        lessonsCount: FieldValue.increment(1),
        ...(access.shouldBackfillMentor ? { mentorIds: nextMentorIds } : {}),
      },
      { merge: true },
    );
    await batch.commit();

    return NextResponse.json(
      {
        success: true,
        data: {
          lessonId: lessonRef.id,
        },
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
