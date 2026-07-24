"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import toast from "react-hot-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { db } from "@/lib/firebase/firestore";

type Props = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  scopePlantelId?: string;
  scopeGroupIds?: string[];
  isOpen: boolean;
  onClose: () => void;
};

type CourseClosure = {
  status?: "open" | "closed";
  finalGrade?: number;
  autoGrade?: number | null;
  globalExamGrade?: number | null;
  globalExamScore?: number | null;
  gradeSource?: string;
  pendingUngradedCount?: number;
  closedAt?: unknown;
  updatedAt?: unknown;
};

type GradeRow = {
  id: string;
  groupId: string;
  courseId: string;
  groupName: string;
  courseName: string;
  status: "open" | "closed";
  finalGrade: number | null;
  autoGrade: number | null;
  globalExamGrade: number | null;
  globalExamSource: "closure" | "regularization" | null;
  pendingUngradedCount: number | null;
  closedAt: Date | null;
  updatedAt: Date | null;
};

const toDateOrNull = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null && "toDate" in value) {
    const fn = (value as { toDate?: () => Date }).toDate;
    if (typeof fn === "function") {
      try {
        return fn();
      } catch {
        return null;
      }
    }
  }
  return null;
};

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) ? value : null;
};

const resolveGlobalExamData = (
  closure: CourseClosure,
): Pick<GradeRow, "globalExamGrade" | "globalExamSource"> => {
  const capturedGrade = toNumberOrNull(closure.globalExamGrade);
  if (capturedGrade !== null) {
    return {
      globalExamGrade: capturedGrade,
      globalExamSource: "closure",
    };
  }

  if (closure.gradeSource === "globalRegularizationExam") {
    return {
      globalExamGrade:
        toNumberOrNull(closure.globalExamScore) ?? toNumberOrNull(closure.finalGrade),
      globalExamSource: "regularization",
    };
  }

  return {
    globalExamGrade: null,
    globalExamSource: null,
  };
};

const formatDate = (value: Date | null): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(value);
};

const buildRowKey = (groupId: string, groupName: string, courseId: string, courseName: string) => {
  const g = groupId.trim() || groupName.trim() || "sin-grupo";
  const c = courseId.trim() || courseName.trim() || "sin-materia";
  return `${g}::${c}`;
};

const buildGroupCourseKey = (groupId: string, courseId: string) =>
  `${groupId.trim()}::${courseId.trim()}`;

const looksLikeFirestoreId = (value: string) => /^[A-Za-z0-9_-]{16,}$/.test(value.trim());

const getCourseNameFromGroupData = (groupData: {
  courseId?: unknown;
  courseName?: unknown;
  courses?: unknown;
}) => {
  const courseNameById = new Map<string, string>();

  if (Array.isArray(groupData.courses)) {
    groupData.courses.forEach((course) => {
      if (!course || typeof course !== "object") return;
      const courseId =
        typeof (course as { courseId?: unknown }).courseId === "string"
          ? (course as { courseId: string }).courseId.trim()
          : "";
      if (!courseId) return;
      const courseName =
        typeof (course as { courseName?: unknown }).courseName === "string"
          ? (course as { courseName: string }).courseName.trim()
          : "";
      if (courseName) {
        courseNameById.set(courseId, courseName);
      }
    });
  }

  const legacyCourseId =
    typeof groupData.courseId === "string" ? groupData.courseId.trim() : "";
  const legacyCourseName =
    typeof groupData.courseName === "string" ? groupData.courseName.trim() : "";
  if (legacyCourseId && legacyCourseName && !courseNameById.has(legacyCourseId)) {
    courseNameById.set(legacyCourseId, legacyCourseName);
  }

  return courseNameById;
};

const getRowTs = (row: GradeRow): number =>
  Math.max(row.closedAt?.getTime() ?? 0, row.updatedAt?.getTime() ?? 0);

const isPermissionDeniedError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "permission-denied";

export function StudentGradesModal({
  studentId,
  studentName,
  studentEmail,
  scopePlantelId = "",
  scopeGroupIds = [],
  isOpen,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<GradeRow[]>([]);

  useEffect(() => {
    if (!isOpen || !studentId) return;
    let active = true;

    const loadGrades = async () => {
      setLoading(true);
      try {
        const normalizedScopeGroupIds = Array.from(
          new Set(scopeGroupIds.map((groupId) => groupId.trim()).filter((groupId) => groupId.length > 0)),
        );
        const normalizedScopePlantelId = scopePlantelId.trim();
        const isScopedAccess =
          normalizedScopeGroupIds.length > 0 || normalizedScopePlantelId.length > 0;
        let enrollmentPermissionDenied = false;
        let enrollmentDocs:
          | Array<Awaited<ReturnType<typeof getDoc>>>
          | Array<Awaited<ReturnType<typeof getDocs>>["docs"][number]> = [];
        if (normalizedScopeGroupIds.length > 0) {
          enrollmentDocs = (
            await Promise.allSettled(
              normalizedScopeGroupIds.map((groupId) =>
                getDoc(doc(db, "studentEnrollments", `${groupId}_${studentId}`)),
              ),
            )
          ).flatMap((result) => {
            if (result.status === "rejected") {
              if (isPermissionDeniedError(result.reason)) {
                enrollmentPermissionDenied = true;
                return [];
              }
              throw result.reason;
            }
            return result.value.exists() ? [result.value] : [];
          });
        } else if (normalizedScopePlantelId) {
          enrollmentDocs = [];
        } else {
          try {
            enrollmentDocs = (
              await getDocs(
                query(
                  collection(db, "studentEnrollments"),
                  where("studentId", "==", studentId),
                ),
              )
            ).docs;
          } catch (error) {
            if (isPermissionDeniedError(error)) {
              enrollmentPermissionDenied = true;
              enrollmentDocs = [];
            } else {
              throw error;
            }
          }
        }

        const closureRows = new Map<string, GradeRow>();
        const enrollmentGroupNames = new Map<string, string>();
        const enrollmentCourseFallbackByGroup = new Map<string, string>();
        const groupCourseNameByKey = new Map<string, string>();
        const courseTitleById = new Map<string, string>();
        const groupIds = new Set<string>();
        const enrollmentSources: Array<{
          groupId: string;
          groupName: string;
          fallbackCourseName: string;
          closures: Record<string, unknown>;
        }> = [];

        const upsertClosureRow = (row: GradeRow) => {
          const previous = closureRows.get(row.id);
          if (!previous || getRowTs(row) >= getRowTs(previous)) {
            closureRows.set(row.id, row);
          }
        };

        const rebuildResolvedRows = (rowsMap: Map<string, GradeRow>) => {
          const rebuilt = new Map<string, GradeRow>();
          rowsMap.forEach((row) => {
            const resolvedGroupName = enrollmentGroupNames.get(row.groupId) ?? row.groupName;
            const fallbackCourseName =
              enrollmentCourseFallbackByGroup.get(row.groupId) ?? row.courseName;
            const resolvedCourseName = resolveCourseName(
              row.groupId,
              row.courseId,
              row.courseName,
              fallbackCourseName,
            );
            const rebuiltRow = {
              ...row,
              id: buildRowKey(row.groupId, resolvedGroupName, row.courseId, resolvedCourseName),
              groupName: resolvedGroupName,
              courseName: resolvedCourseName,
            };
            const previous = rebuilt.get(rebuiltRow.id);
            if (!previous || getRowTs(rebuiltRow) >= getRowTs(previous)) {
              rebuilt.set(rebuiltRow.id, rebuiltRow);
            }
          });
          return rebuilt;
        };

        const registerGroupCourses = (
          groupId: string,
          groupData: {
            courseId?: unknown;
            courseName?: unknown;
            courses?: unknown;
          },
        ) => {
          const normalizedGroupId = groupId.trim();
          if (!normalizedGroupId) return;
          const courseNameById = getCourseNameFromGroupData(groupData);
          courseNameById.forEach((courseName, courseId) => {
            const key = buildGroupCourseKey(normalizedGroupId, courseId);
            if (!groupCourseNameByKey.has(key) && courseName) {
              groupCourseNameByKey.set(key, courseName);
            }
          });
        };

        const resolveCourseName = (
          groupId: string,
          courseId: string,
          ...candidates: Array<string | null | undefined>
        ) => {
          const normalizedGroupId = groupId.trim();
          const normalizedCourseId = courseId.trim();
          const groupCourseName = normalizedCourseId
            ? groupCourseNameByKey.get(buildGroupCourseKey(normalizedGroupId, normalizedCourseId)) ?? ""
            : "";
          const courseTitle = normalizedCourseId
            ? courseTitleById.get(normalizedCourseId) ?? ""
            : "";

          for (const candidate of [groupCourseName, courseTitle, ...candidates]) {
            if (typeof candidate !== "string") continue;
            const normalizedCandidate = candidate.trim();
            if (normalizedCandidate) return normalizedCandidate;
          }

          if (normalizedCourseId) {
            return looksLikeFirestoreId(normalizedCourseId)
              ? "Materia archivada"
              : normalizedCourseId;
          }

          return "Sin materia";
        };

        const needsCourseLookup = (
          groupId: string,
          courseId: string,
          ...candidates: Array<string | null | undefined>
        ) => {
          const normalizedGroupId = groupId.trim();
          const normalizedCourseId = courseId.trim();
          if (!normalizedCourseId) return false;

          const groupCourseName = groupCourseNameByKey.get(
            buildGroupCourseKey(normalizedGroupId, normalizedCourseId),
          );
          if (typeof groupCourseName === "string" && groupCourseName.trim().length > 0) {
            return false;
          }

          for (const candidate of candidates) {
            if (typeof candidate === "string" && candidate.trim().length > 0) {
              return false;
            }
          }

          return !courseTitleById.has(normalizedCourseId);
        };

        const ingestEnrollmentData = (data: {
          groupId?: string;
          groupName?: string;
          courseName?: string;
          courseClosures?: Record<string, unknown>;
        }) => {
          const groupId = (data.groupId ?? "").trim();
          const groupName = (data.groupName ?? "").trim() || "Sin grupo";
          const fallbackCourseName = (data.courseName ?? "").trim();
          if (groupId) {
            groupIds.add(groupId);
            if (!enrollmentGroupNames.has(groupId)) {
              enrollmentGroupNames.set(groupId, groupName);
            }
            if (fallbackCourseName && !enrollmentCourseFallbackByGroup.has(groupId)) {
              enrollmentCourseFallbackByGroup.set(groupId, fallbackCourseName);
            }
          }

          enrollmentSources.push({
            groupId,
            groupName,
            fallbackCourseName,
            closures: (data.courseClosures ?? {}) as Record<string, unknown>,
          });
        };

        enrollmentDocs.forEach((docSnap) => {
          ingestEnrollmentData(
            docSnap.data() as {
              groupId?: string;
              groupName?: string;
              courseName?: string;
              courseClosures?: Record<string, unknown>;
            },
          );
        });

        // Historial archivado: inscripciones de grupos anteriores conservadas al
        // remover al alumno (cambio de grupo/modalidad). Mantiene el Kardex completo.
        let archiveDocs: Array<{ data: () => unknown }> = [];
        try {
          if (normalizedScopeGroupIds.length > 0) {
            archiveDocs = (
              await Promise.allSettled(
                normalizedScopeGroupIds.map((groupId) =>
                  getDoc(doc(db, "studentEnrollmentsArchive", `${groupId}_${studentId}`)),
                ),
              )
            ).flatMap((result) => {
              if (result.status === "rejected") {
                if (isPermissionDeniedError(result.reason)) return [];
                throw result.reason;
              }
              return result.value.exists() ? [result.value] : [];
            });
          } else if (!normalizedScopePlantelId) {
            archiveDocs = (
              await getDocs(
                query(
                  collection(db, "studentEnrollmentsArchive"),
                  where("studentId", "==", studentId),
                ),
              )
            ).docs;
          }
        } catch (error) {
          if (!isPermissionDeniedError(error)) throw error;
          archiveDocs = [];
        }

        archiveDocs.forEach((docSnap) => {
          ingestEnrollmentData(
            docSnap.data() as {
              groupId?: string;
              groupName?: string;
              courseName?: string;
              courseClosures?: Record<string, unknown>;
            },
          );
        });

        if (groupIds.size === 0 && normalizedScopeGroupIds.length > 0) {
          normalizedScopeGroupIds.forEach((groupId) => groupIds.add(groupId));
        }

        if (groupIds.size === 0 && normalizedScopePlantelId) {
          const scopedGroupsSnap = await getDocs(
            query(collection(db, "groups"), where("plantelId", "==", normalizedScopePlantelId)),
          );
          scopedGroupsSnap.docs.forEach((groupDoc) => {
            const groupId = groupDoc.id.trim();
            if (!groupId) return;
            groupIds.add(groupId);
            const data = groupDoc.data() as { groupName?: unknown; courseName?: unknown };
            const groupName =
              typeof data.groupName === "string" && data.groupName.trim().length > 0
                ? data.groupName.trim()
                : "Sin grupo";
            enrollmentGroupNames.set(groupId, groupName);
            if (typeof data.courseName === "string" && data.courseName.trim().length > 0) {
              enrollmentCourseFallbackByGroup.set(groupId, data.courseName.trim());
            }
            registerGroupCourses(groupId, groupDoc.data());
          });
        }

        // Recuperación de historial: descubre grupos donde el alumno tiene entregas
        // aunque su inscripción ya no exista (p. ej. cambió de grupo antes de que se
        // archivaran las inscripciones). Las entregas NO se borran al remover al alumno.
        // Solo admin/adminTeacher pueden hacer collectionGroup de submissions (ver reglas);
        // para otros roles/alcances se ignora silenciosamente.
        const groupIdsBeforeDiscovery = Array.from(groupIds);
        if (!isScopedAccess) {
          try {
            // Usamos orderBy('submittedAt') para reutilizar el índice compuesto
            // (studentId ASC, submittedAt DESC) que ya usa el reporte de riesgo de
            // deserción, en vez de exigir un índice de campo único COLLECTION_GROUP.
            const studentSubmissionsCg = await getDocs(
              query(
                collectionGroup(db, "submissions"),
                where("studentId", "==", studentId),
                orderBy("submittedAt", "desc"),
              ),
            );
            const discoveredFromSubmissions: string[] = [];
            studentSubmissionsCg.docs.forEach((submissionDoc) => {
              const discoveredGroupId = submissionDoc.ref.parent.parent?.id?.trim();
              if (discoveredGroupId) {
                discoveredFromSubmissions.push(discoveredGroupId);
                groupIds.add(discoveredGroupId);
              }
            });
            console.log("[Kardex][debug] studentId", studentId, {
              isScopedAccess,
              liveEnrollments: enrollmentDocs.length,
              archiveDocs: archiveDocs.length,
              groupsBeforeDiscovery: groupIdsBeforeDiscovery,
              submissionsFound: studentSubmissionsCg.size,
              groupsFromSubmissions: Array.from(new Set(discoveredFromSubmissions)),
              groupsAfterDiscovery: Array.from(groupIds),
            });
          } catch (error) {
            // Best-effort: si falta permiso o un índice de collectionGroup, no rompemos
            // el Kardex; simplemente no se recuperan grupos históricos por entregas.
            console.warn("[Kardex][debug] No se pudo descubrir grupos históricos por entregas:", error);
          }
        }

        const groupIdsToLoad = Array.from(
          new Set([...Array.from(groupIds), ...normalizedScopeGroupIds]),
        );
        if (groupIdsToLoad.length > 0) {
          const groupDocs = await Promise.allSettled(
            groupIdsToLoad.map((groupId) => getDoc(doc(db, "groups", groupId))),
          );
          groupDocs.forEach((result, index) => {
            const groupId = groupIdsToLoad[index];
            if (result.status === "rejected") {
              if (isPermissionDeniedError(result.reason)) return;
              throw result.reason;
            }
            if (!result.value.exists()) return;
            const data = result.value.data() as {
              groupName?: unknown;
              courseName?: unknown;
              courseId?: unknown;
              courses?: unknown;
            };
            const groupName =
              typeof data.groupName === "string" && data.groupName.trim().length > 0
                ? data.groupName.trim()
                : "";
            if (groupName) {
              enrollmentGroupNames.set(groupId, groupName);
            }
            if (typeof data.courseName === "string" && data.courseName.trim().length > 0) {
              enrollmentCourseFallbackByGroup.set(groupId, data.courseName.trim());
            }
            registerGroupCourses(groupId, data);
          });
        }

        enrollmentSources.forEach(({ groupId, groupName, fallbackCourseName, closures }) => {
          Object.entries(closures).forEach(([courseIdRaw, closureRaw]) => {
            const closure = closureRaw as CourseClosure;
            if (!closure || typeof closure !== "object") return;
            const globalExamData = resolveGlobalExamData(closure);

            const courseId = courseIdRaw.trim();
            const closureCourseNameRaw = (closure as { courseName?: unknown }).courseName;
            const closureCourseName =
              typeof closureCourseNameRaw === "string" ? closureCourseNameRaw.trim() : "";
            const courseName = resolveCourseName(
              groupId,
              courseId,
              closureCourseName,
              fallbackCourseName,
            );
            const finalGrade = toNumberOrNull(closure.finalGrade);
            const autoGrade = toNumberOrNull(closure.autoGrade);
            const closedAt = toDateOrNull(closure.closedAt);
            const updatedAt = toDateOrNull(closure.updatedAt);
            const resolvedGroupName = enrollmentGroupNames.get(groupId) ?? groupName;
            const key = buildRowKey(groupId, resolvedGroupName, courseId, courseName);

            upsertClosureRow({
              id: key,
              groupId,
              courseId,
              groupName: resolvedGroupName,
              courseName,
              status: closure.status === "closed" ? "closed" : "open",
              finalGrade,
              autoGrade,
              globalExamGrade: globalExamData.globalExamGrade,
              globalExamSource: globalExamData.globalExamSource,
              pendingUngradedCount:
                typeof closure.pendingUngradedCount === "number"
                  ? closure.pendingUngradedCount
                  : null,
              closedAt,
              updatedAt,
            });
          });
        });

        type SubmissionAgg = {
          id: string;
          groupId: string;
          groupName: string;
          courseId: string;
          courseName: string;
          total: number;
          graded: number;
          numericCount: number;
          numericSum: number;
          latestAt: Date | null;
        };

        const submissionAggByKey = new Map<string, SubmissionAgg>();
        const groupsToReadSubmissions = Array.from(
          normalizedScopeGroupIds.length > 0
            ? new Set([...normalizedScopeGroupIds, ...Array.from(groupIds)])
            : groupIds,
        );
        const submissionsByGroupResults = await Promise.allSettled(
          groupsToReadSubmissions.map(async (groupId) => {
            const groupName = enrollmentGroupNames.get(groupId) ?? "Sin grupo";
            const fallbackCourseName =
              enrollmentCourseFallbackByGroup.get(groupId) ?? "Sin materia";
            const submissionsSnap = await getDocs(
              query(
                collection(db, "groups", groupId, "submissions"),
                where("studentId", "==", studentId),
              ),
            );
            return {
              groupId,
              groupName,
              fallbackCourseName,
              docs: submissionsSnap.docs,
            };
          }),
        );

        const courseIdsToLookup = new Set<string>();

        enrollmentSources.forEach(({ groupId, fallbackCourseName, closures }) => {
          Object.entries(closures).forEach(([courseIdRaw, closureRaw]) => {
            const closure = closureRaw as CourseClosure & { courseName?: unknown };
            if (!closure || typeof closure !== "object") return;
            const courseId = courseIdRaw.trim();
            const closureCourseName =
              typeof closure.courseName === "string" ? closure.courseName.trim() : "";
            if (needsCourseLookup(groupId, courseId, closureCourseName, fallbackCourseName)) {
              courseIdsToLookup.add(courseId);
            }
          });
        });

        let skippedGroupsByPermission = 0;
        const submissionsByGroupValues = submissionsByGroupResults.flatMap((result) => {
          if (result.status === "rejected") {
            if (isPermissionDeniedError(result.reason)) {
              skippedGroupsByPermission += 1;
              return [];
            }
            throw result.reason;
          }
          return [result.value];
        });

        submissionsByGroupValues.forEach(({ groupId, fallbackCourseName, docs }) => {
          docs.forEach((submissionDoc) => {
            const data = submissionDoc.data() as {
              courseId?: string;
              courseTitle?: string;
            };
            const courseId = (data.courseId ?? "").trim();
            const courseTitle = (data.courseTitle ?? "").trim();
            if (needsCourseLookup(groupId, courseId, courseTitle, fallbackCourseName)) {
              courseIdsToLookup.add(courseId);
            }
          });
        });

        if (courseIdsToLookup.size > 0) {
          const courseIdsToLookupList = Array.from(courseIdsToLookup);
          const courseDocResults = await Promise.allSettled(
            courseIdsToLookupList.map((courseId) => getDoc(doc(db, "courses", courseId))),
          );
          courseDocResults.forEach((result, index) => {
            const courseId = courseIdsToLookupList[index];
            if (result.status === "rejected") {
              if (isPermissionDeniedError(result.reason)) return;
              throw result.reason;
            }
            if (!result.value.exists()) return;
            const data = result.value.data() as { title?: unknown; courseName?: unknown };
            const title =
              typeof data.title === "string" && data.title.trim().length > 0
                ? data.title.trim()
                : typeof data.courseName === "string" && data.courseName.trim().length > 0
                  ? data.courseName.trim()
                  : "";
            if (title) {
              courseTitleById.set(courseId, title);
            }
          });

          const unresolvedCourseIds = courseIdsToLookupList.filter(
            (courseId) => !courseTitleById.has(courseId),
          );

          if (unresolvedCourseIds.length > 0) {
            const groupLookups = await Promise.allSettled(
              unresolvedCourseIds.map(async (courseId) => {
                const directGroupsQuery = query(
                  collection(db, "groups"),
                  where("courseId", "==", courseId),
                );
                const arrayGroupsQuery = query(
                  collection(db, "groups"),
                  where("courseIds", "array-contains", courseId),
                );

                const [directSnap, arraySnap] = await Promise.allSettled([
                  getDocs(directGroupsQuery),
                  getDocs(arrayGroupsQuery),
                ]);

                const docs = [
                  ...(directSnap.status === "fulfilled" ? directSnap.value.docs : []),
                  ...(arraySnap.status === "fulfilled" ? arraySnap.value.docs : []),
                ];

                for (const groupDoc of docs) {
                  const groupData = groupDoc.data() as {
                    courseId?: unknown;
                    courseName?: unknown;
                    courses?: unknown;
                  };
                  const courseNameById = getCourseNameFromGroupData(groupData);
                  const resolvedName = courseNameById.get(courseId)?.trim() ?? "";
                  if (resolvedName) {
                    return { courseId, courseName: resolvedName };
                  }
                  const legacyCourseId =
                    typeof groupData.courseId === "string" ? groupData.courseId.trim() : "";
                  const legacyCourseName =
                    typeof groupData.courseName === "string" ? groupData.courseName.trim() : "";
                  if (legacyCourseId === courseId && legacyCourseName) {
                    return { courseId, courseName: legacyCourseName };
                  }
                }

                return { courseId, courseName: "" };
              }),
            );

            groupLookups.forEach((result) => {
              if (result.status === "rejected") {
                if (isPermissionDeniedError(result.reason)) return;
                throw result.reason;
              }
              const resolvedName = result.value.courseName.trim();
              if (resolvedName) {
                courseTitleById.set(result.value.courseId, resolvedName);
              }
            });
          }
        }

        submissionsByGroupValues.forEach(({ groupId, groupName, fallbackCourseName, docs }) => {
          docs.forEach((submissionDoc) => {
            const data = submissionDoc.data() as {
              courseId?: string;
              courseTitle?: string;
              status?: string;
              grade?: number;
              submittedAt?: unknown;
              gradedAt?: unknown;
            };
            const courseId = (data.courseId ?? "").trim();
            const courseTitle = (data.courseTitle ?? "").trim();
            const courseName = resolveCourseName(
              groupId,
              courseId,
              courseTitle,
              fallbackCourseName,
            );
            const key = buildRowKey(groupId, groupName, courseId, courseName);

            const current =
              submissionAggByKey.get(key) ??
              {
                id: key,
                groupId,
                groupName,
                courseId,
                courseName,
                total: 0,
                graded: 0,
                numericCount: 0,
                numericSum: 0,
                latestAt: null,
              };

            current.total += 1;
            const isGraded = data.status === "graded" || typeof data.grade === "number";
            if (isGraded) current.graded += 1;
            if (typeof data.grade === "number" && Number.isFinite(data.grade)) {
              current.numericCount += 1;
              current.numericSum += data.grade;
            }
            const candidateDate =
              toDateOrNull(data.gradedAt) ?? toDateOrNull(data.submittedAt);
            if (candidateDate && (!current.latestAt || candidateDate > current.latestAt)) {
              current.latestAt = candidateDate;
            }

            submissionAggByKey.set(key, current);
          });
        });

        const resolvedClosureRows = rebuildResolvedRows(closureRows);
        const mergedRows = new Map<string, GradeRow>();

        submissionAggByKey.forEach((agg) => {
          mergedRows.set(agg.id, {
            id: agg.id,
            groupId: agg.groupId,
            courseId: agg.courseId,
            groupName: agg.groupName,
            courseName: agg.courseName,
            status: "open",
            finalGrade: null,
            autoGrade: agg.numericCount > 0 ? agg.numericSum / agg.numericCount : null,
            globalExamGrade: null,
            globalExamSource: null,
            pendingUngradedCount: Math.max(agg.total - agg.graded, 0),
            closedAt: null,
            updatedAt: agg.latestAt,
          });
        });

        resolvedClosureRows.forEach((closureRow, key) => {
          const current = mergedRows.get(key);
          if (!current) {
            mergedRows.set(key, closureRow);
            return;
          }

          mergedRows.set(key, {
            ...current,
            status: closureRow.status,
            finalGrade: closureRow.finalGrade ?? current.finalGrade,
            autoGrade: closureRow.autoGrade ?? current.autoGrade,
            globalExamGrade: closureRow.globalExamGrade ?? current.globalExamGrade,
            globalExamSource: closureRow.globalExamSource ?? current.globalExamSource,
            pendingUngradedCount:
              closureRow.pendingUngradedCount ?? current.pendingUngradedCount,
            closedAt: closureRow.closedAt ?? current.closedAt,
            updatedAt: closureRow.updatedAt ?? current.updatedAt,
          });
        });

        const nextRows = Array.from(mergedRows.values()).sort(
          (a, b) => getRowTs(b) - getRowTs(a),
        );

        console.log("[Kardex][debug] filas finales", nextRows.length, nextRows.map((r) => ({
          grupo: r.groupName,
          groupId: r.groupId,
          materia: r.courseName,
          estado: r.status,
          final: r.finalGrade,
          auto: r.autoGrade,
        })));

        if (!active) return;
        setRows(nextRows);
        if (!isScopedAccess && (enrollmentPermissionDenied || skippedGroupsByPermission > 0)) {
          toast.error("Algunas materias no pudieron cargarse por permisos de lectura.");
        }
      } catch (err) {
        console.error("Error cargando kardex:", err);
        if (active) {
          setRows([]);
          toast.error("No se pudo cargar el kardex de calificaciones");
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    loadGrades();
    return () => {
      active = false;
    };
  }, [isOpen, scopeGroupIds, scopePlantelId, studentId]);

  const summary = useMemo(() => {
    const closed = rows.filter((row) => row.status === "closed");
    const graded = closed.filter((row) => typeof row.finalGrade === "number");
    const avg =
      graded.length > 0
        ? graded.reduce((acc, row) => acc + (row.finalGrade ?? 0), 0) / graded.length
        : null;
    return {
      total: rows.length,
      closed: closed.length,
      avg,
    };
  }, [rows]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-full max-w-5xl p-0">
        <div className="border-b border-slate-200 px-6 py-4">
          <DialogHeader className="mb-1">
            <DialogTitle>Kardex de calificaciones</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">
            {studentName} · {studentEmail}
          </p>
        </div>

        <div className="space-y-4 p-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Materias</p>
              <p className="text-lg font-semibold text-slate-900">{summary.total}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Cerradas</p>
              <p className="text-lg font-semibold text-emerald-700">{summary.closed}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Promedio final</p>
              <p className="text-lg font-semibold text-blue-700">
                {summary.avg === null ? "—" : summary.avg.toFixed(1)}
              </p>
            </div>
          </div>

          {loading ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
              Cargando calificaciones...
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
              No hay calificaciones registradas para este alumno.
            </div>
          ) : (
            <div className="max-h-[52vh] overflow-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-sm text-slate-800">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr className="border-b border-slate-200">
                    <th className="px-4 py-2 text-left">Grupo</th>
                    <th className="px-4 py-2 text-left">Materia</th>
                    <th className="px-4 py-2 text-left">Estado</th>
                    <th className="px-4 py-2 text-left">Examen global</th>
                    <th className="px-4 py-2 text-left">Calificación final</th>
                    <th className="px-4 py-2 text-left">Pendientes</th>
                    <th className="px-4 py-2 text-left">Actualizado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-4 py-3">{row.groupName}</td>
                      <td className="px-4 py-3">{row.courseName}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                            row.status === "closed"
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {row.status === "closed" ? "Cerrada" : "Abierta"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        <div className="flex flex-col gap-1">
                          <span>
                            {row.globalExamGrade === null ? "—" : row.globalExamGrade.toFixed(1)}
                          </span>
                          {row.globalExamSource === "regularization" ? (
                            <span className="inline-flex w-fit rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                              Regularizacion
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        {row.finalGrade === null ? "—" : row.finalGrade.toFixed(1)}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {row.pendingUngradedCount === null ? "—" : row.pendingUngradedCount}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {formatDate(row.closedAt ?? row.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
