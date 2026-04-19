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

function mapInternalLiveError(error: Error): string | null {
  const message = error.message.trim();
  if (!message) return null;

  if (message.startsWith("Missing required env var:")) {
    const envName = message.replace("Missing required env var:", "").trim();
    if (envName) {
      return `Configuración incompleta del servidor: falta ${envName}`;
    }
  }

  if (message.includes("Missing GCS credentials for LiveKit egress")) {
    return "Configuración incompleta para grabación: faltan credenciales GCS/Firebase Admin";
  }

  return null;
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
  const explicitIds = asUniqueStringArray(groupData.courseIds);
  if (explicitIds.length > 0) return explicitIds;

  if (Array.isArray(groupData.courses)) {
    const courseIdsFromArray = Array.from(
      new Set(
        groupData.courses
          .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return "";
            return asTrimmedString((item as Record<string, unknown>).courseId);
          })
          .filter((courseId) => courseId.length > 0),
      ),
    );
    if (courseIdsFromArray.length > 0) return courseIdsFromArray;
  }

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
  if (error instanceof Error) {
    const mappedMessage = mapInternalLiveError(error);
    if (mappedMessage) {
      return {
        status: 500,
        message: mappedMessage,
      };
    }
    if (process.env.NODE_ENV !== "production") {
      const errorWithCode = error as Error & { code?: unknown };
      const code =
        typeof errorWithCode.code === "string" && errorWithCode.code.trim().length > 0
          ? `[${errorWithCode.code.trim()}] `
          : "";
      const message = error.message.trim() || "Error interno del servidor";
      return {
        status: 500,
        message: `Error técnico: ${code}${message}`,
      };
    }
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

function parseClassPath(path: string): { courseId: string; lessonId: string; classId: string } | null {
  const parts = path.split("/").filter((segment) => segment.length > 0);
  if (
    parts.length !== 6 ||
    parts[0] !== "courses" ||
    parts[2] !== "lessons" ||
    parts[4] !== "classes"
  ) {
    return null;
  }
  const courseId = asTrimmedString(parts[1]);
  const lessonId = asTrimmedString(parts[3]);
  const classId = asTrimmedString(parts[5]);
  if (!courseId || !lessonId || !classId) return null;
  return { courseId, lessonId, classId };
}

function buildLiveClassContextFromSnapshot(params: {
  classSnap: FirebaseFirestore.DocumentSnapshot;
  fallbackClassId: string;
}): LiveClassContext {
  if (!params.classSnap.exists) {
    throw new LiveAccessError(404, "Clase no encontrada");
  }
  const classData = (params.classSnap.data() ?? {}) as Record<string, unknown>;
  const parsedPath = parseClassPath(params.classSnap.ref.path);
  if (!parsedPath) {
    throw new LiveAccessError(500, "Ruta de clase inválida");
  }

  const type = asTrimmedString(classData.type).toLowerCase();
  if (type !== "live") {
    throw new LiveAccessError(400, "La clase no es de tipo live");
  }

  return {
    classId: parsedPath.classId || params.fallbackClassId,
    lessonId: parsedPath.lessonId,
    courseId: parsedPath.courseId,
    classRef: params.classSnap.ref,
    classData,
    liveSession: normalizeLiveSession(classData.liveSession),
  };
}

async function resolveLiveClassContext(params: {
  classId: string;
  courseId?: string;
  lessonId?: string;
}): Promise<LiveClassContext> {
  const normalizedClassId = asTrimmedString(params.classId);
  if (!normalizedClassId) {
    throw new LiveAccessError(400, "classId inválido");
  }

  const db = getAdminFirestore();
  const normalizedCourseId = asTrimmedString(params.courseId);
  const normalizedLessonId = asTrimmedString(params.lessonId);

  if (normalizedCourseId || normalizedLessonId) {
    if (!normalizedCourseId || !normalizedLessonId) {
      throw new LiveAccessError(400, "courseId y lessonId deben enviarse juntos");
    }
    const classRef = db
      .collection("courses")
      .doc(normalizedCourseId)
      .collection("lessons")
      .doc(normalizedLessonId)
      .collection("classes")
      .doc(normalizedClassId);
    const classSnap = await classRef.get();
    return buildLiveClassContextFromSnapshot({
      classSnap,
      fallbackClassId: normalizedClassId,
    });
  }

  const parsedClassPath = parseClassPath(normalizedClassId);
  if (parsedClassPath) {
    const classSnap = await db.doc(normalizedClassId).get();
    return buildLiveClassContextFromSnapshot({
      classSnap,
      fallbackClassId: parsedClassPath.classId,
    });
  }

  const classSnapByFieldId = await db
    .collectionGroup("classes")
    .where("id", "==", normalizedClassId)
    .limit(3)
    .get();
  if (!classSnapByFieldId.empty) {
    return buildLiveClassContextFromSnapshot({
      classSnap: classSnapByFieldId.docs[0],
      fallbackClassId: normalizedClassId,
    });
  }

  throw new LiveAccessError(
    404,
    "Clase no encontrada. Incluye courseId y lessonId para resolver clases legacy.",
  );
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
  const normalizedCourseId = asTrimmedString(params.courseId);
  if (!normalizedCourseId) return [];

  const isAllowedEnrollmentStatus = (value: unknown): boolean => {
    const status = asTrimmedString(value).toLowerCase();
    if (!status) return true;
    const blocked = new Set([
      "dropped",
      "inactive",
      "archived",
      "cancelled",
      "deleted",
      "blocked",
      "suspended",
      "baja",
    ]);
    return !blocked.has(status);
  };

  const resolveGroupIdsWithCourse = async (groupIds: string[]): Promise<string[]> => {
    const uniqueGroupIds = Array.from(
      new Set(groupIds.map((groupId) => groupId.trim()).filter((groupId) => groupId.length > 0)),
    );
    if (uniqueGroupIds.length === 0) return [];
    const groupSnaps = await Promise.all(
      uniqueGroupIds.map((groupId) => db.collection("groups").doc(groupId).get()),
    );
    return groupSnaps
      .filter((groupSnap) => {
        if (!groupSnap.exists) return false;
        const groupData = groupSnap.data() as Record<string, unknown>;
        const groupCourseIds = getGroupCourseIds(groupData);
        return groupCourseIds.includes(normalizedCourseId);
      })
      .map((groupSnap) => groupSnap.id);
  };

  const enrollmentsByStudentSnap = await db
    .collection("studentEnrollments")
    .where("studentId", "==", params.uid)
    .get();

  const matchedEnrollmentIds: string[] = [];
  const enrollmentGroupIds = new Set<string>();
  enrollmentsByStudentSnap.docs.forEach((enrollmentSnap) => {
    const enrollmentData = enrollmentSnap.data() as Record<string, unknown>;
    if (!isAllowedEnrollmentStatus(enrollmentData.status)) return;
    const enrollmentCourseId = asTrimmedString(enrollmentData.courseId);
    if (enrollmentCourseId === normalizedCourseId) {
      matchedEnrollmentIds.push(enrollmentSnap.id);
    }
    const groupId = asTrimmedString(enrollmentData.groupId);
    if (groupId) enrollmentGroupIds.add(groupId);
  });
  if (matchedEnrollmentIds.length > 0) {
    return Array.from(new Set(matchedEnrollmentIds));
  }

  const matchedEnrollmentGroups = await resolveGroupIdsWithCourse(Array.from(enrollmentGroupIds));
  if (matchedEnrollmentGroups.length > 0) {
    return matchedEnrollmentGroups.map((groupId) => `group:${groupId}`);
  }

  const courseEnrollmentSnap = await db
    .collection("courses")
    .doc(normalizedCourseId)
    .collection("enrollments")
    .doc(params.uid)
    .get();
  if (courseEnrollmentSnap.exists) {
    const courseEnrollmentData = (courseEnrollmentSnap.data() ?? {}) as Record<string, unknown>;
    if (isAllowedEnrollmentStatus(courseEnrollmentData.status)) {
      return [`course:${params.uid}`];
    }
  }

  const membershipSnap = await db
    .collectionGroup("students")
    .where("studentId", "==", params.uid)
    .get();
  if (membershipSnap.empty) return [];

  const membershipGroupIds = Array.from(
    new Set(
      membershipSnap.docs
        .map((membershipDoc) => asTrimmedString(membershipDoc.ref.parent.parent?.id))
        .filter((groupId) => groupId.length > 0),
    ),
  );
  if (membershipGroupIds.length === 0) return [];

  const matchedMembershipGroups = await resolveGroupIdsWithCourse(membershipGroupIds);
  return matchedMembershipGroups.map((groupId) => `membership:${groupId}`);
}

export async function resolveAuthorizedLiveClassAccess(params: {
  request: NextRequest;
  classId: string;
  courseId?: string;
  lessonId?: string;
  requireTeacher?: boolean;
}): Promise<{
  user: AuthenticatedUser;
  classContext: LiveClassContext;
  accessRole: AuthorizedLiveAccessRole;
  enrollmentIds: string[];
}> {
  const user = await resolveAuthenticatedUser(params.request);
  const classContext = await resolveLiveClassContext({
    classId: params.classId,
    courseId: params.courseId,
    lessonId: params.lessonId,
  });

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
