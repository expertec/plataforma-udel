import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { createLiveSessionForClass, normalizeLiveSession } from "@/lib/live-classes/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TeacherRole = "teacher" | "adminTeacher" | "superAdminTeacher";

type TeacherLiveStatus =
  | "scheduled"
  | "live"
  | "processing"
  | "ready"
  | "failed"
  | "finalized";

type ScheduleLiveClassBody = {
  groupId?: unknown;
  courseId?: unknown;
  lessonId?: unknown;
  title?: unknown;
  scheduledStartAt?: unknown;
  scheduledEndAt?: unknown;
  timezone?: unknown;
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
  if (value === "teacher" || value === "adminTeacher" || value === "superAdminTeacher") {
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
      value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim()),
    ),
  );
}

function normalizeComparableText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getGroupCourses(
  groupData: Record<string, unknown>,
): Array<{ courseId: string; courseName: string }> {
  if (Array.isArray(groupData.courses)) {
    const courses = groupData.courses
      .map((course) => {
        if (!course || typeof course !== "object" || Array.isArray(course)) return null;
        const courseId = asTrimmedString((course as Record<string, unknown>).courseId);
        if (!courseId) return null;
        return {
          courseId,
          courseName: asTrimmedString((course as Record<string, unknown>).courseName),
        };
      })
      .filter((course): course is { courseId: string; courseName: string } => course !== null);
    if (courses.length > 0) return courses;
  }

  const legacyCourseId = asTrimmedString(groupData.courseId);
  if (!legacyCourseId) return [];
  return [
    {
      courseId: legacyCourseId,
      courseName: asTrimmedString(groupData.courseName),
    },
  ];
}

function getMentorAllowedCourseIds(
  groupData: Record<string, unknown>,
  teacherId: string,
): string[] {
  const groupCourseIds = getGroupCourses(groupData).map((course) => course.courseId);
  const mentorAccess = groupData.mentorCourseAccess;
  if (!mentorAccess || typeof mentorAccess !== "object" || Array.isArray(mentorAccess)) {
    return groupCourseIds;
  }
  if (!Object.prototype.hasOwnProperty.call(mentorAccess, teacherId)) {
    return groupCourseIds;
  }
  const rawAllowed = (mentorAccess as Record<string, unknown>)[teacherId];
  const validCourseIds = new Set(groupCourseIds);
  return asUniqueStringArray(rawAllowed).filter((courseId) => validCourseIds.has(courseId));
}

function deriveTeacherLiveStatus(session: ReturnType<typeof normalizeLiveSession>): TeacherLiveStatus {
  if (!session) return "scheduled";
  if (session.recording.status === "failed") return "failed";
  if (session.status === "recording_ready" || session.recording.status === "ready") {
    return "ready";
  }
  if (session.status === "live" || session.teacherActive === true) {
    return "live";
  }
  if (session.recording.status === "recording" || session.recording.status === "processing") {
    return "processing";
  }
  if (session.status === "ended" || session.lastEndedAt) {
    return "finalized";
  }
  return "scheduled";
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as { toDate?: () => Date };
    if (typeof candidate.toDate === "function") {
      const date = candidate.toDate();
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }
  return null;
}

function toSortMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getLastRelevantAt(session: ReturnType<typeof normalizeLiveSession>, updatedAt: string | null, createdAt: string | null) {
  return (
    session?.recording.playbackReadyAt ??
    session?.lastEndedAt ??
    session?.lastStartedAt ??
    session?.scheduledStartAt ??
    updatedAt ??
    createdAt
  );
}

async function resolveTeacherContext(request: NextRequest): Promise<{
  uid: string;
  role: TeacherRole;
  displayName: string;
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
  const role = asTeacherRole(userData.role) ?? asTeacherRole(decodedToken.role);
  if (!role) {
    throw new RouteAccessError(403, "Acceso restringido a profesores");
  }

  return {
    uid,
    role,
    displayName:
      asTrimmedString(userData.name) ||
      asTrimmedString(userData.displayName) ||
      asTrimmedString(decodedToken.name) ||
      "Profesor",
  };
}

async function resolveTeacherGroups(teacherId: string) {
  const db = getAdminFirestore();
  const [mainGroupsSnap, assistantGroupsSnap] = await Promise.all([
    db.collection("groups").where("teacherId", "==", teacherId).get(),
    db.collection("groups").where("assistantTeacherIds", "array-contains", teacherId).get(),
  ]);

  const groupsById = new Map<
    string,
    {
      groupId: string;
      groupName: string;
      status: string;
      courses: Array<{ courseId: string; courseName: string }>;
    }
  >();

  const consume = (docs: FirebaseFirestore.QueryDocumentSnapshot[], isPrincipal: boolean) => {
    docs.forEach((docSnap) => {
      if (groupsById.has(docSnap.id)) return;
      const data = (docSnap.data() ?? {}) as Record<string, unknown>;
      const allCourses = getGroupCourses(data);
      const allowedCourseIds = isPrincipal
        ? new Set(allCourses.map((course) => course.courseId))
        : new Set(getMentorAllowedCourseIds(data, teacherId));
      const courses = allCourses.filter((course) => allowedCourseIds.has(course.courseId));
      if (courses.length === 0) return;
      groupsById.set(docSnap.id, {
        groupId: docSnap.id,
        groupName: asTrimmedString(data.groupName) || "Grupo",
        status: asTrimmedString(data.status) || "active",
        courses,
      });
    });
  };

  consume(mainGroupsSnap.docs, true);
  consume(assistantGroupsSnap.docs, false);

  return Array.from(groupsById.values()).sort((left, right) =>
    left.groupName.localeCompare(right.groupName, "es"),
  );
}

function toErrorResponse(error: unknown) {
  if (error instanceof RouteAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }

  console.error("Error en live classes teacher route", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const teacher = await resolveTeacherContext(request);
    const teacherGroups = await resolveTeacherGroups(teacher.uid);
    const scheduleGroups = teacherGroups
      .filter((group) => group.status !== "archived")
      .map((group) => ({
        groupId: group.groupId,
        groupName: group.groupName,
        courses: group.courses.map((course) => ({
          courseId: course.courseId,
          courseName: course.courseName || "Materia",
        })),
      }));

    const groupsByCourseId = new Map<string, Array<{ groupId: string; groupName: string }>>();
    teacherGroups.forEach((group) => {
      group.courses.forEach((course) => {
        const current = groupsByCourseId.get(course.courseId) ?? [];
        current.push({ groupId: group.groupId, groupName: group.groupName });
        groupsByCourseId.set(course.courseId, current);
      });
    });

    const courseIds = Array.from(groupsByCourseId.keys());
    const db = getAdminFirestore();
    const items: Array<{
      classId: string;
      courseId: string;
      lessonId: string;
      title: string;
      courseTitle: string;
      lessonTitle: string;
      linkedGroupId: string | null;
      linkedGroupName: string | null;
      sharedGroupNames: string[];
      liveStatus: TeacherLiveStatus;
      sessionStatus: string;
      recordingStatus: string;
      roomName: string | null;
      scheduledStartAt: string | null;
      scheduledEndAt: string | null;
      timezone: string;
      lastStartedAt: string | null;
      lastEndedAt: string | null;
      playbackReadyAt: string | null;
      durationSec: number | null;
      recordingGenerated: boolean;
      createdAt: string | null;
      updatedAt: string | null;
      lastRelevantAt: string | null;
      teacherCreatedById: string | null;
      teacherCreatedByName: string | null;
    }> = [];

    await Promise.all(
      courseIds.map(async (courseId) => {
        const courseRef = db.collection("courses").doc(courseId);
        const courseSnap = await courseRef.get();
        if (!courseSnap.exists) return;
        const courseData = (courseSnap.data() ?? {}) as Record<string, unknown>;
        const courseTeacherId = asTrimmedString(courseData.teacherId);
        const courseTitle = asTrimmedString(courseData.title) || "Materia";

        const lessonsSnap = await courseRef.collection("lessons").orderBy("order", "asc").get();
        await Promise.all(
          lessonsSnap.docs.map(async (lessonDoc) => {
            const lessonData = (lessonDoc.data() ?? {}) as Record<string, unknown>;
            const lessonTitle = asTrimmedString(lessonData.title) || "Lección";
            const classesSnap = await lessonDoc.ref.collection("classes").orderBy("order", "asc").get();

            classesSnap.docs.forEach((classDoc) => {
              const classData = (classDoc.data() ?? {}) as Record<string, unknown>;
              const classType = asTrimmedString(classData.type).toLowerCase();
              const liveSession = normalizeLiveSession(classData.liveSession);
              if (classType !== "live" && !liveSession) return;

              const teacherCreatedById = asTrimmedString(classData.teacherCreatedById) || null;
              if (teacherCreatedById) {
                if (teacherCreatedById !== teacher.uid) return;
              } else if (courseTeacherId !== teacher.uid) {
                return;
              }

              const linkedGroupId = asTrimmedString(classData.linkedGroupId) || null;
              const linkedGroupName = asTrimmedString(classData.linkedGroupName) || null;
              const sharedGroupNames = Array.from(
                new Set((groupsByCourseId.get(courseId) ?? []).map((group) => group.groupName)),
              );
              const createdAt = toIsoString(classData.createdAt);
              const updatedAt = toIsoString(classData.updatedAt);
              const liveStatus = deriveTeacherLiveStatus(liveSession);

              items.push({
                classId: classDoc.id,
                courseId,
                lessonId: lessonDoc.id,
                title: asTrimmedString(classData.title) || "Clase en vivo",
                courseTitle,
                lessonTitle,
                linkedGroupId,
                linkedGroupName,
                sharedGroupNames,
                liveStatus,
                sessionStatus: liveSession?.status ?? "scheduled",
                recordingStatus: liveSession?.recording.status ?? "idle",
                roomName: liveSession?.roomName ?? null,
                scheduledStartAt: liveSession?.scheduledStartAt ?? null,
                scheduledEndAt: liveSession?.scheduledEndAt ?? null,
                timezone: liveSession?.timezone ?? "America/Monterrey",
                lastStartedAt: liveSession?.lastStartedAt ?? null,
                lastEndedAt: liveSession?.lastEndedAt ?? null,
                playbackReadyAt: liveSession?.recording.playbackReadyAt ?? null,
                durationSec: liveSession?.recording.durationSec ?? null,
                recordingGenerated:
                  Boolean(liveSession?.recording.storagePath) ||
                  liveSession?.recording.status === "ready" ||
                  liveSession?.status === "recording_ready",
                createdAt,
                updatedAt,
                lastRelevantAt: getLastRelevantAt(liveSession, updatedAt, createdAt),
                teacherCreatedById,
                teacherCreatedByName: asTrimmedString(classData.teacherCreatedByName) || null,
              });
            });
          }),
        );
      }),
    );

    items.sort((left, right) => {
      const statusPriority: Record<TeacherLiveStatus, number> = {
        live: 0,
        scheduled: 1,
        processing: 2,
        ready: 3,
        finalized: 4,
        failed: 5,
      };
      const priorityDiff = statusPriority[left.liveStatus] - statusPriority[right.liveStatus];
      if (priorityDiff !== 0) return priorityDiff;
      return toSortMs(right.lastRelevantAt) - toSortMs(left.lastRelevantAt);
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          items,
          scheduleGroups,
          fetchedAt: new Date().toISOString(),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const teacher = await resolveTeacherContext(request);
    const body = (await request.json()) as ScheduleLiveClassBody;
    const groupId = asTrimmedString(body?.groupId);
    const courseId = asTrimmedString(body?.courseId);
    const requestedLessonId = asTrimmedString(body?.lessonId);
    const title = asTrimmedString(body?.title);
    const scheduledStartAt = asTrimmedString(body?.scheduledStartAt);
    const scheduledEndAt = asTrimmedString(body?.scheduledEndAt);
    const timezone = asTrimmedString(body?.timezone) || "America/Monterrey";

    if (!groupId || !courseId || !title || !scheduledStartAt) {
      throw new RouteAccessError(400, "groupId, courseId, title y scheduledStartAt son requeridos");
    }

    const startDate = new Date(scheduledStartAt);
    if (Number.isNaN(startDate.getTime())) {
      throw new RouteAccessError(400, "scheduledStartAt inválido");
    }

    if (scheduledEndAt) {
      const endDate = new Date(scheduledEndAt);
      if (Number.isNaN(endDate.getTime())) {
        throw new RouteAccessError(400, "scheduledEndAt inválido");
      }
      if (endDate.getTime() <= startDate.getTime()) {
        throw new RouteAccessError(400, "La fecha final debe ser posterior al inicio");
      }
    }

    const teacherGroups = await resolveTeacherGroups(teacher.uid);
    const selectedGroup = teacherGroups.find((group) => group.groupId === groupId);
    if (!selectedGroup) {
      throw new RouteAccessError(403, "No tienes acceso a ese grupo");
    }

    const selectedCourse = selectedGroup.courses.find((course) => course.courseId === courseId);
    if (!selectedCourse) {
      throw new RouteAccessError(403, "No tienes acceso a esa materia dentro del grupo");
    }

    const db = getAdminFirestore();
    const courseRef = db.collection("courses").doc(courseId);
    const lessonsSnap = await courseRef.collection("lessons").orderBy("order", "asc").get();

    // Si el profesor eligió una lección específica, la usamos (validando que exista
    // en la materia). Si no, caemos al comportamiento previo: la lección "Clases en vivo".
    let lessonRef: (typeof lessonsSnap.docs)[number]["ref"] | null = null;
    let lessonId = "";

    if (requestedLessonId) {
      // Búsqueda directa (no vía lessonsSnap) porque ese query usa orderBy('order')
      // y excluiría lecciones sin ese campo, dando un falso 404.
      const requestedLessonSnap = await courseRef
        .collection("lessons")
        .doc(requestedLessonId)
        .get();
      if (!requestedLessonSnap.exists) {
        throw new RouteAccessError(404, "La lección seleccionada no existe en la materia");
      }
      lessonRef = requestedLessonSnap.ref;
      lessonId = requestedLessonSnap.id;
    }

    const liveLesson = lessonRef
      ? null
      : lessonsSnap.docs.find((lessonDoc) => {
          const lessonData = (lessonDoc.data() ?? {}) as Record<string, unknown>;
          return normalizeComparableText(asTrimmedString(lessonData.title)) === "clases en vivo";
        });

    if (!lessonRef) {
      lessonRef = liveLesson?.ref ?? null;
      lessonId = liveLesson?.id ?? "";
    }

    if (!lessonRef) {
      const maxLessonNumber = lessonsSnap.docs.reduce((acc, lessonDoc) => {
        const value = lessonDoc.data()?.lessonNumber;
        return typeof value === "number" && Number.isFinite(value) ? Math.max(acc, value) : acc;
      }, 0);
      const maxOrder = lessonsSnap.docs.reduce((acc, lessonDoc) => {
        const value = lessonDoc.data()?.order;
        return typeof value === "number" && Number.isFinite(value) ? Math.max(acc, value) : acc;
      }, -1);
      lessonRef = courseRef.collection("lessons").doc();
      lessonId = lessonRef.id;

      const lessonBatch = db.batch();
      lessonBatch.set(lessonRef, {
        lessonNumber: maxLessonNumber + 1,
        title: "Clases en vivo",
        description: "Lección generada automáticamente para la programación de sesiones live.",
        order: maxOrder + 1,
        createdAt: FieldValue.serverTimestamp(),
      });
      lessonBatch.set(
        courseRef,
        {
          lessonsCount: FieldValue.increment(1),
        },
        { merge: true },
      );
      await lessonBatch.commit();
    } else {
      lessonId = lessonRef.id;
    }

    const classesSnap = await lessonRef.collection("classes").orderBy("order", "asc").get();
    const nextOrder = classesSnap.docs.reduce((acc, classDoc) => {
      const value = classDoc.data()?.order;
      return typeof value === "number" && Number.isFinite(value) ? Math.max(acc, value) : acc;
    }, -1) + 1;

    const classRef = lessonRef.collection("classes").doc();
    const liveSession = createLiveSessionForClass({
      courseId,
      lessonId,
      classId: classRef.id,
      input: {
        scheduledStartAt,
        scheduledEndAt: scheduledEndAt || null,
        timezone,
      },
    });

    await classRef.set({
      id: classRef.id,
      title,
      type: "live",
      order: nextOrder,
      duration: null,
      videoUrl: "",
      content: "",
      audioUrl: "",
      imageUrls: [],
      hasAssignment: false,
      assignmentTemplateUrl: "",
      assignmentSubmissionType: "file",
      isClassroomActivity: false,
      showInStudentPlatform: true,
      forumEnabled: false,
      forumRequiredFormat: null,
      liveSession,
      teacherCreatedById: teacher.uid,
      teacherCreatedByName: teacher.displayName,
      linkedGroupId: selectedGroup.groupId,
      linkedGroupName: selectedGroup.groupName,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          classId: classRef.id,
          courseId,
          lessonId,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
