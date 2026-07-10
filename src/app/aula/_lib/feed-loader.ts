import type { User } from "firebase/auth";
import type { DocumentData, QueryDocumentSnapshot } from "firebase/firestore";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { isStudentStatusBlocked } from "@/lib/students/status";
import { normalizeLiveSession } from "@/lib/live-classes/types";
import { resolveTeacherAssignmentForCourse } from "@/lib/groups/teacher-assignment";
import { normalizeForumPointValue } from "@/lib/forum-grading";
import { normalizeClassType, trimSafeString } from "./gating";
import type { CourseClosureState, FeedClass } from "./types";

type GlobalExamAssignment = {
  groupId: string;
  courseId: string;
  enabled: boolean;
  status: string;
};

/** Cursos habilitados solo como material de estudio para el examen global. */
const fetchGlobalExamStudyCourseKeys = async (user: User): Promise<Set<string>> => {
  try {
    const token = await user.getIdToken();
    const response = await fetch("/api/global-exams/assignments", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) return new Set<string>();
    const payload = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      data?: GlobalExamAssignment[];
    };
    if (payload.success !== true || !Array.isArray(payload.data)) return new Set<string>();

    const keys = new Set<string>();
    payload.data.forEach((assignment) => {
      const groupId = trimSafeString(assignment.groupId);
      const courseId = trimSafeString(assignment.courseId);
      if (!groupId || !courseId) return;
      if (assignment.status === "disabled") return;
      if (assignment.enabled !== true && assignment.status === "draft") return;
      keys.add(`${groupId}::${courseId}`);
    });
    return keys;
  } catch (error) {
    console.warn("No se pudieron cargar cursos de estudio para examen global:", error);
    return new Set<string>();
  }
};

export const courseClosureKey = (enrollmentId?: string, courseId?: string) =>
  `${enrollmentId ?? ""}::${courseId ?? ""}`;

export type StudentFeed = {
  classes: FeedClass[];
  enrollmentIds: string[];
  primaryEnrollmentId: string | null;
  courseCovers: Record<string, string>;
  courseTitles: Record<string, string>;
  courseClosures: Record<string, CourseClosureState>;
  studentName: string;
};

type EnrollmentDoc = QueryDocumentSnapshot<DocumentData>;

export type StudentEnrollments = {
  regular: EnrollmentDoc[];
  studyOnly: EnrollmentDoc[];
  enrollmentIds: string[];
  primaryEnrollmentId: string;
  studentName: string;
};

const isStudyOnlyEnrollment = (data: DocumentData) =>
  data.studyOnly === true || trimSafeString(data.source) === "globalExamStudy";

/**
 * Primer paso: las inscripciones del alumno. Se separa del contenido para que el
 * progreso (que solo necesita los enrollmentIds) pueda cargarse en paralelo con
 * los cursos, en vez de esperar a que terminen.
 */
export const loadStudentEnrollments = async (
  currentUser: User,
): Promise<StudentEnrollments | null> => {
  let enrollmentSnap = await getDocs(
    query(
      collection(db, "studentEnrollments"),
      where("studentId", "==", currentUser.uid),
      orderBy("enrolledAt", "desc"),
    ),
  );

  // Fallback: derivar la inscripción desde groups/*/students si aún no existe.
  if (enrollmentSnap.empty) {
    try {
      const membershipSnap = await getDocs(
        query(collectionGroup(db, "students"), where("studentId", "==", currentUser.uid), limit(1)),
      );
      if (!membershipSnap.empty) {
        const membership = membershipSnap.docs[0];
        if (!isStudentStatusBlocked(membership.data().status)) {
          const groupIdFromRef = membership.ref.parent.parent?.id;
          if (groupIdFromRef) {
            const groupDoc = await getDoc(doc(db, "groups", groupIdFromRef));
            if (groupDoc.exists()) {
              const gd = groupDoc.data();
              await setDoc(
                doc(db, "studentEnrollments", `${groupIdFromRef}_${currentUser.uid}`),
                {
                  studentId: currentUser.uid,
                  studentName: membership.data().studentName ?? "",
                  studentEmail: membership.data().studentEmail ?? "",
                  groupId: groupIdFromRef,
                  groupName: gd.groupName ?? "",
                  courseId: gd.courseId ?? "",
                  courseName: gd.courseName ?? "",
                  teacherName: gd.teacherName ?? "",
                  status: "active",
                  enrolledAt: gd.updatedAt ?? new Date(),
                  finalGrade: null,
                },
                { merge: true },
              );
              enrollmentSnap = await getDocs(
                query(
                  collection(db, "studentEnrollments"),
                  where("studentId", "==", currentUser.uid),
                  orderBy("enrolledAt", "desc"),
                  limit(1),
                ),
              );
            }
          }
        }
      }
    } catch (err) {
      console.warn("No pude reconstruir enrollment desde students:", err);
    }
  }

  const active = enrollmentSnap.docs.filter(
    (docSnap) => !isStudentStatusBlocked(docSnap.data().status),
  );
  if (active.length === 0) return null;

  const regular = active.filter((docSnap) => !isStudyOnlyEnrollment(docSnap.data()));
  const studyOnly = active.filter((docSnap) => isStudyOnlyEnrollment(docSnap.data()));
  const enrollmentIds = active.map((docSnap) => docSnap.id);

  const studentName =
    active.find((docSnap) => trimSafeString(docSnap.data().studentName))?.data().studentName ??
    currentUser.displayName ??
    "Estudiante";

  return {
    regular,
    studyOnly,
    enrollmentIds,
    primaryEnrollmentId: regular[0]?.id ?? enrollmentIds[0],
    studentName,
  };
};

const captureClosures = (
  enrollment: DocumentData,
  enrollmentId: string,
  target: Record<string, CourseClosureState>,
) => {
  const raw = (enrollment.courseClosures ?? {}) as Record<string, unknown>;
  Object.entries(raw).forEach(([courseIdKey, closureValue]) => {
    if (!closureValue || typeof closureValue !== "object") return;
    const normalizedCourseId = courseIdKey.trim();
    if (!normalizedCourseId) return;
    const closure = closureValue as Record<string, unknown>;
    const status =
      closure.status === "closed" || closure.status === "open" ? closure.status : undefined;
    if (!status) return;
    target[courseClosureKey(enrollmentId, normalizedCourseId)] = {
      status,
      finalGrade:
        typeof closure.finalGrade === "number" && Number.isFinite(closure.finalGrade)
          ? closure.finalGrade
          : undefined,
      manualOverride: closure.manualOverride === true,
    };
  });
};

type CourseTask = {
  groupId: string;
  groupName: string;
  enrollmentId: string;
  isGroupInPerson: boolean;
  courseId: string;
  courseName: string;
  teacherId?: string;
  teacherName?: string;
  isStudyOnlyCourse: boolean;
};

type CourseResult = {
  courseId: string;
  courseTitle: string;
  cover: string;
  classes: FeedClass[];
};

/** Un curso completo: doc, lecciones y las clases de todas sus lecciones a la vez. */
const loadCourseContent = async (task: CourseTask): Promise<CourseResult | null> => {
  const [courseDoc, lessonsSnap] = await Promise.all([
    getDoc(doc(db, "courses", task.courseId)),
    getDocs(query(collection(db, "courses", task.courseId, "lessons"), orderBy("order", "asc"))),
  ]);

  const courseData = courseDoc.exists() ? courseDoc.data() : null;
  if (!courseData || courseData.isArchived) return null;

  const courseTitle = courseData.title ?? task.courseName ?? "Materia";
  const cover =
    (Array.isArray(courseData.imageUrls) ? courseData.imageUrls.find(Boolean) : null) ??
    courseData.imageUrl ??
    courseData.thumbnail ??
    "";

  const lessonResults = await Promise.all(
    lessonsSnap.docs.map(async (lesson) => {
      try {
        const lessonTitle = lesson.data().title ?? "Lección";
        const classesSnap = await getDocs(
          query(
            collection(db, "courses", task.courseId, "lessons", lesson.id, "classes"),
            orderBy("order", "asc"),
          ),
        );

        const lessonClasses: FeedClass[] = [];
        classesSnap.forEach((cls) => {
          const c = cls.data();
          const normType = normalizeClassType(c.type);
          if (task.isStudyOnlyCourse && normType === "quiz") return;
          const imageArray = c.images ?? c.imageUrls ?? (c.imageUrl ? [c.imageUrl] : []);

          lessonClasses.push({
            id: `${task.groupId}_${task.courseId}_${cls.id}`,
            classDocId: cls.id,
            title: c.title ?? "Clase sin título",
            type: normType,
            courseId: task.courseId,
            lessonId: lesson.id,
            enrollmentId: task.enrollmentId,
            groupId: task.groupId,
            groupName: task.groupName,
            groupIsInPerson: task.isGroupInPerson,
            teacherId: task.teacherId,
            teacherName: task.teacherName,
            classTitle: c.title ?? "Clase sin título",
            videoUrl: trimSafeString(c.videoUrl),
            audioUrl: trimSafeString(c.audioUrl),
            content: c.content ?? "",
            images: Array.isArray(imageArray)
              ? imageArray.map((u: unknown) => trimSafeString(u)).filter(Boolean)
              : [],
            hasAssignment: task.isStudyOnlyCourse ? false : (c.hasAssignment ?? false),
            assignmentTemplateUrl: task.isStudyOnlyCourse ? "" : (c.assignmentTemplateUrl ?? ""),
            assignmentSubmissionType: c.assignmentSubmissionType === "audio" ? "audio" : "file",
            isClassroomActivity: c.isClassroomActivity ?? false,
            showInStudentPlatform: c.showInStudentPlatform ?? true,
            lessonTitle,
            lessonName: lessonTitle,
            courseTitle,
            likesCount: c.likesCount ?? 0,
            forumEnabled: task.isStudyOnlyCourse ? false : (c.forumEnabled ?? false),
            forumRequiredFormat: task.isStudyOnlyCourse ? null : (c.forumRequiredFormat ?? null),
            forumPointValue: normalizeForumPointValue(c.forumPointValue),
            liveSession: normalizeLiveSession(c.liveSession),
            studyOnly: task.isStudyOnlyCourse,
          });
        });
        return lessonClasses;
      } catch (lessonErr) {
        console.warn(`Error cargando lección ${lesson.id}, continuando...`, lessonErr);
        return [];
      }
    }),
  );

  // Promise.all preserva el orden de las lecciones, del que depende el gating.
  return { courseId: task.courseId, courseTitle, cover, classes: lessonResults.flat() };
};

export type LoadFeedResult =
  | { status: "ok"; feed: StudentFeed }
  | { status: "empty"; message: string };

/**
 * Segundo paso: el contenido. Grupos, cursos, lecciones y clases se leen en
 * paralelo; el orden final se reconstruye a partir del orden de las inscripciones.
 */
export const loadStudentCourses = async (
  currentUser: User,
  enrollments: StudentEnrollments,
): Promise<LoadFeedResult> => {
  const courseCovers: Record<string, string> = {};
  const courseTitles: Record<string, string> = {};
  const courseClosures: Record<string, CourseClosureState> = {};

  enrollments.regular.forEach((docSnap) => captureClosures(docSnap.data(), docSnap.id, courseClosures));
  enrollments.studyOnly.forEach((docSnap) => captureClosures(docSnap.data(), docSnap.id, courseClosures));

  // La API de exámenes globales y todos los grupos, de una sola vez.
  const [globalExamStudyCourseKeys, groupDocs] = await Promise.all([
    fetchGlobalExamStudyCourseKeys(currentUser),
    Promise.all(
      enrollments.regular.map((enrollmentDoc) =>
        getDoc(doc(db, "groups", enrollmentDoc.data().groupId)).catch((err) => {
          console.warn(`No se pudo leer el grupo del enrollment ${enrollmentDoc.id}:`, err);
          return null;
        }),
      ),
    ),
  ]);

  const regularTasks: CourseTask[] = [];
  enrollments.regular.forEach((enrollmentDoc, index) => {
    const groupDoc = groupDocs[index];
    if (!groupDoc?.exists()) return;

    const groupData = groupDoc.data();
    const groupId = enrollmentDoc.data().groupId;
    const groupName = groupData.groupName ?? "Grupo";
    const isGroupInPerson = groupData.isInPerson === true;

    const coursesArray: Array<{ courseId: string; courseName: string }> =
      Array.isArray(groupData.courses) && groupData.courses.length > 0
        ? groupData.courses
        : groupData.courseId
          ? [{ courseId: groupData.courseId, courseName: groupData.courseName ?? "" }]
          : [];

    coursesArray.forEach((courseEntry) => {
      const assignedTeacher = resolveTeacherAssignmentForCourse({
        groupData: groupData as Record<string, unknown>,
        courseId: courseEntry.courseId,
      });
      regularTasks.push({
        groupId,
        groupName,
        enrollmentId: enrollmentDoc.id,
        isGroupInPerson,
        courseId: courseEntry.courseId,
        courseName: courseEntry.courseName ?? "",
        teacherId: assignedTeacher.teacherId,
        teacherName: assignedTeacher.teacherName,
        isStudyOnlyCourse: globalExamStudyCourseKeys.has(`${groupId}::${courseEntry.courseId}`),
      });
    });
  });

  const renderedRegularCourseIds = new Set(regularTasks.map((task) => task.courseId));

  const studyOnlyTasks: CourseTask[] = [];
  enrollments.studyOnly.forEach((enrollmentDoc) => {
    const enrollment = enrollmentDoc.data();
    const courseId = trimSafeString(enrollment.courseId);
    if (!courseId || renderedRegularCourseIds.has(courseId)) return;
    studyOnlyTasks.push({
      groupId: trimSafeString(enrollment.groupId) || `globalExamStudy:${courseId}`,
      groupName: trimSafeString(enrollment.groupName) || "Modo estudio",
      enrollmentId: enrollmentDoc.id,
      isGroupInPerson: false,
      courseId,
      courseName: trimSafeString(enrollment.courseName),
      isStudyOnlyCourse: true,
    });
  });

  const allTasks = [...regularTasks, ...studyOnlyTasks];
  const results = await Promise.all(
    allTasks.map((task) =>
      loadCourseContent(task).catch((err) => {
        console.warn(`Error cargando curso ${task.courseId}, continuando...`, err);
        return null;
      }),
    ),
  );

  const classes: FeedClass[] = [];
  results.forEach((result) => {
    if (!result) return;
    courseTitles[result.courseId] = result.courseTitle;
    if (result.cover) courseCovers[result.courseId] = result.cover;
    classes.push(...result.classes);
  });

  if (classes.length === 0) {
    return {
      status: "empty",
      message: "Las materias asignadas a tus grupos están archivadas o sin contenido disponible.",
    };
  }

  return {
    status: "ok",
    feed: {
      classes,
      enrollmentIds: enrollments.enrollmentIds,
      primaryEnrollmentId: enrollments.primaryEnrollmentId,
      courseCovers,
      courseTitles,
      courseClosures,
      studentName: enrollments.studentName,
    },
  };
};

export const NO_ENROLLMENTS_MESSAGE =
  "No tienes materias asignadas todavía. Pide a tu profesor que te inscriba en un grupo.";
