import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UnlinkCourseRequest = {
  groupId: string;
  courseId: string;
  teacherId?: string;
  scope?: "group" | "teacher";
};

type TeacherRole =
  | "teacher"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel";

type RequesterContext = {
  uid: string;
  role: TeacherRole;
};

type MentorCourseAccessMap = Record<string, string[]>;

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

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
    ),
  );
}

function toGroupCourseIds(groupData: Record<string, unknown>): string[] {
  const explicitIds = asUniqueStringArray(groupData.courseIds);
  if (explicitIds.length > 0) return explicitIds;
  const legacyCourseId = asTrimmedString(groupData.courseId);
  return legacyCourseId ? [legacyCourseId] : [];
}

function toGroupCourses(groupData: Record<string, unknown>): Array<{ courseId: string; courseName: string }> {
  if (!Array.isArray(groupData.courses)) return [];
  return groupData.courses
    .map((course) => {
      if (!course || typeof course !== "object") return null;
      const item = course as { courseId?: unknown; courseName?: unknown };
      const courseId = asTrimmedString(item.courseId);
      if (!courseId) return null;
      return {
        courseId,
        courseName: asTrimmedString(item.courseName),
      };
    })
    .filter((item): item is { courseId: string; courseName: string } => item !== null);
}

function toAssistantTeachers(
  value: unknown,
): Array<{ id: string; name: string; email?: string }> {
  if (!Array.isArray(value)) return [];
  return value.reduce<Array<{ id: string; name: string; email?: string }>>((acc, item) => {
    if (!item || typeof item !== "object") return acc;
    const raw = item as { id?: unknown; name?: unknown; email?: unknown };
    const id = asTrimmedString(raw.id);
    if (!id) return acc;
    const name = asTrimmedString(raw.name);
    const email = asTrimmedString(raw.email);
    acc.push(email ? { id, name, email } : { id, name });
    return acc;
  }, []);
}

function normalizeMentorCourseAccess(
  value: unknown,
  validCourseIds: string[],
): MentorCourseAccessMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const validIds = new Set(validCourseIds);
  const next: MentorCourseAccessMap = {};
  Object.entries(value as Record<string, unknown>).forEach(([mentorId, rawIds]) => {
    if (!mentorId) return;
    next[mentorId] = asUniqueStringArray(rawIds).filter((courseId) => validIds.has(courseId));
  });
  return next;
}

function buildMentorCourseAccess(params: {
  mentorIds: string[];
  existingAccess: MentorCourseAccessMap;
  validCourseIds: string[];
}): MentorCourseAccessMap {
  const { mentorIds, existingAccess, validCourseIds } = params;
  const validSet = new Set(validCourseIds);
  const next: MentorCourseAccessMap = {};
  mentorIds.forEach((mentorId) => {
    if (!mentorId) return;
    const hasExisting = Object.prototype.hasOwnProperty.call(existingAccess, mentorId);
    if (hasExisting) {
      next[mentorId] = (existingAccess[mentorId] ?? []).filter((courseId) => validSet.has(courseId));
      return;
    }
    next[mentorId] = [...validCourseIds];
  });
  return next;
}

function mapCourseMentorsByAccess(
  courseIds: string[],
  mentorIds: string[],
  mentorCourseAccess: MentorCourseAccessMap,
): Record<string, string[]> {
  const byCourse: Record<string, string[]> = {};
  courseIds.forEach((courseId) => {
    byCourse[courseId] = mentorIds.filter((mentorId) => {
      if (!Object.prototype.hasOwnProperty.call(mentorCourseAccess, mentorId)) return true;
      return mentorCourseAccess[mentorId]?.includes(courseId) ?? false;
    });
  });
  return byCourse;
}

async function syncCourseMentorsByCourse(
  db: Firestore,
  courseMentorsByCourse: Record<string, string[]>,
): Promise<void> {
  const entries = Object.entries(courseMentorsByCourse).filter(
    ([courseId]) => typeof courseId === "string" && courseId.trim().length > 0,
  );
  if (entries.length === 0) return;
  const batch = db.batch();
  entries.forEach(([courseId, mentorIds]) => {
    const courseRef = db.collection("courses").doc(courseId);
    batch.set(courseRef, { mentorIds: asUniqueStringArray(mentorIds) }, { merge: true });
  });
  await batch.commit();
}

async function resolveRequesterContext(request: NextRequest): Promise<RequesterContext> {
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
  const role = asTeacherRole(userSnap.data()?.role) ?? asTeacherRole(decodedToken.role);
  if (!role) {
    throw new RouteAccessError(403, "Missing or insufficient permissions.");
  }

  return { uid, role };
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }

  console.error("Error al desvincular curso del grupo:", error);
  const message = error instanceof Error ? error.message : "Error al desvincular curso del grupo";
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

export async function POST(request: NextRequest) {
  try {
    const requester = await resolveRequesterContext(request);
    const body = (await request.json()) as UnlinkCourseRequest;
    const groupId = asTrimmedString(body?.groupId);
    const courseId = asTrimmedString(body?.courseId);
    const teacherId = asTrimmedString(body?.teacherId);
    const scope = body?.scope === "teacher" ? "teacher" : "group";

    if (!groupId || !courseId) {
      return NextResponse.json(
        { error: "groupId y courseId son requeridos" },
        { status: 400 }
      );
    }

    const db = getAdminFirestore();
    const groupRef = db.collection("groups").doc(groupId);
    const groupSnap = await groupRef.get();
    if (!groupSnap.exists) {
      throw new RouteAccessError(404, "Grupo no encontrado");
    }

    const groupData = (groupSnap.data() ?? {}) as Record<string, unknown>;
    const courseIds = toGroupCourseIds(groupData);
    if (!courseIds.includes(courseId)) {
      throw new RouteAccessError(400, "La materia no está asignada al grupo");
    }

    const principalTeacherId = asTrimmedString(groupData.teacherId);
    const mentorIds = asUniqueStringArray(groupData.assistantTeacherIds);
    const requesterIsAdmin =
      requester.role === "adminTeacher" || requester.role === "superAdminTeacher";
    const requesterIsPrincipal = principalTeacherId === requester.uid;
    const requesterIsMentor = mentorIds.includes(requester.uid);

    if (!requesterIsAdmin && !requesterIsPrincipal && !requesterIsMentor) {
      throw new RouteAccessError(403, "Missing or insufficient permissions.");
    }

    if (scope === "teacher") {
      if (!teacherId) {
        throw new RouteAccessError(400, "teacherId es requerido cuando scope=teacher");
      }

      if (!requesterIsAdmin && teacherId !== requester.uid) {
        throw new RouteAccessError(403, "Missing or insufficient permissions.");
      }

      if (teacherId === principalTeacherId) {
        return NextResponse.json({
          success: true,
          scope: "teacher",
          updated: false,
          message: "El profesor principal conserva el acceso del grupo",
        });
      }

      if (!mentorIds.includes(teacherId)) {
        throw new RouteAccessError(400, "El profesor no está asignado como mentor en este grupo");
      }

      const existingAccess = normalizeMentorCourseAccess(groupData.mentorCourseAccess, courseIds);
      const nextAccess = buildMentorCourseAccess({
        mentorIds,
        existingAccess,
        validCourseIds: courseIds,
      });

      const currentTeacherAccess = new Set(nextAccess[teacherId] ?? []);
      if (!currentTeacherAccess.has(courseId)) {
        return NextResponse.json({
          success: true,
          scope: "teacher",
          updated: false,
          message: "No hubo cambios en la vinculación del profesor",
        });
      }

      currentTeacherAccess.delete(courseId);
      nextAccess[teacherId] = courseIds.filter((id) => currentTeacherAccess.has(id));

      const remainingCourseIdsForTeacher = nextAccess[teacherId];
      const detachedFromGroup = remainingCourseIdsForTeacher.length === 0;
      const nextMentorIds = detachedFromGroup
        ? mentorIds.filter((mentorId) => mentorId !== teacherId)
        : mentorIds;
      const nextAssistantTeachers = detachedFromGroup
        ? toAssistantTeachers(groupData.assistantTeachers).filter((teacher) => teacher.id !== teacherId)
        : toAssistantTeachers(groupData.assistantTeachers);

      if (detachedFromGroup) {
        delete nextAccess[teacherId];
      }

      const finalAccess = buildMentorCourseAccess({
        mentorIds: nextMentorIds,
        existingAccess: nextAccess,
        validCourseIds: courseIds,
      });

      await groupRef.set(
        {
          assistantTeacherIds: nextMentorIds,
          assistantTeachers: nextAssistantTeachers,
          mentorCourseAccess: finalAccess,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      const courseMentors = mapCourseMentorsByAccess(courseIds, nextMentorIds, finalAccess);
      await syncCourseMentorsByCourse(db, courseMentors);

      return NextResponse.json({
        success: true,
        scope: "teacher",
        updated: true,
        detachedFromGroup,
        message: detachedFromGroup
          ? "Profesor desvinculado del grupo"
          : "Materia desvinculada del profesor en este grupo",
      });
    }

    if (!requesterIsAdmin && !requesterIsPrincipal) {
      throw new RouteAccessError(403, "Missing or insufficient permissions.");
    }

    const courses = toGroupCourses(groupData);
    const nextCourses = courses.filter((course) => course.courseId !== courseId);
    const nextCourseIds = courseIds.filter((id) => id !== courseId);
    const existingAccess = normalizeMentorCourseAccess(groupData.mentorCourseAccess, courseIds);
    const nextMentorCourseAccess = buildMentorCourseAccess({
      mentorIds,
      existingAccess,
      validCourseIds: nextCourseIds,
    });
    const primaryCourse = nextCourses[0] ?? null;

    await groupRef.set(
      {
        courses: nextCourses,
        courseIds: nextCourseIds,
        mentorCourseAccess: nextMentorCourseAccess,
        courseId: primaryCourse?.courseId ?? "",
        courseName: primaryCourse?.courseName ?? "",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return NextResponse.json({
      success: true,
      scope: "group",
      updated: true,
      message: "Curso desvinculado del grupo correctamente",
    });
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
