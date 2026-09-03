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

type GroupInfo = {
  id: string;
  groupName: string;
  courseNameMap: Map<string, string>;
};

type CourseClassMeta = {
  id: string;
  classDocId: string;
  className: string;
  classType: string;
  lessonId: string;
  lessonTitle: string;
  courseId: string;
  courseName: string;
  groupId: string;
  groupName: string;
};

type CourseRef = {
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
};

type TimelineEvent = {
  id: string;
  type:
    | "login"
    | "lastLogin"
    | "submission"
    | "graded"
    | "progress"
    | "completed"
    | "liveJoined"
    | "liveLeft";
  at: string;
  title: string;
  description: string;
  groupId?: string;
  groupName?: string;
  courseId?: string;
  courseName?: string;
  classId?: string;
  className?: string;
  value?: number;
};

type CourseProgress = {
  id: string;
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  totalClasses: number;
  completedClasses: number;
  progressAverage: number;
  submissionsCount: number;
  gradedSubmissionsCount: number;
  averageGrade: number | null;
  lastActivityAt: string | null;
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
    new Set(value.map((item) => asTrimmedString(item)).filter((item) => item.length > 0)),
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

function toMillis(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value === "object" && value !== null) {
    if ("toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      try {
        const millis = (value as { toMillis: () => number }).toMillis();
        return Number.isFinite(millis) ? millis : null;
      } catch {
        return null;
      }
    }
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        const millis = (value as { toDate: () => Date }).toDate().getTime();
        return Number.isFinite(millis) ? millis : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function toIsoStringOrNull(value: unknown): string | null {
  const millis = toMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeClassType(value: unknown): string {
  const normalized = asTrimmedString(value).toLowerCase();
  if (normalized === "quiz") return "Quiz";
  if (normalized === "forum") return "Foro";
  if (normalized === "audio") return "Audio";
  if (normalized === "image") return "Imagen";
  if (normalized === "text") return "Texto";
  if (normalized === "live") return "Clase en vivo";
  return "Clase";
}

function buildGroupCourseKey(groupId: string, courseId: string): string {
  return `${groupId.trim()}::${courseId.trim()}`;
}

function parseClassProgressDocId(docId: string): { groupId: string; courseId: string; classDocId: string } | null {
  const parts = docId.split("_").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  return {
    groupId: parts[0],
    courseId: parts[1],
    classDocId: parts.slice(2).join("_"),
  };
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

function toGroupInfo(id: string, data: Record<string, unknown>): GroupInfo {
  return {
    id,
    groupName: asTrimmedString(data.groupName) || "Sin grupo",
    courseNameMap: getCourseNameFromGroupData(data),
  };
}

function extractGroupIdFromDocPath(path: string): string {
  const pathParts = path.split("/");
  return pathParts[0] === "groups" ? pathParts[1] ?? "" : "";
}

function pushEvent(events: TimelineEvent[], event: Omit<TimelineEvent, "at"> & { at: string | null }) {
  if (!event.at) return;
  events.push({ ...event, at: event.at });
}

function touchCourseProgress(courseProgress: CourseProgress, at: string | null) {
  if (!at) return;
  if (!courseProgress.lastActivityAt || Date.parse(at) > Date.parse(courseProgress.lastActivityAt)) {
    courseProgress.lastActivityAt = at;
  }
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

async function assertCanReadStudentActivity(context: RouteContext, studentId: string): Promise<Set<string> | null> {
  if (
    context.role === "adminTeacher" ||
    context.role === "superAdminTeacher" ||
    isLegacyAdminTeacherRole(context.rawRole)
  ) {
    return null;
  }

  if (context.role === "teacher" || !context.role) {
    const teacherGroupIds = await getTeacherScopeGroupIds(context.uid);
    if (teacherGroupIds.size === 0) throw new RouteAccessError(403, "No tienes grupos asignados");

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

async function getGroupsByIds(groupIds: string[]): Promise<Map<string, GroupInfo>> {
  const normalizedGroupIds = Array.from(
    new Set(groupIds.map((groupId) => groupId.trim()).filter(Boolean)),
  );
  const groupsMap = new Map<string, GroupInfo>();
  if (normalizedGroupIds.length === 0) return groupsMap;

  const db = getAdminFirestore();
  for (let i = 0; i < normalizedGroupIds.length; i += 30) {
    const batch = normalizedGroupIds.slice(i, i + 30);
    const snap = await db.collection("groups").where("__name__", "in", batch).get();
    snap.docs.forEach((docSnap) => {
      groupsMap.set(docSnap.id, toGroupInfo(docSnap.id, docSnap.data() as Record<string, unknown>));
    });
  }
  return groupsMap;
}

async function loadCourseClasses(courseId: string, fallbackCourseName: string) {
  const db = getAdminFirestore();
  const [courseSnap, lessonsSnap] = await Promise.all([
    db.collection("courses").doc(courseId).get(),
    db.collection("courses").doc(courseId).collection("lessons").orderBy("order", "asc").get(),
  ]);
  const courseData = (courseSnap.data() ?? {}) as Record<string, unknown>;
  const courseName =
    asTrimmedString(courseData.title) ||
    asTrimmedString(courseData.courseName) ||
    fallbackCourseName ||
    "Sin materia";

  const lessonResults = await Promise.all(
    lessonsSnap.docs.map(async (lessonSnap) => {
      const lessonData = lessonSnap.data() as Record<string, unknown>;
      const classesSnap = await lessonSnap.ref.collection("classes").orderBy("order", "asc").get();
      return classesSnap.docs.map((classSnap) => {
        const classData = classSnap.data() as Record<string, unknown>;
        return {
          classDocId: classSnap.id,
          className: asTrimmedString(classData.title) || "Clase sin título",
          classType: normalizeClassType(classData.type),
          lessonId: lessonSnap.id,
          lessonTitle: asTrimmedString(lessonData.title) || "Lección",
          courseId,
          courseName,
        };
      });
    }),
  );

  return lessonResults.flat();
}

async function buildClassCatalog(courseRefs: CourseRef[]): Promise<Map<string, CourseClassMeta>> {
  const catalog = new Map<string, CourseClassMeta>();
  const courseCache = new Map<string, Awaited<ReturnType<typeof loadCourseClasses>>>();

  for (const courseRef of courseRefs) {
    if (!courseCache.has(courseRef.courseId)) {
      courseCache.set(
        courseRef.courseId,
        await loadCourseClasses(courseRef.courseId, courseRef.courseName || "Sin materia"),
      );
    }
    const classes = courseCache.get(courseRef.courseId) ?? [];
    classes.forEach((classItem) => {
      const id = `${courseRef.groupId}_${courseRef.courseId}_${classItem.classDocId}`;
      catalog.set(id, {
        id,
        ...classItem,
        courseName: classItem.courseName || courseRef.courseName || "Sin materia",
        groupId: courseRef.groupId,
        groupName: courseRef.groupName,
      });
    });
  }

  return catalog;
}

function ensureCourseProgress(
  rows: Map<string, CourseProgress>,
  params: {
    groupId: string;
    groupName: string;
    courseId: string;
    courseName: string;
  },
): CourseProgress {
  const key = buildGroupCourseKey(params.groupId, params.courseId);
  const existing = rows.get(key);
  if (existing) return existing;
  const row: CourseProgress = {
    id: key,
    groupId: params.groupId,
    groupName: params.groupName,
    courseId: params.courseId,
    courseName: params.courseName || "Sin materia",
    totalClasses: 0,
    completedClasses: 0,
    progressAverage: 0,
    submissionsCount: 0,
    gradedSubmissionsCount: 0,
    averageGrade: null,
    lastActivityAt: null,
  };
  rows.set(key, row);
  return row;
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  console.error("Error cargando actividad del alumno:", error);
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
    const allowedGroupIds = await assertCanReadStudentActivity(context, normalizedStudentId);
    const db = getAdminFirestore();

    const [studentSnap, authUser, enrollmentsSnap, archiveSnap] = await Promise.all([
      db.collection("users").doc(normalizedStudentId).get(),
      getAdminAuth().getUser(normalizedStudentId).catch(() => null),
      db.collection("studentEnrollments").where("studentId", "==", normalizedStudentId).get(),
      db.collection("studentEnrollmentsArchive").where("studentId", "==", normalizedStudentId).get(),
    ]);

    const studentData = (studentSnap.data() ?? {}) as Record<string, unknown>;
    const groupIds = new Set<string>();
    const enrollmentDocs = [...enrollmentsSnap.docs, ...archiveSnap.docs].filter((docSnap) => {
      const groupId = asTrimmedString((docSnap.data() as Record<string, unknown>).groupId);
      if (!groupId) return false;
      if (allowedGroupIds && !allowedGroupIds.has(groupId)) return false;
      groupIds.add(groupId);
      return true;
    });

    const submissions: Array<{
      id: string;
      refPath: string;
      groupId: string;
      data: Record<string, unknown>;
    }> = [];

    if (allowedGroupIds === null) {
      const submissionsSnap = await db
        .collectionGroup("submissions")
        .where("studentId", "==", normalizedStudentId)
        .get();
      submissionsSnap.docs.forEach((docSnap) => {
        const groupId = extractGroupIdFromDocPath(docSnap.ref.path);
        if (!groupId) return;
        groupIds.add(groupId);
        submissions.push({
          id: docSnap.id,
          refPath: docSnap.ref.path,
          groupId,
          data: docSnap.data() as Record<string, unknown>,
        });
      });
    } else {
      await Promise.all(
        Array.from(groupIds).map(async (groupId) => {
          const snap = await db
            .collection("groups")
            .doc(groupId)
            .collection("submissions")
            .where("studentId", "==", normalizedStudentId)
            .get();
          snap.docs.forEach((docSnap) => {
            submissions.push({
              id: docSnap.id,
              refPath: docSnap.ref.path,
              groupId,
              data: docSnap.data() as Record<string, unknown>,
            });
          });
        }),
      );
    }

    const groupsMap = await getGroupsByIds(Array.from(groupIds));
    const courseRefsByKey = new Map<string, CourseRef>();
    const addCourseRef = (params: Partial<CourseRef>) => {
      const groupId = asTrimmedString(params.groupId);
      const courseId = asTrimmedString(params.courseId);
      if (!groupId || !courseId) return;
      const group = groupsMap.get(groupId);
      const key = buildGroupCourseKey(groupId, courseId);
      const previous = courseRefsByKey.get(key);
      courseRefsByKey.set(key, {
        groupId,
        groupName:
          asTrimmedString(params.groupName) ||
          previous?.groupName ||
          group?.groupName ||
          "Sin grupo",
        courseId,
        courseName:
          asTrimmedString(params.courseName) ||
          previous?.courseName ||
          group?.courseNameMap.get(courseId) ||
          "Sin materia",
      });
    };

    groupsMap.forEach((group) => {
      group.courseNameMap.forEach((courseName, courseId) => {
        addCourseRef({
          groupId: group.id,
          groupName: group.groupName,
          courseId,
          courseName,
        });
      });
    });
    enrollmentDocs.forEach((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      const groupId = asTrimmedString(data.groupId);
      const groupName = asTrimmedString(data.groupName);
      const directCourseId = asTrimmedString(data.courseId);
      const directCourseName = asTrimmedString(data.courseName);
      addCourseRef({ groupId, groupName, courseId: directCourseId, courseName: directCourseName });

      const closures = (data.courseClosures ?? {}) as Record<string, unknown>;
      Object.entries(closures).forEach(([courseIdRaw, closureRaw]) => {
        const closure = closureRaw && typeof closureRaw === "object" ? (closureRaw as Record<string, unknown>) : {};
        addCourseRef({
          groupId,
          groupName,
          courseId: courseIdRaw,
          courseName: asTrimmedString(closure.courseName) || directCourseName,
        });
      });
    });
    submissions.forEach((submission) => {
      const groupInfo = groupsMap.get(submission.groupId);
      const courseId = asTrimmedString(submission.data.courseId);
      addCourseRef({
        groupId: submission.groupId,
        groupName: groupInfo?.groupName,
        courseId,
        courseName: asTrimmedString(submission.data.courseTitle) || asTrimmedString(submission.data.courseName),
      });
    });

    const progressDocResults = await Promise.allSettled(
      enrollmentDocs.map(async (enrollmentSnap) => {
        const enrollmentData = enrollmentSnap.data() as Record<string, unknown>;
        const groupId = asTrimmedString(enrollmentData.groupId);
        const groupName = asTrimmedString(enrollmentData.groupName);
        const snap = await enrollmentSnap.ref.collection("classProgress").get();
        return { groupId, groupName, docs: snap.docs };
      }),
    );
    progressDocResults.forEach((result) => {
      if (result.status !== "fulfilled") return;
      result.value.docs.forEach((progressDoc) => {
        const parsed = parseClassProgressDocId(progressDoc.id);
        if (!parsed) return;
        addCourseRef({
          groupId: parsed.groupId,
          groupName: result.value.groupName,
          courseId: parsed.courseId,
        });
      });
    });

    const classCatalog = await buildClassCatalog(Array.from(courseRefsByKey.values()));
    const progressRows = new Map<string, CourseProgress>();
    const progressSums = new Map<string, { totalPct: number; completedIds: Set<string>; progressByClass: Map<string, number> }>();
    const gradeSums = new Map<string, { count: number; sum: number }>();
    const events: TimelineEvent[] = [];

    courseRefsByKey.forEach((courseRef) => {
      ensureCourseProgress(progressRows, courseRef);
    });

    classCatalog.forEach((classMeta) => {
      const row = ensureCourseProgress(progressRows, classMeta);
      row.totalClasses += 1;
    });

    const lastLoginAt = authUser?.metadata.lastSignInTime ?? null;
    const loginEventsSnap = await db
      .collection("users")
      .doc(normalizedStudentId)
      .collection("activityEvents")
      .orderBy("createdAt", "desc")
      .get()
      .catch(() => null);
    let loggedLoginEvents = 0;
    loginEventsSnap?.docs.forEach((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      if (asTrimmedString(data.type) !== "login") return;
      loggedLoginEvents += 1;
      pushEvent(events, {
        id: `login-${docSnap.id}`,
        type: "login",
        at: toIsoStringOrNull(data.createdAt),
        title: "Ingreso a la plataforma",
        description: asTrimmedString(data.userAgent) || "Entrada a la plataforma",
      });
    });
    if (loggedLoginEvents === 0) {
      pushEvent(events, {
        id: "auth-last-login",
        type: "lastLogin",
        at: lastLoginAt,
        title: "Último inicio de sesión",
        description: "Registro de Firebase Auth",
      });
    }

    progressDocResults.forEach((result) => {
      if (result.status !== "fulfilled") return;
      result.value.docs.forEach((progressDoc) => {
        const data = progressDoc.data() as Record<string, unknown>;
        const classMeta = classCatalog.get(progressDoc.id);
        const parsedProgressId = parseClassProgressDocId(progressDoc.id);
        const progress = Math.max(0, Math.min(100, toNumberOrNull(data.progress) ?? 0));
        const completed = data.completed === true || data.seen === true || progress >= 80;
        const courseId = classMeta?.courseId ?? parsedProgressId?.courseId ?? "";
        const groupId = classMeta?.groupId ?? parsedProgressId?.groupId ?? result.value.groupId;
        const groupInfo = groupsMap.get(groupId) ?? groupsMap.get(result.value.groupId);
        const courseRef = courseRefsByKey.get(buildGroupCourseKey(groupId, courseId));
        const courseName = classMeta?.courseName ?? courseRef?.courseName ?? "Sin materia";
        const groupName = classMeta?.groupName ?? groupInfo?.groupName ?? result.value.groupName ?? "Sin grupo";
        const row = ensureCourseProgress(progressRows, { groupId, groupName, courseId, courseName });
        const key = row.id;
        const agg =
          progressSums.get(key) ?? { totalPct: 0, completedIds: new Set<string>(), progressByClass: new Map<string, number>() };
        const previousProgress = agg.progressByClass.get(progressDoc.id) ?? 0;
        agg.totalPct += progress - previousProgress;
        agg.progressByClass.set(progressDoc.id, Math.max(previousProgress, progress));
        if (completed) agg.completedIds.add(progressDoc.id);
        progressSums.set(key, agg);
        row.completedClasses = agg.completedIds.size;
        row.progressAverage = row.totalClasses > 0 ? Math.round(agg.totalPct / row.totalClasses) : Math.round(progress);

        const updatedAt = toIsoStringOrNull(data.lastUpdated ?? data.updatedAt);
        const completedAt = toIsoStringOrNull(data.completedAt);
        touchCourseProgress(row, updatedAt);
        touchCourseProgress(row, completedAt);

        pushEvent(events, {
          id: `progress-${progressDoc.ref.path}`,
          type: "progress",
          at: updatedAt,
          title: `Avance de clase ${Math.round(progress)}%`,
          description: classMeta?.className ?? "Clase registrada",
          groupId,
          groupName,
          courseId,
          courseName,
          classId: progressDoc.id,
          className: classMeta?.className,
          value: progress,
        });
        if (completedAt) {
          pushEvent(events, {
            id: `completed-${progressDoc.ref.path}`,
            type: "completed",
            at: completedAt,
            title: "Clase completada",
            description: classMeta?.className ?? "Clase registrada",
            groupId,
            groupName,
            courseId,
            courseName,
            classId: progressDoc.id,
            className: classMeta?.className,
            value: 100,
          });
        }
      });
    });

    submissions.forEach((submission) => {
      const data = submission.data;
      const groupInfo = groupsMap.get(submission.groupId);
      const courseId = asTrimmedString(data.courseId);
      const courseName =
        asTrimmedString(data.courseTitle) ||
        groupInfo?.courseNameMap.get(courseId) ||
        asTrimmedString(data.courseName) ||
        "Sin materia";
      const row = ensureCourseProgress(progressRows, {
        groupId: submission.groupId,
        groupName: groupInfo?.groupName ?? "Sin grupo",
        courseId,
        courseName,
      });
      row.submissionsCount += 1;
      const grade = toNumberOrNull(data.grade);
      if (data.status === "graded" || grade !== null) row.gradedSubmissionsCount += 1;
      if (grade !== null) {
        const current = gradeSums.get(row.id) ?? { count: 0, sum: 0 };
        current.count += 1;
        current.sum += grade;
        gradeSums.set(row.id, current);
        row.averageGrade = current.sum / current.count;
      }

      const submittedAt = toIsoStringOrNull(data.submittedAt);
      const gradedAt = toIsoStringOrNull(data.gradedAt);
      touchCourseProgress(row, submittedAt);
      touchCourseProgress(row, gradedAt);
      pushEvent(events, {
        id: `submission-${submission.refPath}`,
        type: "submission",
        at: submittedAt,
        title: "Entrega enviada",
        description: asTrimmedString(data.className) || "Actividad entregada",
        groupId: submission.groupId,
        groupName: row.groupName,
        courseId,
        courseName,
        classId: asTrimmedString(data.classId),
        className: asTrimmedString(data.className),
        value: grade ?? undefined,
      });
      pushEvent(events, {
        id: `graded-${submission.refPath}`,
        type: "graded",
        at: gradedAt,
        title: grade === null ? "Entrega calificada" : `Calificación ${grade}`,
        description: asTrimmedString(data.className) || "Actividad calificada",
        groupId: submission.groupId,
        groupName: row.groupName,
        courseId,
        courseName,
        classId: asTrimmedString(data.classId),
        className: asTrimmedString(data.className),
        value: grade ?? undefined,
      });
    });

    const allowedCourseIds =
      allowedGroupIds === null
        ? null
        : new Set(
            Array.from(groupsMap.values()).flatMap((group) => Array.from(group.courseNameMap.keys())),
          );
    const attendanceSnap = await db
      .collectionGroup("attendance")
      .where("studentId", "==", normalizedStudentId)
      .get()
      .catch(() => null);

    attendanceSnap?.docs.forEach((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      const courseId = asTrimmedString(data.courseId);
      if (allowedCourseIds && !allowedCourseIds.has(courseId)) return;
      const classKey = Array.from(classCatalog.keys()).find((key) => {
        const meta = classCatalog.get(key);
        return meta?.courseId === courseId && meta.classDocId === asTrimmedString(data.classId);
      });
      const classMeta = classKey ? classCatalog.get(classKey) : undefined;
      const group =
        classMeta?.groupId && groupsMap.has(classMeta.groupId)
          ? groupsMap.get(classMeta.groupId)
          : Array.from(groupsMap.values()).find((groupInfo) => groupInfo.courseNameMap.has(courseId));
      const courseName =
        classMeta?.courseName ||
        group?.courseNameMap.get(courseId) ||
        asTrimmedString(data.courseName) ||
        "Sin materia";
      const groupId = classMeta?.groupId ?? group?.id ?? "";
      const groupName = classMeta?.groupName ?? group?.groupName ?? "Sin grupo";
      const row = ensureCourseProgress(progressRows, { groupId, groupName, courseId, courseName });
      const joinedAt = toIsoStringOrNull(data.firstJoinedAt);
      const leftAt = toIsoStringOrNull(data.lastLeftAt);
      touchCourseProgress(row, joinedAt);
      touchCourseProgress(row, leftAt);
      pushEvent(events, {
        id: `live-joined-${docSnap.ref.path}`,
        type: "liveJoined",
        at: joinedAt,
        title: "Se conectó a clase en vivo",
        description: classMeta?.className ?? "Clase en vivo",
        groupId,
        groupName,
        courseId,
        courseName,
        classId: asTrimmedString(data.classId),
        className: classMeta?.className,
        value: toNumberOrNull(data.joinCount) ?? undefined,
      });
      pushEvent(events, {
        id: `live-left-${docSnap.ref.path}`,
        type: "liveLeft",
        at: leftAt,
        title: "Salió de clase en vivo",
        description: `${classMeta?.className ?? "Clase en vivo"}${
          toNumberOrNull(data.totalSeconds) ? ` · ${Math.round((toNumberOrNull(data.totalSeconds) ?? 0) / 60)} min` : ""
        }`,
        groupId,
        groupName,
        courseId,
        courseName,
        classId: asTrimmedString(data.classId),
        className: classMeta?.className,
        value: toNumberOrNull(data.totalSeconds) ?? undefined,
      });
    });

    const courseProgress = Array.from(progressRows.values())
      .map((row) => ({
        ...row,
        progressAverage: Math.max(0, Math.min(100, Math.round(row.progressAverage))),
        averageGrade: row.averageGrade === null ? null : Math.round(row.averageGrade * 10) / 10,
      }))
      .sort((left, right) => {
        const rightMs = right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0;
        const leftMs = left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0;
        return rightMs - leftMs || left.courseName.localeCompare(right.courseName);
      });

    const timeline = events
      .filter((event) => Number.isFinite(Date.parse(event.at)))
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

    return NextResponse.json(
      {
        success: true,
        data: {
          student: {
            id: normalizedStudentId,
            name: asTrimmedString(studentData.displayName) || asTrimmedString(studentData.name) || "Alumno",
            email: asTrimmedString(studentData.email),
          },
          summary: {
            courses: courseProgress.length,
            totalClasses: courseProgress.reduce((acc, row) => acc + row.totalClasses, 0),
            completedClasses: courseProgress.reduce((acc, row) => acc + row.completedClasses, 0),
            submissions: courseProgress.reduce((acc, row) => acc + row.submissionsCount, 0),
            lastActivityAt: timeline[0]?.at ?? lastLoginAt,
          },
          courseProgress,
          timeline,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
