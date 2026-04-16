import { FieldPath } from "firebase-admin/firestore";
import type { NextRequest } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { normalizeLiveSession, type LiveClassSession } from "@/lib/live-classes/types";

export type UserRole =
  | "teacher"
  | "student"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel";

export type AuthorizedLiveAccessRole = "teacher" | "student";

export class LiveAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type AuthenticatedUser = {
  uid: string;
  role: UserRole | null;
  displayName: string;
  email: string;
};

type LiveClassContext = {
  classId: string;
  lessonId: string;
  courseId: string;
  classRef: FirebaseFirestore.DocumentReference;
  classData: Record<string, unknown>;
  liveSession: LiveClassSession | null;
};

const TEACHER_ROLES = new Set<UserRole>([
  "teacher",
  "adminTeacher",
  "superAdminTeacher",
  "coordinadorPlantel",
]);

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
    new Set(
      value.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
    ),
  );
}

function asUserRole(value: unknown): UserRole | null {
  if (
    value === "teacher" ||
    value === "student" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher" ||
    value === "coordinadorPlantel"
  ) {
    return value;
  }
  return null;
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

export function toLiveAccessErrorResponse(error: unknown) {
  if (error instanceof LiveAccessError) {
    return {
      status: error.status,
      message: error.message,
    };
  }
  return {
    status: 500,
    message: "Error interno del servidor",
  };
}

export async function resolveAuthenticatedUser(request: NextRequest): Promise<AuthenticatedUser> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    throw new LiveAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new LiveAccessError(401, "Token inválido o expirado");
  }

  const uid = decodedToken.uid;
  const db = getAdminFirestore();
  const userSnap = await db.collection("users").doc(uid).get();
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const roleFromDoc = asUserRole(userData.role);
  const roleFromClaims = asUserRole(decodedToken.role);
  const role = roleFromDoc ?? roleFromClaims;
  const displayName =
    asTrimmedString(userData.name) ||
    asTrimmedString(userData.displayName) ||
    asTrimmedString(decodedToken.name) ||
    uid;
  const email = asTrimmedString(userData.email) || asTrimmedString(decodedToken.email);

  return {
    uid,
    role,
    displayName,
    email,
  };
}

async function resolveLiveClassContext(classId: string): Promise<LiveClassContext> {
  const normalizedClassId = asTrimmedString(classId);
  if (!normalizedClassId) {
    throw new LiveAccessError(400, "classId inválido");
  }

  const db = getAdminFirestore();
  const classSnap = await db
    .collectionGroup("classes")
    .where(FieldPath.documentId(), "==", normalizedClassId)
    .limit(3)
    .get();

  if (classSnap.empty) {
    throw new LiveAccessError(404, "Clase no encontrada");
  }

  const classDoc = classSnap.docs[0];
  const classData = (classDoc.data() ?? {}) as Record<string, unknown>;
  const pathParts = classDoc.ref.path.split("/");
  if (pathParts.length !== 6) {
    throw new LiveAccessError(500, "Ruta de clase inválida");
  }
  const courseId = pathParts[1] ?? "";
  const lessonId = pathParts[3] ?? "";
  const docClassId = pathParts[5] ?? normalizedClassId;
  if (!courseId || !lessonId || !docClassId) {
    throw new LiveAccessError(500, "No se pudo resolver la clase");
  }

  const type = asTrimmedString(classData.type).toLowerCase();
  if (type !== "live") {
    throw new LiveAccessError(400, "La clase no es de tipo live");
  }

  return {
    classId: docClassId,
    lessonId,
    courseId,
    classRef: classDoc.ref,
    classData,
    liveSession: normalizeLiveSession(classData.liveSession),
  };
}

async function canUserManageCourse(params: {
  uid: string;
  role: UserRole | null;
  courseId: string;
}): Promise<boolean> {
  const db = getAdminFirestore();
  const courseRef = db.collection("courses").doc(params.courseId);
  const courseSnap = await courseRef.get();
  if (!courseSnap.exists) return false;

  const courseData = (courseSnap.data() ?? {}) as Record<string, unknown>;
  const teacherId = asTrimmedString(courseData.teacherId);
  const mentorIds = asUniqueStringArray(courseData.mentorIds);

  if (teacherId && teacherId === params.uid) return true;
  if (mentorIds.includes(params.uid)) return true;
  if (params.role === "adminTeacher" || params.role === "superAdminTeacher") return true;

  const mentorGroupsSnap = await db
    .collection("groups")
    .where("assistantTeacherIds", "array-contains", params.uid)
    .get();

  return mentorGroupsSnap.docs.some((groupDoc) => {
    const groupData = groupDoc.data() as Record<string, unknown>;
    const allowedCourseIds = getMentorAllowedCourseIds(groupData, params.uid);
    return allowedCourseIds.includes(params.courseId);
  });
}

async function getStudentEnrollmentIds(params: {
  uid: string;
  courseId: string;
}): Promise<string[]> {
  const db = getAdminFirestore();
  const enrollmentSnap = await db
    .collection("studentEnrollments")
    .where("studentId", "==", params.uid)
    .where("courseId", "==", params.courseId)
    .get();

  if (enrollmentSnap.empty) return [];

  const allowedStatuses = new Set(["active", "completed"]);
  return enrollmentSnap.docs
    .filter((snap) => {
      const status = asTrimmedString((snap.data() as Record<string, unknown>).status);
      if (!status) return true;
      return allowedStatuses.has(status);
    })
    .map((snap) => snap.id);
}

export async function resolveAuthorizedLiveClassAccess(params: {
  request: NextRequest;
  classId: string;
  requireTeacher?: boolean;
}): Promise<{
  user: AuthenticatedUser;
  classContext: LiveClassContext;
  accessRole: AuthorizedLiveAccessRole;
  enrollmentIds: string[];
}> {
  const user = await resolveAuthenticatedUser(params.request);
  const classContext = await resolveLiveClassContext(params.classId);

  const teacherAllowed = await canUserManageCourse({
    uid: user.uid,
    role: user.role,
    courseId: classContext.courseId,
  });

  if (teacherAllowed) {
    return {
      user,
      classContext,
      accessRole: "teacher",
      enrollmentIds: [],
    };
  }

  if (params.requireTeacher) {
    throw new LiveAccessError(403, "Missing or insufficient permissions.");
  }

  const enrollmentIds = await getStudentEnrollmentIds({
    uid: user.uid,
    courseId: classContext.courseId,
  });
  if (enrollmentIds.length > 0) {
    return {
      user,
      classContext,
      accessRole: "student",
      enrollmentIds,
    };
  }

  const expectedStudent =
    user.role === "student" || user.role === null || !TEACHER_ROLES.has(user.role);
  if (expectedStudent) {
    throw new LiveAccessError(403, "No estás inscrito en esta materia.");
  }

  throw new LiveAccessError(403, "Missing or insufficient permissions.");
}

export async function resolveLiveClassByRoomName(roomName: string): Promise<LiveClassContext | null> {
  const normalizedRoom = asTrimmedString(roomName);
  if (!normalizedRoom) return null;
  const db = getAdminFirestore();
  const snap = await db
    .collectionGroup("classes")
    .where("liveSession.roomName", "==", normalizedRoom)
    .limit(2)
    .get();
  if (snap.empty) return null;
  const classDoc = snap.docs[0];
  const classData = (classDoc.data() ?? {}) as Record<string, unknown>;
  const pathParts = classDoc.ref.path.split("/");
  if (pathParts.length !== 6) return null;
  return {
    classId: pathParts[5] ?? classDoc.id,
    lessonId: pathParts[3] ?? "",
    courseId: pathParts[1] ?? "",
    classRef: classDoc.ref,
    classData,
    liveSession: normalizeLiveSession(classData.liveSession),
  };
}

