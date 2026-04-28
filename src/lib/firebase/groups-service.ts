import {
  DocumentData,
  addDoc,
  arrayUnion,
  collection,
  doc,
  getDocs,
  increment,
  limit,
  orderBy,
  QueryConstraint,
  query,
  serverTimestamp,
  Timestamp,
  where,
  getDoc,
  getDocFromServer,
  writeBatch,
  updateDoc,
  QuerySnapshot,
  QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { doc as firestoreDoc } from "firebase/firestore";

export type Group = {
  id: string;
  courseId: string;
  courseName: string;
  program?: string;
  plantelId?: string;
  plantelName?: string;
  courses?: Array<{ courseId: string; courseName: string }>;
  courseIds?: string[];
  groupName: string;
  teacherId: string;
  teacherName: string;
  assistantTeacherIds?: string[];
  assistantTeachers?: Array<{ id: string; name: string; email?: string }>;
  mentorCourseAccess?: Record<string, string[]>;
  semester: string;
  startDate?: Date | null;
  endDate?: Date | null;
  status: "active" | "finished" | "archived";
  studentsCount: number;
  maxStudents: number;
  isInPerson?: boolean;
  enableCampusTasksGrade?: boolean;
  enableCampusFinalExamGrade?: boolean;
  enableGlobalExamGrade?: boolean;
  enableExtraordinaryExamGrade?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

type CreateGroupData = {
  courseId?: string;
  courseName?: string;
  program?: string;
  plantelId?: string;
  plantelName?: string;
  courses?: Array<{ courseId: string; courseName: string }>;
  courseIds?: string[];
  groupName: string;
  teacherId: string;
  teacherName: string;
  semester?: string;
  startDate?: Date;
  endDate?: Date;
  maxStudents: number;
  isInPerson?: boolean;
  enableCampusTasksGrade?: boolean;
  enableCampusFinalExamGrade?: boolean;
  enableGlobalExamGrade?: boolean;
  enableExtraordinaryExamGrade?: boolean;
};

type MentorCourseAccessMap = Record<string, string[]>;

const toUniqueStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      ),
    ),
  );
};

const toDateFromUnknown = (value: unknown): Date | null => {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "object") {
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        const maybeDate = (value as { toDate: () => Date }).toDate();
        return Number.isNaN(maybeDate.getTime()) ? null : maybeDate;
      } catch {
        return null;
      }
    }

    const seconds = (value as { seconds?: unknown }).seconds;
    const nanoseconds = (value as { nanoseconds?: unknown }).nanoseconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      const nanos = typeof nanoseconds === "number" && Number.isFinite(nanoseconds) ? nanoseconds : 0;
      const millis = Math.trunc(seconds * 1000 + nanos / 1_000_000);
      const parsed = new Date(millis);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return null;

    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      const year = Number(iso[1]);
      const month = Number(iso[2]);
      const day = Number(iso[3]);
      const parsed = new Date(year, month - 1, day);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const day = Number(slash[1]);
      const month = Number(slash[2]);
      const year = Number(slash[3]);
      const parsed = new Date(year, month - 1, day);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

const toGroupCourses = (data: DocumentData): Array<{ courseId: string; courseName: string }> => {
  if (Array.isArray(data.courses)) {
    const courses = data.courses
      .map((course) => {
        if (!course || typeof course !== "object") return null;
        const c = course as { courseId?: unknown; courseName?: unknown };
        const courseId = typeof c.courseId === "string" ? c.courseId : "";
        if (!courseId) return null;
        return {
          courseId,
          courseName: typeof c.courseName === "string" ? c.courseName : "",
        };
      })
      .filter((course): course is { courseId: string; courseName: string } => course !== null);
    if (courses.length > 0) return courses;
  }
  const legacyCourseId = typeof data.courseId === "string" ? data.courseId : "";
  if (legacyCourseId) {
    return [
      {
        courseId: legacyCourseId,
        courseName: typeof data.courseName === "string" ? data.courseName : "",
      },
    ];
  }
  return [];
};

const toGroupCourseIds = (
  data: DocumentData,
  courses: Array<{ courseId: string; courseName: string }> = toGroupCourses(data),
): string[] => {
  const explicitIds = toUniqueStringArray(data.courseIds);
  if (explicitIds.length > 0) return explicitIds;
  if (courses.length > 0) {
    return Array.from(new Set(courses.map((course) => course.courseId)));
  }
  const legacyCourseId = typeof data.courseId === "string" ? data.courseId : "";
  return legacyCourseId ? [legacyCourseId] : [];
};

const normalizeMentorCourseAccess = (
  value: unknown,
  validCourseIds: string[],
): MentorCourseAccessMap => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const validIds = new Set(validCourseIds);
  const next: MentorCourseAccessMap = {};
  Object.entries(value as Record<string, unknown>).forEach(([mentorId, rawIds]) => {
    if (!mentorId) return;
    const ids = toUniqueStringArray(rawIds).filter((id) => validIds.has(id));
    next[mentorId] = ids;
  });
  return next;
};

const buildMentorCourseAccess = (params: {
  mentorIds: string[];
  existingAccess: MentorCourseAccessMap;
  validCourseIds: string[];
}): MentorCourseAccessMap => {
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
};

const mapCourseMentorsByAccess = (
  courseIds: string[],
  mentorIds: string[],
  mentorCourseAccess: MentorCourseAccessMap,
): Record<string, string[]> => {
  const next: Record<string, string[]> = {};
  courseIds.forEach((courseId) => {
    next[courseId] = mentorIds.filter((mentorId) => {
      if (!Object.prototype.hasOwnProperty.call(mentorCourseAccess, mentorId)) return true;
      return mentorCourseAccess[mentorId]?.includes(courseId) ?? false;
    });
  });
  return next;
};

const toGroup = (id: string, data: DocumentData): Group => {
  const courses = toGroupCourses(data);
  const courseIds = toGroupCourseIds(data, courses);
  return {
    id,
    courseId: typeof data.courseId === "string" ? data.courseId : "",
    courseName: typeof data.courseName === "string" ? data.courseName : "",
    program: typeof data.program === "string" ? data.program : "",
    plantelId: typeof data.plantelId === "string" ? data.plantelId : "",
    plantelName: typeof data.plantelName === "string" ? data.plantelName : "",
    courses,
    courseIds,
    groupName: typeof data.groupName === "string" ? data.groupName : "",
    teacherId: typeof data.teacherId === "string" ? data.teacherId : "",
    teacherName: typeof data.teacherName === "string" ? data.teacherName : "",
    assistantTeacherIds: toUniqueStringArray(data.assistantTeacherIds),
    assistantTeachers: Array.isArray(data.assistantTeachers)
      ? data.assistantTeachers.reduce<Array<{ id: string; name: string; email?: string }>>(
          (acc, teacher) => {
            if (!teacher || typeof teacher !== "object") return acc;
            const item = teacher as { id?: unknown; name?: unknown; email?: unknown };
            const teacherId = typeof item.id === "string" ? item.id : "";
            if (!teacherId) return acc;
            const normalized: { id: string; name: string; email?: string } = {
              id: teacherId,
              name: typeof item.name === "string" ? item.name : "",
            };
            if (typeof item.email === "string" && item.email.trim().length > 0) {
              normalized.email = item.email;
            }
            acc.push(normalized);
            return acc;
          },
          [],
        )
      : [],
    mentorCourseAccess: normalizeMentorCourseAccess(data.mentorCourseAccess, courseIds),
    semester: typeof data.semester === "string" ? data.semester : "",
    startDate: toDateFromUnknown(data.startDate),
    endDate: toDateFromUnknown(data.endDate),
    status:
      data.status === "finished" || data.status === "archived" || data.status === "active"
        ? data.status
        : "active",
    studentsCount: typeof data.studentsCount === "number" ? data.studentsCount : 0,
    maxStudents: typeof data.maxStudents === "number" ? data.maxStudents : 0,
    isInPerson: data.isInPerson === true,
    enableCampusTasksGrade: data.enableCampusTasksGrade === true,
    enableCampusFinalExamGrade: data.enableCampusFinalExamGrade === true,
    enableGlobalExamGrade: data.enableGlobalExamGrade === true,
    enableExtraordinaryExamGrade: data.enableExtraordinaryExamGrade === true,
    createdAt: data.createdAt?.toDate?.(),
    updatedAt: data.updatedAt?.toDate?.(),
  };
};

export async function createGroup(data: CreateGroupData): Promise<string> {
  const ref = collection(db, "groups");
  const coursesList = Array.isArray(data.courses) ? data.courses : [];
  const initialIds =
    data.courseIds && data.courseIds.length > 0
      ? data.courseIds
      : coursesList.map((c) => c.courseId);
  const courseIdsList = Array.from(new Set(initialIds.filter(Boolean)));
  const primaryCourseId = data.courseId ?? courseIdsList[0] ?? coursesList[0]?.courseId ?? "";
  const primaryCourseName =
    data.courseName ??
    coursesList.find((c) => c.courseId === primaryCourseId)?.courseName ??
    coursesList[0]?.courseName ??
    "";
  const docRef = await addDoc(ref, {
    courseId: primaryCourseId,
    courseName: primaryCourseName,
    program: data.program ?? "",
    plantelId: data.plantelId ?? "",
    plantelName: data.plantelName ?? "",
    courses: coursesList,
    courseIds: courseIdsList,
    groupName: data.groupName,
    teacherId: data.teacherId,
    teacherName: data.teacherName,
    assistantTeacherIds: [],
    assistantTeachers: [],
    mentorCourseAccess: {},
    semester: data.semester ?? "",
    startDate: data.startDate ? Timestamp.fromDate(data.startDate) : null,
    endDate: data.endDate ? Timestamp.fromDate(data.endDate) : null,
    status: "active",
    studentsCount: 0,
    maxStudents: data.maxStudents,
    isInPerson: data.isInPerson === true,
    enableCampusTasksGrade: data.enableCampusTasksGrade === true,
    enableCampusFinalExamGrade: data.enableCampusFinalExamGrade === true,
    enableGlobalExamGrade: data.enableGlobalExamGrade === true,
    enableExtraordinaryExamGrade: data.enableExtraordinaryExamGrade === true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function updateGroupCampusGradeSettings(params: {
  groupId: string;
  enableCampusTasksGrade: boolean;
  enableCampusFinalExamGrade: boolean;
  enableGlobalExamGrade: boolean;
  enableExtraordinaryExamGrade: boolean;
}): Promise<void> {
  const {
    groupId,
    enableCampusTasksGrade,
    enableCampusFinalExamGrade,
    enableGlobalExamGrade,
    enableExtraordinaryExamGrade,
  } = params;
  if (!groupId) return;
  await updateDoc(doc(db, "groups", groupId), {
    enableCampusTasksGrade: Boolean(enableCampusTasksGrade),
    enableCampusFinalExamGrade: Boolean(enableCampusFinalExamGrade),
    enableGlobalExamGrade: Boolean(enableGlobalExamGrade),
    enableExtraordinaryExamGrade: Boolean(enableExtraordinaryExamGrade),
    updatedAt: serverTimestamp(),
  });
}

export async function updateGroupInPersonMode(params: {
  groupId: string;
  isInPerson: boolean;
}): Promise<void> {
  const { groupId, isInPerson } = params;
  if (!groupId) return;
  await updateDoc(doc(db, "groups", groupId), {
    isInPerson: Boolean(isInPerson),
    updatedAt: serverTimestamp(),
  });
}

export async function updateGroupPlantel(params: {
  groupId: string;
  plantelId: string;
  plantelName: string;
}): Promise<void> {
  const groupId = params.groupId.trim();
  const plantelId = params.plantelId.trim();
  const plantelName = params.plantelName.trim();
  if (!groupId || !plantelId || !plantelName) {
    throw new Error("Grupo y plantel son requeridos");
  }

  const groupRef = doc(db, "groups", groupId);
  const studentsSnap = await getDocs(collection(db, "groups", groupId, "students"));
  const enrollmentsSnap = await getDocs(
    query(collection(db, "studentEnrollments"), where("groupId", "==", groupId)),
  );
  const studentIds = new Set<string>();
  studentsSnap.docs.forEach((studentDoc) => studentIds.add(studentDoc.id));
  enrollmentsSnap.docs.forEach((enrollmentDoc) => {
    const data = enrollmentDoc.data();
    if (typeof data.studentId === "string" && data.studentId.trim()) {
      studentIds.add(data.studentId.trim());
    }
  });

  const batch = writeBatch(db);
  batch.update(groupRef, {
    plantelId,
    plantelName,
    updatedAt: serverTimestamp(),
  });
  studentsSnap.docs.forEach((studentDoc) => {
    batch.update(studentDoc.ref, {
      plantelId,
      plantelName,
      updatedAt: serverTimestamp(),
    });
  });
  enrollmentsSnap.docs.forEach((enrollmentDoc) => {
    batch.update(enrollmentDoc.ref, {
      plantelId,
      plantelName,
      updatedAt: serverTimestamp(),
    });
  });
  await batch.commit();
  await syncStudentPlantelAccess(Array.from(studentIds));
}

export async function getGroups(teacherId: string): Promise<Group[]> {
  const ref = collection(db, "groups");
  const q = query(ref, where("teacherId", "==", teacherId), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => toGroup(docSnap.id, docSnap.data()));
}

export async function getAllGroups(maxResults?: number): Promise<Group[]> {
  const ref = collection(db, "groups");
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc")];
  if (typeof maxResults === "number" && maxResults > 0) {
    constraints.push(limit(maxResults));
  }
  const snap = await getDocs(query(ref, ...constraints));
  return snap.docs.map((docSnap) => toGroup(docSnap.id, docSnap.data()));
}

const sortGroupsByCreatedAtDesc = (groups: Group[]): Group[] =>
  [...groups].sort(
    (a, b) => (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0),
  );

export async function getGroupsByPlantel(plantelId: string, maxResults?: number): Promise<Group[]> {
  const normalizedPlantelId = plantelId.trim();
  if (!normalizedPlantelId) return [];
  const snap = await getDocs(
    query(collection(db, "groups"), where("plantelId", "==", normalizedPlantelId)),
  );
  const groups = sortGroupsByCreatedAtDesc(
    snap.docs.map((docSnap) => toGroup(docSnap.id, docSnap.data())),
  );
  return typeof maxResults === "number" && maxResults > 0 ? groups.slice(0, maxResults) : groups;
}

export async function getActiveGroupsByPlantel(plantelId: string, maxResults?: number): Promise<Group[]> {
  const groups = await getGroupsByPlantel(plantelId, maxResults);
  return groups.filter((group) => group.status === "active");
}

export async function getGroup(groupId: string): Promise<Group | null> {
  const ref = doc(db, "groups", groupId);
  let snap;
  try {
    snap = await getDocFromServer(ref);
  } catch {
    snap = await getDoc(ref);
  }
  if (!snap.exists()) return null;
  return toGroup(snap.id, snap.data());
}

export async function getGroupsByCourse(courseId: string, teacherId?: string, plantelId?: string): Promise<Group[]> {
  const ref = collection(db, "groups");
  const constraintsBase: QueryConstraint[] = plantelId ? [] : [orderBy("createdAt", "desc")];
  const constraintsByCourseId: QueryConstraint[] = [where("courseId", "==", courseId), ...constraintsBase];
  const constraintsByArray: QueryConstraint[] = [where("courseIds", "array-contains", courseId), ...constraintsBase];
  if (teacherId) {
    constraintsByCourseId.push(where("teacherId", "==", teacherId));
    constraintsByArray.push(where("teacherId", "==", teacherId));
  }
  if (plantelId) {
    constraintsByCourseId.push(where("plantelId", "==", plantelId));
    constraintsByArray.push(where("plantelId", "==", plantelId));
  }

  // Ejecutar ambas consultas para cubrir documentos antiguos (courseId) y nuevos (courseIds)
  const [snapCourseId, snapArray] = await Promise.all([
    getDocs(query(ref, ...constraintsByCourseId)),
    getDocs(query(ref, ...constraintsByArray)),
  ]);
  const map = new Map<string, Group>();
  const consume = (snap: QuerySnapshot<DocumentData>) => {
    snap.docs.forEach((docSnap: QueryDocumentSnapshot<DocumentData>) => {
      map.set(docSnap.id, toGroup(docSnap.id, docSnap.data()));
    });
  };
  consume(snapCourseId);
  consume(snapArray);
  return sortGroupsByCreatedAtDesc(Array.from(map.values()));
}

export async function getActiveGroups(teacherId?: string, plantelId?: string): Promise<Group[]> {
  if (plantelId) {
    return getActiveGroupsByPlantel(plantelId);
  }
  const ref = collection(db, "groups");
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc")];
  if (teacherId) {
    constraints.push(where("teacherId", "==", teacherId));
  }
  const snap = await getDocs(query(ref, ...constraints));
  return snap.docs
    .map((docSnap) => toGroup(docSnap.id, docSnap.data()))
    .filter((g) => g.status === "active");
}

async function syncStudentPlantelAccess(studentIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(studentIds.filter(Boolean)));
  await Promise.all(
    uniqueIds.map(async (studentId) => {
      try {
        const enrollmentsSnap = await getDocs(
          query(collection(db, "studentEnrollments"), where("studentId", "==", studentId)),
        );
        const plantelNameById = new Map<string, string>();
        enrollmentsSnap.docs.forEach((enrollmentDoc) => {
          const data = enrollmentDoc.data();
          if (data.status && data.status !== "active") return;
          const plantelId = typeof data.plantelId === "string" ? data.plantelId.trim() : "";
          if (!plantelId) return;
          const plantelName = typeof data.plantelName === "string" ? data.plantelName.trim() : "";
          plantelNameById.set(plantelId, plantelName);
        });
        await updateDoc(doc(db, "users", studentId), {
          plantelIds: Array.from(plantelNameById.keys()),
          plantelNames: Array.from(plantelNameById.values()).filter(Boolean),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        console.warn("No se pudo sincronizar acceso de plantel del alumno", studentId, error);
      }
    }),
  );
}

type AddStudentsInput = {
  groupId: string;
  students: Array<{ id: string; nombre: string; email: string }>;
};

export async function addStudentsToGroup({ groupId, students }: AddStudentsInput): Promise<void> {
  if (!groupId || students.length === 0) return;
  // Evitar duplicados: obtener los ya existentes
  const groupSnap = await getDoc(doc(db, "groups", groupId));
  if (!groupSnap.exists()) return;
  const groupData = groupSnap.data();
  const plantelId = typeof groupData.plantelId === "string" ? groupData.plantelId : "";
  const plantelName = typeof groupData.plantelName === "string" ? groupData.plantelName : "";

  const existingSnap = await getDocs(collection(db, "groups", groupId, "students"));
  const existingIds = new Set(existingSnap.docs.map((d) => d.id));
  const newStudents = students.filter((s) => !existingIds.has(s.id));
  if (newStudents.length === 0) return;

  const batch = writeBatch(db);
  const groupRef = doc(db, "groups", groupId);
  newStudents.forEach((student) => {
    const ref = doc(db, "groups", groupId, "students", student.id);
    batch.set(ref, {
      studentId: student.id,
      studentName: student.nombre,
      studentEmail: student.email,
      plantelId,
      plantelName,
      enrolledAt: serverTimestamp(),
      status: "active",
    });
  });
  batch.update(groupRef, {
    studentsCount: increment(newStudents.length),
    updatedAt: serverTimestamp(),
  });
  // Crear también el enrollment para cada alumno (evita que el feed quede sin curso asignado)
  newStudents.forEach((student) => {
    const enrollmentRef = firestoreDoc(
      db,
      "studentEnrollments",
      `${groupId}_${student.id}`,
    );
    batch.set(enrollmentRef, {
      studentId: student.id,
      studentName: student.nombre,
      studentEmail: student.email,
      groupId,
      groupName: groupData.groupName ?? "",
      courseId: groupData.courseId ?? "",
      courseName: groupData.courseName ?? "",
      teacherName: groupData.teacherName ?? "",
      plantelId,
      plantelName,
      status: "active",
      enrolledAt: serverTimestamp(),
      finalGrade: null,
    });
  });
  await batch.commit();

  if (plantelId) {
    await Promise.all(
      newStudents.map((student) =>
        updateDoc(doc(db, "users", student.id), {
          plantelIds: arrayUnion(plantelId),
          ...(plantelName ? { plantelNames: arrayUnion(plantelName) } : {}),
          updatedAt: serverTimestamp(),
        }).catch((error) => {
          console.warn("No se pudo actualizar plantelIds del alumno", student.id, error);
        }),
      ),
    );
  }
}

export type GroupStudent = {
  id: string;
  studentName: string;
  studentEmail: string;
  status: string;
  enrolledAt?: Date;
};

export async function getGroupStudents(groupId: string): Promise<GroupStudent[]> {
  const ref = collection(db, "groups", groupId, "students");
  const q = query(ref, orderBy("enrolledAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      studentName: d.studentName ?? "",
      studentEmail: d.studentEmail ?? "",
      status: d.status ?? "active",
      enrolledAt: d.enrolledAt?.toDate?.(),
    };
  });
}

/**
 * Obtiene los grupos de un profesor con límite opcional para reducir lecturas
 * @param teacherId - ID del profesor
 * @param maxResults - Límite de resultados (opcional, default: sin límite)
 */
export async function getGroupsForTeacher(teacherId: string, maxResults?: number): Promise<Group[]> {
  if (!teacherId) return [];
  const ref = collection(db, "groups");

  const mainConstraints: QueryConstraint[] = [
    where("teacherId", "==", teacherId),
    orderBy("createdAt", "desc"),
  ];
  const assistantConstraints: QueryConstraint[] = [
    where("assistantTeacherIds", "array-contains", teacherId),
    orderBy("createdAt", "desc"),
  ];

  // Aplicar límite si se especifica
  if (typeof maxResults === "number" && maxResults > 0) {
    mainConstraints.push(limit(maxResults));
    assistantConstraints.push(limit(maxResults));
  }

  const mainQuery = query(ref, ...mainConstraints);
  const assistantQuery = query(ref, ...assistantConstraints);

  const [mainSnap, assistantSnap] = await Promise.all([getDocs(mainQuery), getDocs(assistantQuery)]);
  const map = new Map<string, Group>();
  const consume = (snap: QuerySnapshot<DocumentData>) => {
    snap.docs.forEach((docSnap) => {
      if (map.has(docSnap.id)) return;
      map.set(docSnap.id, toGroup(docSnap.id, docSnap.data()));
    });
  };
  consume(mainSnap);
  consume(assistantSnap);

  // Si hay límite, asegurar que no excedemos el total
  const groups = Array.from(map.values());
  if (typeof maxResults === "number" && maxResults > 0) {
    return groups.slice(0, maxResults);
  }
  return groups;
}

export async function deleteGroup(groupId: string): Promise<void> {
  if (!groupId) return;
  const batch = writeBatch(db);
  const studentsSnap = await getDocs(collection(db, "groups", groupId, "students"));
  const studentIds = studentsSnap.docs.map((studentDoc) => studentDoc.id);
  studentsSnap.forEach((studentDoc) => batch.delete(studentDoc.ref));
  const enrollmentsSnap = await getDocs(
    query(collection(db, "studentEnrollments"), where("groupId", "==", groupId)),
  );
  enrollmentsSnap.forEach((enrollmentDoc) => batch.delete(enrollmentDoc.ref));
  batch.delete(doc(db, "groups", groupId));
  await batch.commit();
  await syncStudentPlantelAccess(studentIds);
}

export async function removeStudentFromGroup(groupId: string, studentId: string): Promise<void> {
  if (!groupId || !studentId) return;
  const batch = writeBatch(db);
  const studentRef = doc(db, "groups", groupId, "students", studentId);
  batch.delete(studentRef);
  const groupRef = doc(db, "groups", groupId);
  batch.update(groupRef, {
    studentsCount: increment(-1),
    updatedAt: serverTimestamp(),
  });
  const primaryEnrollmentId = `${groupId}_${studentId}`;
  const enrollmentRef = doc(db, "studentEnrollments", primaryEnrollmentId);
  const enrollmentIds = new Set<string>([primaryEnrollmentId]);
  batch.delete(enrollmentRef);
  const enrollmentsQuery = query(
    collection(db, "studentEnrollments"),
    where("studentId", "==", studentId),
    where("groupId", "==", groupId),
  );
  const enrollmentsSnap = await getDocs(enrollmentsQuery);
  enrollmentsSnap.docs.forEach((docSnap) => {
    if (enrollmentIds.has(docSnap.id)) return;
    enrollmentIds.add(docSnap.id);
    batch.delete(doc(db, "studentEnrollments", docSnap.id));
  });
  await batch.commit();
  await syncStudentPlantelAccess([studentId]);
}

export async function linkCourseToGroup(params: {
  groupId: string;
  courseId: string;
  courseName: string;
}): Promise<void> {
  const { groupId, courseId, courseName } = params;
  const ref = doc(db, "groups", groupId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Grupo no encontrado");
  const data = snap.data();
  const courses = toGroupCourses(data);
  const courseIds = toGroupCourseIds(data, courses);
  const mentorIds = toUniqueStringArray(data.assistantTeacherIds);
  const existingAccess = normalizeMentorCourseAccess(data.mentorCourseAccess, courseIds);

  const hasCourse = courses.some((c) => c.courseId === courseId);
  const nextCourses = hasCourse ? courses : [...courses, { courseId, courseName }];
  const nextCourseIds = Array.from(new Set([...(courseIds || []), courseId]));
  const nextMentorCourseAccess = buildMentorCourseAccess({
    mentorIds,
    existingAccess,
    validCourseIds: nextCourseIds,
  });

  if (!hasCourse) {
    mentorIds.forEach((mentorId) => {
      nextMentorCourseAccess[mentorId] = Array.from(
        new Set([...(nextMentorCourseAccess[mentorId] ?? []), courseId]),
      );
    });
  }

  await updateDoc(ref, {
    courses: nextCourses,
    courseIds: nextCourseIds,
    mentorCourseAccess: nextMentorCourseAccess,
    updatedAt: serverTimestamp(),
  });

  if (nextCourseIds.length > 0) {
    const { syncCourseMentorsByCourse } = await import("./courses-service");
    const courseMentors = mapCourseMentorsByAccess(nextCourseIds, mentorIds, nextMentorCourseAccess);
    await syncCourseMentorsByCourse(courseMentors);
  }
}

export async function unlinkCourseFromGroup(params: {
  groupId: string;
  courseId: string;
}): Promise<void> {
  const { groupId, courseId } = params;
  const ref = doc(db, "groups", groupId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Grupo no encontrado");

  const data = snap.data();
  const courses = toGroupCourses(data);
  const courseIds = toGroupCourseIds(data, courses);
  const mentorIds = toUniqueStringArray(data.assistantTeacherIds);
  const existingAccess = normalizeMentorCourseAccess(data.mentorCourseAccess, courseIds);

  // Remover el curso de los arrays
  const nextCourses = courses.filter((c) => c.courseId !== courseId);
  const nextCourseIds = courseIds.filter((id) => id !== courseId);
  const nextMentorCourseAccess = buildMentorCourseAccess({
    mentorIds,
    existingAccess,
    validCourseIds: nextCourseIds,
  });

  // Si solo queda un curso o ninguno, actualizar courseId y courseName principales
  const primaryCourse = nextCourses[0];
  const updateData: Record<string, unknown> = {
    courses: nextCourses,
    courseIds: nextCourseIds,
    mentorCourseAccess: nextMentorCourseAccess,
    updatedAt: serverTimestamp(),
  };

  if (primaryCourse) {
    updateData.courseId = primaryCourse.courseId;
    updateData.courseName = primaryCourse.courseName;
  } else {
    // Si no quedan cursos, limpiar campos principales
    updateData.courseId = "";
    updateData.courseName = "";
  }

  await updateDoc(ref, updateData);
}

export async function unlinkCourseForTeacherInGroup(params: {
  groupId: string;
  courseId: string;
  teacherId: string;
}): Promise<{ updated: boolean }> {
  const { groupId, courseId, teacherId } = params;
  const ref = doc(db, "groups", groupId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Grupo no encontrado");

  const data = snap.data();
  const courseIds = toGroupCourseIds(data);
  if (!courseIds.includes(courseId)) {
    throw new Error("La materia no está asignada al grupo");
  }

  const teacherUid = teacherId.trim();
  if (!teacherUid) throw new Error("teacherId es requerido");

  const principalTeacherId = typeof data.teacherId === "string" ? data.teacherId : "";
  // El profesor principal conserva control total del grupo/cursos; este modo aplica para mentores.
  if (teacherUid === principalTeacherId) {
    return { updated: false };
  }

  const mentorIds = toUniqueStringArray(data.assistantTeacherIds);
  if (!mentorIds.includes(teacherUid)) {
    throw new Error("El profesor no está asignado como mentor en este grupo");
  }

  const existingAccess = normalizeMentorCourseAccess(data.mentorCourseAccess, courseIds);
  const nextAccess = buildMentorCourseAccess({
    mentorIds,
    existingAccess,
    validCourseIds: courseIds,
  });

  const currentTeacherAccess = new Set(nextAccess[teacherUid] ?? []);
  if (!currentTeacherAccess.has(courseId)) {
    return { updated: false };
  }
  currentTeacherAccess.delete(courseId);
  nextAccess[teacherUid] = courseIds.filter((id) => currentTeacherAccess.has(id));

  await updateDoc(ref, {
    mentorCourseAccess: nextAccess,
    updatedAt: serverTimestamp(),
  });

  if (courseIds.length > 0) {
    const { syncCourseMentorsByCourse } = await import("./courses-service");
    const courseMentors = mapCourseMentorsByAccess(courseIds, mentorIds, nextAccess);
    await syncCourseMentorsByCourse(courseMentors);
  }

  return { updated: true };
}

export async function setAssistantTeachers(groupId: string, teachers: Array<{ id: string; name: string; email?: string }>) {
  if (!groupId) return;
  const ref = doc(db, "groups", groupId);

  // Obtener el grupo para conocer sus cursos
  const groupSnap = await getDoc(ref);
  if (!groupSnap.exists()) return;

  const groupData = groupSnap.data();
  const courseIds = toGroupCourseIds(groupData);
  const mentorIds = toUniqueStringArray(teachers.map((t) => t.id));
  const existingAccess = normalizeMentorCourseAccess(groupData.mentorCourseAccess, courseIds);
  const mentorCourseAccess = buildMentorCourseAccess({
    mentorIds,
    existingAccess,
    validCourseIds: courseIds,
  });

  // Actualizar el grupo con los nuevos mentores
  await updateDoc(ref, {
    assistantTeacherIds: mentorIds,
    assistantTeachers: teachers,
    mentorCourseAccess,
    updatedAt: serverTimestamp(),
  });

  // Sincronizar los mentorIds en los cursos asociados
  if (courseIds.length > 0) {
    const { syncCourseMentorsByCourse } = await import("./courses-service");
    const courseMentors = mapCourseMentorsByAccess(courseIds, mentorIds, mentorCourseAccess);
    await syncCourseMentorsByCourse(courseMentors);
  }
}

export async function setMentorCourseAccess(
  groupId: string,
  mentorId: string,
  allowedCourseIds: string[],
): Promise<void> {
  if (!groupId || !mentorId) return;
  const ref = doc(db, "groups", groupId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Grupo no encontrado");

  const data = snap.data();
  const courseIds = toGroupCourseIds(data);
  const mentorIds = toUniqueStringArray(data.assistantTeacherIds);
  if (!mentorIds.includes(mentorId)) {
    throw new Error("El mentor no está asignado al grupo");
  }

  const validCourseIds = new Set(courseIds);
  const normalizedRequested = Array.from(
    new Set(
      (allowedCourseIds ?? []).filter(
        (courseId): courseId is string =>
          typeof courseId === "string" && validCourseIds.has(courseId),
      ),
    ),
  );

  const existingAccess = normalizeMentorCourseAccess(data.mentorCourseAccess, courseIds);
  const nextAccess = buildMentorCourseAccess({
    mentorIds,
    existingAccess,
    validCourseIds: courseIds,
  });
  nextAccess[mentorId] = normalizedRequested;

  await updateDoc(ref, {
    mentorCourseAccess: nextAccess,
    updatedAt: serverTimestamp(),
  });

  if (courseIds.length > 0) {
    const { syncCourseMentorsByCourse } = await import("./courses-service");
    const courseMentors = mapCourseMentorsByAccess(courseIds, mentorIds, nextAccess);
    await syncCourseMentorsByCourse(courseMentors);
  }
}

/**
 * Obtiene todos los grupos donde el profesor es mentor (assistantTeacher)
 */
export async function getGroupsWhereAssistant(teacherId: string): Promise<Group[]> {
  if (!teacherId) return [];

  const q = query(
    collection(db, "groups"),
    where("assistantTeacherIds", "array-contains", teacherId),
    orderBy("createdAt", "desc")
  );

  const snap = await getDocs(q);
  return snap.docs.map((groupDoc) => toGroup(groupDoc.id, groupDoc.data()));
}
