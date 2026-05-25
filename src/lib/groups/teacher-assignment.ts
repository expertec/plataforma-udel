type TeacherAssignment = {
  teacherId: string;
  teacherName: string;
  source: "principal" | "mentor" | "unknown";
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => asTrimmedString(item))
        .filter(Boolean),
    ),
  );
}

function getGroupCourseIds(groupData: Record<string, unknown>): string[] {
  const explicitIds = toUniqueStringArray(groupData.courseIds);
  if (explicitIds.length > 0) return explicitIds;

  if (Array.isArray(groupData.courses)) {
    const ids = groupData.courses
      .map((course) =>
        course && typeof course === "object"
          ? asTrimmedString((course as Record<string, unknown>).courseId)
          : "",
      )
      .filter(Boolean);
    if (ids.length > 0) {
      return Array.from(new Set(ids));
    }
  }

  const legacyCourseId = asTrimmedString(groupData.courseId);
  return legacyCourseId ? [legacyCourseId] : [];
}

function getAssistantTeacherNameMap(groupData: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(groupData.assistantTeachers)) return map;

  groupData.assistantTeachers.forEach((teacher) => {
    if (!teacher || typeof teacher !== "object") return;
    const data = teacher as Record<string, unknown>;
    const teacherId = asTrimmedString(data.id);
    if (!teacherId) return;
    map.set(teacherId, asTrimmedString(data.name));
  });

  return map;
}

function getMentorIdsAssignedToCourse(params: {
  groupData: Record<string, unknown>;
  courseId: string;
}): string[] {
  const courseId = asTrimmedString(params.courseId);
  if (!courseId) return [];

  const mentorIds = toUniqueStringArray(params.groupData.assistantTeacherIds);
  if (mentorIds.length === 0) return [];

  const groupCourseIds = getGroupCourseIds(params.groupData);
  const validGroupCourseIds = new Set(groupCourseIds);
  const rawAccess = params.groupData.mentorCourseAccess;
  const accessMap =
    rawAccess && typeof rawAccess === "object" && !Array.isArray(rawAccess)
      ? (rawAccess as Record<string, unknown>)
      : null;

  return mentorIds.filter((mentorId) => {
    if (!accessMap || !Object.prototype.hasOwnProperty.call(accessMap, mentorId)) {
      return validGroupCourseIds.has(courseId);
    }
    return toUniqueStringArray(accessMap[mentorId]).includes(courseId);
  });
}

export function resolveTeacherAssignmentForCourse(params: {
  groupData: Record<string, unknown>;
  courseId?: string | null;
}): TeacherAssignment {
  const principalTeacherId = asTrimmedString(params.groupData.teacherId);
  const principalTeacherName = asTrimmedString(params.groupData.teacherName);
  const courseId = asTrimmedString(params.courseId);

  if (courseId) {
    const mentorIds = getMentorIdsAssignedToCourse({
      groupData: params.groupData,
      courseId,
    });
    if (mentorIds.length === 1) {
      const mentorId = mentorIds[0];
      const mentorName = getAssistantTeacherNameMap(params.groupData).get(mentorId) ?? "";
      return {
        teacherId: mentorId,
        teacherName: mentorName || principalTeacherName || "Profesor",
        source: "mentor",
      };
    }
  }

  if (principalTeacherId) {
    return {
      teacherId: principalTeacherId,
      teacherName: principalTeacherName || "Profesor",
      source: "principal",
    };
  }

  return {
    teacherId: "",
    teacherName: principalTeacherName || "Profesor",
    source: "unknown",
  };
}
