import { NextRequest, NextResponse } from "next/server";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
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

type UpdateLessonRequest = {
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

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
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

async function resolveTeacherContext(request: NextRequest): Promise<{
  uid: string;
  role: TeacherRole;
  coordinatorPlantelIds: string[];
}> {
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
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const roleFromDoc = asTeacherRole(userData.role);
  const roleFromClaims = asTeacherRole(decodedToken.role);
  const role = roleFromDoc ?? roleFromClaims;
  if (!role) {
    throw new RouteAccessError(403, "Acceso restringido a docentes");
  }

  const coordinatorPlantelIds = asUniqueStringArray(userData.plantelIds);
  if (coordinatorPlantelIds.length > 0) {
    return { uid, role, coordinatorPlantelIds };
  }
  const legacyPlantelId = asTrimmedString(userData.plantelId);
  return {
    uid,
    role,
    coordinatorPlantelIds: legacyPlantelId ? [legacyPlantelId] : [],
  };
}

async function canUserManageCourse(params: {
  courseId: string;
  uid: string;
  role: TeacherRole;
  coordinatorPlantelIds: string[];
}): Promise<{ allowed: boolean; mentorIds: string[]; shouldBackfillMentor: boolean }> {
  return resolveCourseManagementAccess({
    ...params,
    AccessError: RouteAccessError,
  });
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }

  console.error("Error actualizando lección vía API segura", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

async function deleteDocumentTree(docRef: DocumentReference): Promise<void> {
  const subcollections = await docRef.listCollections();
  for (const collectionRef of subcollections) {
    const snapshot = await collectionRef.get();
    for (const childDoc of snapshot.docs) {
      await deleteDocumentTree(childDoc.ref);
    }
  }
  await docRef.delete();
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ courseId: string; lessonId: string }> },
) {
  try {
    const { courseId, lessonId } = await context.params;
    const normalizedCourseId = asTrimmedString(courseId);
    const normalizedLessonId = asTrimmedString(lessonId);
    if (!normalizedCourseId || !normalizedLessonId) {
      throw new RouteAccessError(400, "courseId o lessonId inválido");
    }

    const teacherContext = await resolveTeacherContext(request);
    const rawBody = (await request.json()) as UpdateLessonRequest | null;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new RouteAccessError(400, "Body inválido");
    }
    const body = rawBody as Record<string, unknown>;

    const payload: Record<string, unknown> = {};
    if (hasOwn(body, "title")) {
      const title = asTrimmedString(body.title);
      if (!title) throw new RouteAccessError(400, "title no puede estar vacío");
      payload.title = title;
    }
    if (hasOwn(body, "description")) {
      if (body.description !== null && typeof body.description !== "string") {
        throw new RouteAccessError(400, "description debe ser texto o null");
      }
      payload.description = typeof body.description === "string" ? body.description.trim() : "";
    }
    if (hasOwn(body, "lessonNumber")) {
      const lessonNumber = normalizePositiveInt(body.lessonNumber, "lessonNumber");
      if (lessonNumber < 1) {
        throw new RouteAccessError(400, "lessonNumber debe ser >= 1");
      }
      payload.lessonNumber = lessonNumber;
    }
    if (hasOwn(body, "order")) {
      payload.order = normalizePositiveInt(body.order, "order");
    }
    if (Object.keys(payload).length === 0) {
      throw new RouteAccessError(400, "No hay cambios para guardar");
    }

    const access = await canUserManageCourse({
      courseId: normalizedCourseId,
      uid: teacherContext.uid,
      role: teacherContext.role,
      coordinatorPlantelIds: teacherContext.coordinatorPlantelIds,
    });

    if (!access.allowed) {
      throw new RouteAccessError(403, "Missing or insufficient permissions.");
    }

    const db = getAdminFirestore();
    const courseRef = db.collection("courses").doc(normalizedCourseId);
    const lessonRef = courseRef.collection("lessons").doc(normalizedLessonId);
    const lessonSnap = await lessonRef.get();
    if (!lessonSnap.exists) {
      throw new RouteAccessError(404, "Lección no encontrada");
    }

    const nextMentorIds = access.shouldBackfillMentor
      ? Array.from(new Set([...access.mentorIds, teacherContext.uid]))
      : access.mentorIds;

    const batch = db.batch();
    batch.update(lessonRef, payload);
    if (access.shouldBackfillMentor) {
      batch.set(
        courseRef,
        {
          mentorIds: nextMentorIds,
        },
        { merge: true },
      );
    }
    await batch.commit();

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ courseId: string; lessonId: string }> },
) {
  try {
    const { courseId, lessonId } = await context.params;
    const normalizedCourseId = asTrimmedString(courseId);
    const normalizedLessonId = asTrimmedString(lessonId);
    if (!normalizedCourseId || !normalizedLessonId) {
      throw new RouteAccessError(400, "courseId o lessonId inválido");
    }

    const teacherContext = await resolveTeacherContext(request);
    const access = await canUserManageCourse({
      courseId: normalizedCourseId,
      uid: teacherContext.uid,
      role: teacherContext.role,
      coordinatorPlantelIds: teacherContext.coordinatorPlantelIds,
    });

    if (!access.allowed) {
      throw new RouteAccessError(403, "Missing or insufficient permissions.");
    }

    const db = getAdminFirestore();
    const courseRef = db.collection("courses").doc(normalizedCourseId);
    const lessonRef = courseRef.collection("lessons").doc(normalizedLessonId);
    const lessonSnap = await lessonRef.get();
    if (!lessonSnap.exists) {
      throw new RouteAccessError(404, "Lección no encontrada");
    }

    await deleteDocumentTree(lessonRef);

    const nextMentorIds = access.shouldBackfillMentor
      ? Array.from(new Set([...access.mentorIds, teacherContext.uid]))
      : access.mentorIds;

    const batch = db.batch();
    batch.set(
      courseRef,
      {
        lessonsCount: FieldValue.increment(-1),
        ...(access.shouldBackfillMentor ? { mentorIds: nextMentorIds } : {}),
      },
      { merge: true },
    );
    await batch.commit();

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
