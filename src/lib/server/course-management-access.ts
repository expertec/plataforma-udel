import { getAdminFirestore } from "@/lib/firebase/admin";

export type CourseManagementRole =
  | "teacher"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel"
  | "director";

export type CourseManagementAccess = {
  allowed: boolean;
  mentorIds: string[];
  shouldBackfillMentor: boolean;
};

type CourseAccessErrorLike = new (status: number, message: string) => Error;

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

function getGroupCourseIds(groupData: Record<string, unknown>): string[] {
  const explicitIds = asUniqueStringArray(groupData.courseIds);
  if (explicitIds.length > 0) return explicitIds;

  if (Array.isArray(groupData.courses)) {
    const ids = groupData.courses
      .map((course) => {
        if (!course || typeof course !== "object" || Array.isArray(course)) return "";
        return asTrimmedString((course as Record<string, unknown>).courseId);
      })
      .filter((courseId) => courseId.length > 0);
    if (ids.length > 0) return Array.from(new Set(ids));
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
    return [];
  }
  if (!Object.prototype.hasOwnProperty.call(mentorAccess, mentorId)) {
    return [];
  }
  const rawAllowed = (mentorAccess as Record<string, unknown>)[mentorId];
  const validCourseIds = new Set(groupCourseIds);
  return asUniqueStringArray(rawAllowed).filter((courseId) => validCourseIds.has(courseId));
}

async function canCampusCoordinatorManageCourse(params: {
  courseId: string;
  plantelIds: string[];
}): Promise<boolean> {
  const plantelIds = asUniqueStringArray(params.plantelIds);
  if (plantelIds.length === 0) return false;

  const db = getAdminFirestore();
  const groupSnaps = await Promise.all(
    plantelIds.map((plantelId) =>
      db.collection("groups").where("plantelId", "==", plantelId).get(),
    ),
  );

  return groupSnaps.some((groupsSnap) =>
    groupsSnap.docs.some((groupDoc) => {
      const groupData = groupDoc.data() as Record<string, unknown>;
      return getGroupCourseIds(groupData).includes(params.courseId);
    }),
  );
}

async function resolveTeacherCourseGroupLink(params: {
  courseId: string;
  uid: string;
}): Promise<"principal" | "mentor" | null> {
  const db = getAdminFirestore();
  const [principalGroupsSnap, assistantGroupsSnap] = await Promise.all([
    db.collection("groups").where("teacherId", "==", params.uid).get(),
    db.collection("groups").where("assistantTeacherIds", "array-contains", params.uid).get(),
  ]);

  const isPrincipalLinked = principalGroupsSnap.docs.some((groupDoc) => {
    const groupData = groupDoc.data() as Record<string, unknown>;
    return getGroupCourseIds(groupData).includes(params.courseId);
  });
  if (isPrincipalLinked) return "principal";

  const isMentorLinked = assistantGroupsSnap.docs.some((groupDoc) => {
    const groupData = groupDoc.data() as Record<string, unknown>;
    return getMentorAllowedCourseIds(groupData, params.uid).includes(params.courseId);
  });
  return isMentorLinked ? "mentor" : null;
}

export async function resolveCourseManagementAccess(params: {
  courseId: string;
  uid: string;
  role: CourseManagementRole;
  coordinatorPlantelIds?: string[];
  AccessError?: CourseAccessErrorLike;
}): Promise<CourseManagementAccess> {
  const { courseId, uid, role } = params;
  const db = getAdminFirestore();

  const courseRef = db.collection("courses").doc(courseId);
  const courseSnap = await courseRef.get();
  if (!courseSnap.exists) {
    const AccessError = params.AccessError;
    if (AccessError) throw new AccessError(404, "Curso no encontrado");
    return { allowed: false, mentorIds: [], shouldBackfillMentor: false };
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

  if (
    (role === "coordinadorPlantel" || role === "director") &&
    (await canCampusCoordinatorManageCourse({
      courseId,
      plantelIds: params.coordinatorPlantelIds ?? [],
    }))
  ) {
    return { allowed: true, mentorIds, shouldBackfillMentor: false };
  }

  const groupLink = await resolveTeacherCourseGroupLink({ courseId, uid });
  if (groupLink) {
    return {
      allowed: true,
      mentorIds,
      shouldBackfillMentor: groupLink === "mentor" && !mentorIds.includes(uid),
    };
  }

  return { allowed: false, mentorIds, shouldBackfillMentor: false };
}
