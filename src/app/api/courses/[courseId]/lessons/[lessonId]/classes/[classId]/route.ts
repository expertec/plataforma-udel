import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TeacherRole =
  | "teacher"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel";

type CourseClassType = "video" | "text" | "audio" | "quiz" | "image";
type ForumRequiredFormat = "text" | "audio" | "video" | null;
type AssignmentSubmissionType = "file" | "audio";

type UpdateClassRequest = {
  title?: unknown;
  type?: unknown;
  order?: unknown;
  duration?: unknown;
  videoUrl?: unknown;
  content?: unknown;
  audioUrl?: unknown;
  imageUrls?: unknown;
  hasAssignment?: unknown;
  assignmentTemplateUrl?: unknown;
  assignmentSubmissionType?: unknown;
  isClassroomActivity?: unknown;
  showInStudentPlatform?: unknown;
  forumEnabled?: unknown;
  forumRequiredFormat?: unknown;
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
    value === "coordinadorPlantel"
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

function asNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new RouteAccessError(400, `${fieldName} debe ser texto o null`);
  }
  return value;
}

function asBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new RouteAccessError(400, `${fieldName} debe ser boolean`);
  }
  return value;
}

function asNullableStringArray(value: unknown, fieldName: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new RouteAccessError(400, `${fieldName} debe ser una lista o null`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new RouteAccessError(400, `${fieldName} debe contener solo texto`);
    }
    return item;
  });
}

function normalizeClassType(value: unknown): CourseClassType {
  if (value === "video" || value === "text" || value === "audio" || value === "quiz" || value === "image") {
    return value;
  }
  throw new RouteAccessError(400, "type inválido");
}

function normalizeForumRequiredFormat(value: unknown): ForumRequiredFormat {
  if (value === "text" || value === "audio" || value === "video") return value;
  if (value === null) return null;
  throw new RouteAccessError(400, "forumRequiredFormat inválido");
}

function normalizeAssignmentSubmissionType(value: unknown): AssignmentSubmissionType {
  if (value === "file") return "file";
  if (value === "audio") return "audio";
  throw new RouteAccessError(400, "assignmentSubmissionType inválido");
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

function normalizeDuration(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RouteAccessError(400, "duration inválida");
  }
  return value;
}

function getGroupCourseIds(groupData: Record<string, unknown>): string[] {
  const ids = asUniqueStringArray(groupData.courseIds);
  if (ids.length > 0) return ids;
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
    return groupCourseIds;
  }
  if (!Object.prototype.hasOwnProperty.call(mentorAccess, mentorId)) {
    return groupCourseIds;
  }
  const rawAllowed = (mentorAccess as Record<string, unknown>)[mentorId];
  const validGroupIds = new Set(groupCourseIds);
  return asUniqueStringArray(rawAllowed).filter((courseId) => validGroupIds.has(courseId));
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

  if (mentorIds.includes(uid)) {
    return { allowed: true, mentorIds, shouldBackfillMentor: false };
  }

  // Fallback para datos legacy: validar acceso de mentor por grupos.
  const mentorGroupsSnap = await db
    .collection("groups")
    .where("assistantTeacherIds", "array-contains", uid)
    .get();

  const hasGroupAccess = mentorGroupsSnap.docs.some((groupDoc) => {
    const groupData = groupDoc.data() as Record<string, unknown>;
    const allowedCourseIds = getMentorAllowedCourseIds(groupData, uid);
    return allowedCourseIds.includes(courseId);
  });

  if (!hasGroupAccess) {
    return { allowed: false, mentorIds, shouldBackfillMentor: false };
  }

  return { allowed: true, mentorIds, shouldBackfillMentor: true };
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }

  console.error("Error actualizando clase vía API segura", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ courseId: string; lessonId: string; classId: string }> },
) {
  try {
    const { courseId, lessonId, classId } = await context.params;
    const normalizedCourseId = asTrimmedString(courseId);
    const normalizedLessonId = asTrimmedString(lessonId);
    const normalizedClassId = asTrimmedString(classId);
    if (!normalizedCourseId || !normalizedLessonId || !normalizedClassId) {
      throw new RouteAccessError(400, "courseId, lessonId o classId inválido");
    }

    const teacherContext = await resolveTeacherContext(request);
    const rawBody = (await request.json()) as UpdateClassRequest | null;
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
    if (hasOwn(body, "type")) {
      payload.type = normalizeClassType(body.type);
    }
    if (hasOwn(body, "order")) {
      payload.order = normalizePositiveInt(body.order, "order");
    }
    if (hasOwn(body, "duration")) {
      payload.duration = normalizeDuration(body.duration);
    }
    if (hasOwn(body, "videoUrl")) {
      payload.videoUrl = asNullableString(body.videoUrl, "videoUrl");
    }
    if (hasOwn(body, "content")) {
      payload.content = asNullableString(body.content, "content");
    }
    if (hasOwn(body, "audioUrl")) {
      payload.audioUrl = asNullableString(body.audioUrl, "audioUrl");
    }
    if (hasOwn(body, "imageUrls")) {
      payload.imageUrls = asNullableStringArray(body.imageUrls, "imageUrls");
    }
    if (hasOwn(body, "hasAssignment")) {
      payload.hasAssignment = asBoolean(body.hasAssignment, "hasAssignment");
    }
    if (hasOwn(body, "assignmentTemplateUrl")) {
      payload.assignmentTemplateUrl = asNullableString(
        body.assignmentTemplateUrl,
        "assignmentTemplateUrl",
      );
    }
    if (hasOwn(body, "assignmentSubmissionType")) {
      payload.assignmentSubmissionType = normalizeAssignmentSubmissionType(
        body.assignmentSubmissionType,
      );
    }
    if (hasOwn(body, "isClassroomActivity")) {
      payload.isClassroomActivity = asBoolean(body.isClassroomActivity, "isClassroomActivity");
    }
    if (hasOwn(body, "showInStudentPlatform")) {
      payload.showInStudentPlatform = asBoolean(
        body.showInStudentPlatform,
        "showInStudentPlatform",
      );
    }
    if (hasOwn(body, "forumEnabled")) {
      payload.forumEnabled = asBoolean(body.forumEnabled, "forumEnabled");
    }
    if (hasOwn(body, "forumRequiredFormat")) {
      payload.forumRequiredFormat = normalizeForumRequiredFormat(body.forumRequiredFormat);
    }

    if (Object.keys(payload).length === 0) {
      throw new RouteAccessError(400, "No hay cambios para guardar");
    }

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
    const classRef = courseRef
      .collection("lessons")
      .doc(normalizedLessonId)
      .collection("classes")
      .doc(normalizedClassId);

    const classSnap = await classRef.get();
    if (!classSnap.exists) {
      throw new RouteAccessError(404, "Clase no encontrada");
    }
    const classData = classSnap.data() ?? {};

    const nextHasAssignment =
      typeof payload.hasAssignment === "boolean"
        ? payload.hasAssignment
        : classData.hasAssignment === true;
    const nextIsClassroomActivity = nextHasAssignment
      ? typeof payload.isClassroomActivity === "boolean"
        ? payload.isClassroomActivity
        : classData.isClassroomActivity === true
      : false;

    if (!nextHasAssignment) {
      payload.assignmentSubmissionType = "file";
      payload.isClassroomActivity = false;
      payload.showInStudentPlatform = true;
    } else if (!nextIsClassroomActivity) {
      payload.showInStudentPlatform = true;
    }

    const nextMentorIds = access.shouldBackfillMentor
      ? Array.from(new Set([...access.mentorIds, teacherContext.uid]))
      : access.mentorIds;

    const batch = db.batch();
    batch.update(classRef, payload);
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
