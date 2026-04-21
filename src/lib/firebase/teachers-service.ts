import { collection, doc, getDocs, orderBy, query, serverTimestamp, updateDoc, where, limit as fbLimit } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { createAccountWithRole } from "./user-management";
import { getAllGroups, Group } from "./groups-service";

export type TeacherUser = {
  id: string;
  name: string;
  email: string;
  role: "teacher" | "adminTeacher" | "superAdminTeacher" | "coordinadorPlantel";
  phone?: string | null;
  plantelId?: string | null;
  plantelName?: string | null;
};

export type TeacherWorkloadReportRow = {
  teacherId: string;
  teacherName: string;
  teacherEmail: string;
  teacherPhone?: string | null;
  role: TeacherUser["role"];
  totalGroups: number;
  activeGroups: number;
  totalStudents: number;
  activeStudents: number;
  totalClasses: number;
  activeClasses: number;
  uniqueCourses: number;
  uniquePrograms: number;
  programBreakdown: TeacherProgramCourseCount[];
  levelBreakdown: TeacherProgramLevelBreakdown;
  groupNames: string[];
  courseDetails: TeacherCourseDetail[];
  totalCapacity: number;
  activeCapacity: number;
};

export type TeacherProgramLevel = "preparatoria" | "licenciatura" | "otros" | "sinPrograma";

export type TeacherProgramCourseCount = {
  program: string;
  courses: number;
  level: TeacherProgramLevel;
};

export type TeacherCourseDetail = {
  courseId: string;
  courseName: string;
  program: string;
  level: TeacherProgramLevel;
  groupsCount: number;
  groupNames: string[];
};

export type TeacherProgramLevelBreakdown = {
  preparatoria: number;
  licenciatura: number;
  otros: number;
  sinPrograma: number;
};

type TeacherWorkloadAccumulator = Omit<
  TeacherWorkloadReportRow,
  "uniqueCourses" | "uniquePrograms" | "programBreakdown" | "levelBreakdown" | "groupNames" | "courseDetails"
> & {
  courseIds: Set<string>;
  groupIds: Set<string>;
  groupNames: Set<string>;
  courseNameById: Map<string, string>;
  groupIdsByCourseId: Map<string, Set<string>>;
  groupNamesByCourseId: Map<string, Set<string>>;
};

const createEmptyProgramLevelBreakdown = (): TeacherProgramLevelBreakdown => ({
  preparatoria: 0,
  licenciatura: 0,
  otros: 0,
  sinPrograma: 0,
});

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

const normalizeProgram = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const normalizeName = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const normalizeKeyword = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const inferProgramLevel = (program: string): TeacherProgramLevel => {
  const normalized = normalizeKeyword(program);
  if (!normalized) return "sinPrograma";

  const prepaKeywords = ["prepa", "preparatoria", "bachillerato", "media superior"];
  if (prepaKeywords.some((keyword) => normalized.includes(keyword))) {
    return "preparatoria";
  }

  const licenciaturaKeywords = ["licenciatura", "lic ", "lic.", "ingenier", "tsu", "universitari"];
  if (licenciaturaKeywords.some((keyword) => normalized.includes(keyword))) {
    return "licenciatura";
  }

  return "otros";
};

const toGroupCourseNameMap = (group: Group): Map<string, string> => {
  const map = new Map<string, string>();
  if (Array.isArray(group.courses)) {
    group.courses.forEach((course) => {
      if (!course?.courseId) return;
      const normalized = normalizeName(course.courseName);
      if (normalized) {
        map.set(course.courseId, normalized);
      }
    });
  }
  if (group.courseId) {
    const normalizedLegacyName = normalizeName(group.courseName);
    if (normalizedLegacyName && !map.has(group.courseId)) {
      map.set(group.courseId, normalizedLegacyName);
    }
  }
  return map;
};

const toGroupCourseIds = (group: Group): string[] => {
  const explicit = toUniqueStringArray(group.courseIds);
  if (explicit.length > 0) return explicit;
  if (Array.isArray(group.courses) && group.courses.length > 0) {
    return Array.from(
      new Set(
        group.courses
          .map((course) => course.courseId)
          .filter((courseId): courseId is string => typeof courseId === "string" && courseId.trim().length > 0),
      ),
    );
  }
  return group.courseId ? [group.courseId] : [];
};

const toAssistantAllowedCourseIds = (
  group: Group,
  assistantTeacherId: string,
  groupCourseIds: string[],
): string[] => {
  const mentorAccess = group.mentorCourseAccess;
  const hasExplicitAccess =
    mentorAccess && Object.prototype.hasOwnProperty.call(mentorAccess, assistantTeacherId);
  const rawAccess = hasExplicitAccess ? mentorAccess?.[assistantTeacherId] ?? [] : groupCourseIds;
  const allowedSet = new Set(groupCourseIds);
  return toUniqueStringArray(rawAccess).filter((courseId) => allowedSet.has(courseId));
};

const createAccumulator = (teacher: TeacherUser): TeacherWorkloadAccumulator => ({
  teacherId: teacher.id,
  teacherName: teacher.name,
  teacherEmail: teacher.email,
  teacherPhone: teacher.phone ?? null,
  role: teacher.role,
  totalGroups: 0,
  activeGroups: 0,
  totalStudents: 0,
  activeStudents: 0,
  totalClasses: 0,
  activeClasses: 0,
  totalCapacity: 0,
  activeCapacity: 0,
  courseIds: new Set<string>(),
  groupIds: new Set<string>(),
  groupNames: new Set<string>(),
  courseNameById: new Map<string, string>(),
  groupIdsByCourseId: new Map<string, Set<string>>(),
  groupNamesByCourseId: new Map<string, Set<string>>(),
});

const countClassesForCourse = async (courseId: string): Promise<number> => {
  if (!courseId) return 0;
  try {
    const lessonsSnap = await getDocs(collection(db, "courses", courseId, "lessons"));
    if (lessonsSnap.empty) return 0;
    const classesSnaps = await Promise.all(
      lessonsSnap.docs.map((lessonDoc) =>
        getDocs(collection(db, "courses", courseId, "lessons", lessonDoc.id, "classes")),
      ),
    );
    return classesSnaps.reduce((sum, snap) => sum + snap.size, 0);
  } catch (error) {
    console.warn("No se pudieron contar clases del curso", courseId, error);
    return 0;
  }
};

const getClassesCountByCourse = async (courseIds: string[]): Promise<Map<string, number>> => {
  const uniqueCourseIds = Array.from(
    new Set(courseIds.filter((courseId) => typeof courseId === "string" && courseId.trim().length > 0)),
  );
  const pairs = await Promise.all(
    uniqueCourseIds.map(async (courseId) => [courseId, await countClassesForCourse(courseId)] as const),
  );
  return new Map(pairs);
};

type CourseMeta = {
  title: string;
  program: string;
};

const getCourseMetaById = async (courseIds: string[]): Promise<Map<string, CourseMeta>> => {
  const uniqueCourseIds = Array.from(
    new Set(courseIds.filter((courseId) => typeof courseId === "string" && courseId.trim().length > 0)),
  );
  if (uniqueCourseIds.length === 0) return new Map();

  const coursesRef = collection(db, "courses");
  const map = new Map<string, CourseMeta>();
  const batchSize = 30;

  for (let index = 0; index < uniqueCourseIds.length; index += batchSize) {
    const batch = uniqueCourseIds.slice(index, index + batchSize);
    const snap = await getDocs(query(coursesRef, where("__name__", "in", batch)));
    snap.docs.forEach((docSnap) => {
      const data = docSnap.data();
      const title = normalizeName(data.title ?? "");
      const program = normalizeProgram(data.program ?? data.category ?? "");
      map.set(docSnap.id, { title, program });
    });
  }

  return map;
};

const getOrCreateAccumulator = (params: {
  teacherId: string;
  accumulators: Map<string, TeacherWorkloadAccumulator>;
  teachersById: Map<string, TeacherUser>;
  fallbackName?: string;
}): TeacherWorkloadAccumulator | null => {
  const { teacherId, accumulators, teachersById, fallbackName } = params;
  const normalizedId = teacherId.trim();
  if (!normalizedId) return null;
  const existing = accumulators.get(normalizedId);
  if (existing) return existing;
  const knownTeacher = teachersById.get(normalizedId);
  const next = createAccumulator(
    knownTeacher ?? {
      id: normalizedId,
      name: fallbackName?.trim() || "Profesor",
      email: "",
      role: "teacher",
      phone: null,
    },
  );
  accumulators.set(normalizedId, next);
  return next;
};

const applyGroupToAccumulator = (params: {
  group: Group;
  assignedCourseIds: string[];
  assignedCourseNamesById: Map<string, string>;
  accumulator: TeacherWorkloadAccumulator;
  classesByCourse: Map<string, number>;
}): void => {
  const { group, assignedCourseIds, assignedCourseNamesById, accumulator, classesByCourse } = params;
  const studentsCount = Number.isFinite(group.studentsCount) ? Math.max(0, group.studentsCount) : 0;
  const capacity = Number.isFinite(group.maxStudents) ? Math.max(0, group.maxStudents) : 0;
  const classesCount = assignedCourseIds.reduce(
    (sum, courseId) => sum + (classesByCourse.get(courseId) ?? 0),
    0,
  );
  const normalizedGroupName = normalizeName(group.groupName);

  accumulator.totalGroups += 1;
  accumulator.totalStudents += studentsCount;
  accumulator.totalClasses += classesCount;
  accumulator.totalCapacity += capacity;
  accumulator.groupIds.add(group.id);
  if (normalizedGroupName) {
    accumulator.groupNames.add(normalizedGroupName);
  }
  assignedCourseIds.forEach((courseId) => {
    accumulator.courseIds.add(courseId);
    const courseName = assignedCourseNamesById.get(courseId);
    if (courseName && !accumulator.courseNameById.has(courseId)) {
      accumulator.courseNameById.set(courseId, courseName);
    }

    if (!accumulator.groupIdsByCourseId.has(courseId)) {
      accumulator.groupIdsByCourseId.set(courseId, new Set<string>());
    }
    accumulator.groupIdsByCourseId.get(courseId)?.add(group.id);

    if (normalizedGroupName) {
      if (!accumulator.groupNamesByCourseId.has(courseId)) {
        accumulator.groupNamesByCourseId.set(courseId, new Set<string>());
      }
      accumulator.groupNamesByCourseId.get(courseId)?.add(normalizedGroupName);
    }
  });

  if (group.status === "active") {
    accumulator.activeGroups += 1;
    accumulator.activeStudents += studentsCount;
    accumulator.activeClasses += classesCount;
    accumulator.activeCapacity += capacity;
  }
};

export async function getTeacherUsers(max = 100): Promise<TeacherUser[]> {
  const usersRef = collection(db, "users");
  const q = query(
    usersRef,
    where("role", "in", ["teacher", "adminTeacher", "superAdminTeacher", "coordinadorPlantel"]),
    orderBy("createdAt", "desc"),
    fbLimit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      name: d.displayName ?? d.name ?? "Profesor",
      email: d.email ?? "",
      role:
        d.role === "adminTeacher" ||
        d.role === "superAdminTeacher" ||
        d.role === "coordinadorPlantel"
          ? d.role
          : "teacher",
      phone: d.phone ?? null,
      plantelId: typeof d.plantelId === "string" ? d.plantelId : null,
      plantelName: typeof d.plantelName === "string" ? d.plantelName : null,
    };
  });
}

export async function getTeacherWorkloadReport(maxTeachers = 300): Promise<TeacherWorkloadReportRow[]> {
  const [teachers, groups] = await Promise.all([
    getTeacherUsers(maxTeachers),
    getAllGroups(),
  ]);
  const reportCourseIds = groups.flatMap((group) => toGroupCourseIds(group));
  const [classesByCourse, courseMetaById] = await Promise.all([
    getClassesCountByCourse(reportCourseIds),
    getCourseMetaById(reportCourseIds),
  ]);
  const fallbackProgramByCourseId = new Map<string, string>();
  const fallbackNameByCourseId = new Map<string, string>();

  const teachersById = new Map(teachers.map((teacher) => [teacher.id, teacher] as const));
  const accumulators = new Map<string, TeacherWorkloadAccumulator>();
  teachers.forEach((teacher) => {
    accumulators.set(teacher.id, createAccumulator(teacher));
  });

  groups.forEach((group) => {
    const groupCourseIds = toGroupCourseIds(group);
    const groupCourseNameMap = toGroupCourseNameMap(group);
    const groupProgram = normalizeProgram(group.program);
    groupCourseNameMap.forEach((courseName, courseId) => {
      if (!fallbackNameByCourseId.has(courseId)) {
        fallbackNameByCourseId.set(courseId, courseName);
      }
    });
    if (groupProgram) {
      groupCourseIds.forEach((courseId) => {
        if (!fallbackProgramByCourseId.has(courseId)) {
          fallbackProgramByCourseId.set(courseId, groupProgram);
        }
      });
    }

    const primaryTeacher = getOrCreateAccumulator({
      teacherId: group.teacherId,
      accumulators,
      teachersById,
      fallbackName: group.teacherName,
    });
    if (primaryTeacher) {
      applyGroupToAccumulator({
        group,
        assignedCourseIds: groupCourseIds,
        assignedCourseNamesById: groupCourseNameMap,
        accumulator: primaryTeacher,
        classesByCourse,
      });
    }

    const assistantIds = toUniqueStringArray(group.assistantTeacherIds);
    const assistantNameById = new Map(
      Array.isArray(group.assistantTeachers)
        ? group.assistantTeachers.map((teacher) => [teacher.id, teacher.name] as const)
        : [],
    );
    assistantIds.forEach((assistantId) => {
      if (!assistantId || assistantId === group.teacherId) return;
      const assistantTeacher = getOrCreateAccumulator({
        teacherId: assistantId,
        accumulators,
        teachersById,
        fallbackName: assistantNameById.get(assistantId),
      });
      if (!assistantTeacher) return;
      const assistantAllowedCourseIds = toAssistantAllowedCourseIds(group, assistantId, groupCourseIds);
      const assistantCourseNameMap = new Map(
        assistantAllowedCourseIds
          .map((courseId) => [courseId, groupCourseNameMap.get(courseId) ?? ""] as const)
          .filter(([, courseName]) => Boolean(courseName)),
      );
      applyGroupToAccumulator({
        group,
        assignedCourseIds: assistantAllowedCourseIds,
        assignedCourseNamesById: assistantCourseNameMap,
        accumulator: assistantTeacher,
        classesByCourse,
      });
    });
  });

  return Array.from(accumulators.values())
    .map((accumulator) => {
      const levelBreakdown = createEmptyProgramLevelBreakdown();
      const programCounts = new Map<string, number>();
      const courseDetails: TeacherCourseDetail[] = [];

      accumulator.courseIds.forEach((courseId) => {
        const courseMeta = courseMetaById.get(courseId);
        const rawProgram = courseMeta?.program ?? fallbackProgramByCourseId.get(courseId) ?? "";
        const normalizedProgram = normalizeProgram(rawProgram);
        const level = inferProgramLevel(normalizedProgram);
        const courseName =
          normalizeName(courseMeta?.title ?? "") ||
          accumulator.courseNameById.get(courseId) ||
          fallbackNameByCourseId.get(courseId) ||
          "Curso";
        const groupNames = Array.from(accumulator.groupNamesByCourseId.get(courseId) ?? []).sort((a, b) =>
          a.localeCompare(b, "es"),
        );
        const groupsCount = accumulator.groupIdsByCourseId.get(courseId)?.size ?? 0;
        levelBreakdown[level] += 1;
        programCounts.set(normalizedProgram, (programCounts.get(normalizedProgram) ?? 0) + 1);
        courseDetails.push({
          courseId,
          courseName,
          program: normalizedProgram || "Sin programa",
          level,
          groupsCount,
          groupNames,
        });
      });

      const programBreakdown = Array.from(programCounts.entries())
        .map(([program, courses]) => ({
          program: program || "Sin programa",
          courses,
          level: inferProgramLevel(program),
        }))
        .sort((a, b) => {
          if (b.courses !== a.courses) return b.courses - a.courses;
          return a.program.localeCompare(b.program, "es");
        });
      const groupNames = Array.from(accumulator.groupNames).sort((a, b) =>
        a.localeCompare(b, "es"),
      );
      courseDetails.sort((a, b) => {
        if (b.groupsCount !== a.groupsCount) return b.groupsCount - a.groupsCount;
        return a.courseName.localeCompare(b.courseName, "es");
      });

      return {
        teacherId: accumulator.teacherId,
        teacherName: accumulator.teacherName,
        teacherEmail: accumulator.teacherEmail,
        teacherPhone: accumulator.teacherPhone,
        role: accumulator.role,
        totalGroups: accumulator.totalGroups,
        activeGroups: accumulator.activeGroups,
        totalStudents: accumulator.totalStudents,
        activeStudents: accumulator.activeStudents,
        totalClasses: accumulator.totalClasses,
        activeClasses: accumulator.activeClasses,
        uniqueCourses: accumulator.courseIds.size,
        uniquePrograms: programBreakdown.filter((item) => item.program !== "Sin programa").length,
        programBreakdown,
        levelBreakdown,
        groupNames,
        courseDetails,
        totalCapacity: accumulator.totalCapacity,
        activeCapacity: accumulator.activeCapacity,
      };
    })
    .sort((a, b) => {
      if (b.activeStudents !== a.activeStudents) return b.activeStudents - a.activeStudents;
      if (b.totalStudents !== a.totalStudents) return b.totalStudents - a.totalStudents;
      return a.teacherName.localeCompare(b.teacherName, "es");
    });
}

export async function createTeacherAccount(params: {
  name: string;
  email: string;
  password: string;
  role?: "teacher" | "adminTeacher" | "superAdminTeacher" | "coordinadorPlantel";
  asAdminTeacher?: boolean;
  phone?: string;
  createdBy?: string | null;
}): Promise<string> {
  const trimmedName = params.name.trim() || "Profesor";
  const role = params.asAdminTeacher ? "adminTeacher" : params.role ?? "teacher";
  const { uid } = await createAccountWithRole({
    email: params.email,
    password: params.password,
    displayName: trimmedName,
    role,
    createdBy: params.createdBy,
    phone: params.phone,
  });
    return uid;
}

export async function deactivateTeacher(userId: string): Promise<void> {
  if (!userId) return;
  await updateDoc(doc(db, "users", userId), {
    status: "deleted",
    updatedAt: serverTimestamp(),
  });
}
