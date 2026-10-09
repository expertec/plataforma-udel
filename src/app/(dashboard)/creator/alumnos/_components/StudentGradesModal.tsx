"use client";

import { type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
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
import { Download } from "lucide-react";
import { jsPDF } from "jspdf";
import toast from "react-hot-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { auth } from "@/lib/firebase/client";
import { db } from "@/lib/firebase/firestore";
import { isAdminTeacherRole, type UserRole } from "@/lib/firebase/roles";

type Props = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  scopePlantelId?: string;
  scopeGroupIds?: string[];
  useServerGrades?: boolean;
  userRole?: UserRole | null;
  isOpen: boolean;
  onClose: () => void;
};

type CourseClosure = {
  status?: "open" | "closed";
  finalGrade?: number;
  autoGrade?: number | null;
  globalExamGrade?: number | null;
  globalExamScore?: number | null;
  extraordinaryExamGrade?: number | null;
  extraordinaryExamScore?: number | null;
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
  extraordinaryExamGrade: number | null;
  extraordinaryExamSource: "closure" | "regularization" | null;
  pendingUngradedCount: number | null;
  closedAt: Date | null;
  updatedAt: Date | null;
};

type ApiGradeRow = Omit<GradeRow, "closedAt" | "updatedAt"> & {
  closedAt: string | null;
  updatedAt: string | null;
};

type StudentGradesApiResponse = {
  success?: boolean;
  error?: string;
  data?: {
    rows?: ApiGradeRow[];
  };
};

type GroupMeta = {
  groupName: string;
  semester: string;
  plantelName: string;
  program: string;
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

const resolveExtraordinaryExamData = (
  closure: CourseClosure,
): Pick<GradeRow, "extraordinaryExamGrade" | "extraordinaryExamSource"> => {
  const capturedGrade = toNumberOrNull(closure.extraordinaryExamGrade);
  if (capturedGrade !== null) {
    return {
      extraordinaryExamGrade: capturedGrade,
      extraordinaryExamSource: "closure",
    };
  }

  if (closure.gradeSource === "extraordinaryRegularizationExam") {
    return {
      extraordinaryExamGrade:
        toNumberOrNull(closure.extraordinaryExamScore) ?? toNumberOrNull(closure.finalGrade),
      extraordinaryExamSource: "regularization",
    };
  }

  return {
    extraordinaryExamGrade: null,
    extraordinaryExamSource: null,
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

const formatDateTime = (value: Date | null): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
};

const formatGradeValue = (value: number | null | undefined): string =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";

const formatSummaryGradeValue = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/D";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

const PASSING_GRADE = 7;
const TOTAL_PROGRAM_SUBJECTS = 48;

const toSafeFileToken = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

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

const parseApiDate = (value: string | null): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toClientGradeRow = (row: ApiGradeRow): GradeRow => ({
  ...row,
  closedAt: parseApiDate(row.closedAt),
  updatedAt: parseApiDate(row.updatedAt),
});

export function StudentGradesModal({
  studentId,
  studentName,
  studentEmail,
  scopePlantelId = "",
  scopeGroupIds = [],
  useServerGrades = false,
  userRole = null,
  isOpen,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<GradeRow[]>([]);
  const [groupMetaById, setGroupMetaById] = useState<Record<string, GroupMeta>>({});
  const [exportingKardexRowId, setExportingKardexRowId] = useState<string | null>(null);
  const pdfBackgroundDataUrlRef = useRef<string | null>(null);
  const canDownloadInstitutionalKardex = isAdminTeacherRole(userRole) || userRole === "director";

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

        if (useServerGrades || isScopedAccess) {
          const token = await auth.currentUser?.getIdToken();
          if (!token) {
            throw new Error("No hay sesión activa para consultar calificaciones");
          }

          const response = await fetch(`/api/students/${encodeURIComponent(studentId)}/grades`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
            },
            cache: "no-store",
          });
          const payload = (await response.json().catch(() => ({}))) as StudentGradesApiResponse;
          if (!response.ok || payload.success !== true) {
            throw new Error(payload.error || "No se pudo cargar el kardex de calificaciones");
          }

          if (!active) return;
          setRows((payload.data?.rows ?? []).map(toClientGradeRow));
          return;
        }

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
            const extraordinaryExamData = resolveExtraordinaryExamData(closure);

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
              extraordinaryExamGrade: extraordinaryExamData.extraordinaryExamGrade,
              extraordinaryExamSource: extraordinaryExamData.extraordinaryExamSource,
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
            extraordinaryExamGrade: null,
            extraordinaryExamSource: null,
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
            extraordinaryExamGrade:
              closureRow.extraordinaryExamGrade ?? current.extraordinaryExamGrade,
            extraordinaryExamSource:
              closureRow.extraordinaryExamSource ?? current.extraordinaryExamSource,
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
  }, [isOpen, scopeGroupIds, scopePlantelId, studentId, useServerGrades]);

  useEffect(() => {
    if (!isOpen || rows.length === 0) return;
    const missingGroupIds = Array.from(
      new Set(rows.map((row) => row.groupId.trim()).filter(Boolean)),
    ).filter((groupId) => !groupMetaById[groupId]);
    if (missingGroupIds.length === 0) return;

    let active = true;
    const loadGroupMeta = async () => {
      const entries = await Promise.all(
        missingGroupIds.map(async (groupId): Promise<[string, GroupMeta] | null> => {
          try {
            const groupSnap = await getDoc(doc(db, "groups", groupId));
            if (!groupSnap.exists()) return null;
            const data = groupSnap.data() as Record<string, unknown>;
            return [
              groupId,
              {
                groupName: typeof data.groupName === "string" ? data.groupName.trim() : "",
                semester: typeof data.semester === "string" ? data.semester.trim() : "",
                plantelName: typeof data.plantelName === "string" ? data.plantelName.trim() : "",
                program: typeof data.program === "string" ? data.program.trim() : "",
              },
            ];
          } catch (error) {
            if (!isPermissionDeniedError(error)) {
              console.warn("No se pudo cargar informacion del grupo para Kardex:", error);
            }
            return null;
          }
        }),
      );
      if (!active) return;
      setGroupMetaById((prev) => ({
        ...prev,
        ...Object.fromEntries(entries.filter((entry): entry is [string, GroupMeta] => entry !== null)),
      }));
    };

    void loadGroupMeta();
    return () => {
      active = false;
    };
  }, [groupMetaById, isOpen, rows]);

  const loadPdfAssetDataUrl = async (
    path: string,
    cacheRef: MutableRefObject<string | null>,
    label: string,
  ): Promise<string | null> => {
    if (cacheRef.current) return cacheRef.current;
    try {
      const response = await fetch(path, { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === "string") {
            resolve(reader.result);
            return;
          }
          reject(new Error(`No se pudo convertir ${label}`));
        };
        reader.onerror = () => reject(new Error(`No se pudo leer ${label}`));
        reader.readAsDataURL(blob);
      });
      cacheRef.current = dataUrl;
      return dataUrl;
    } catch (error) {
      console.error(`No se pudo cargar ${label} para el PDF:`, error);
      return null;
    }
  };

  const summary = useMemo(() => {
    const closed = rows.filter((row) => row.status === "closed");
    const graded = closed.filter((row) => typeof row.finalGrade === "number");
    const approved = graded.filter((row) => (row.finalGrade ?? 0) >= PASSING_GRADE);
    const avg =
      graded.length > 0
        ? graded.reduce((acc, row) => acc + (row.finalGrade ?? 0), 0) / graded.length
        : null;
    const approvedAvg =
      approved.length > 0
        ? approved.reduce((acc, row) => acc + (row.finalGrade ?? 0), 0) / approved.length
        : null;
    return {
      total: rows.length,
      closed: closed.length,
      approved: approved.length,
      avg,
      approvedAvg,
    };
  }, [rows]);

  const downloadInstitutionalKardexPdf = async () => {
    if (!canDownloadInstitutionalKardex) {
      toast.error("No tienes permisos para descargar el Kardex institucional.");
      return;
    }
    if (rows.length === 0) {
      toast.error("No hay calificaciones para descargar.");
      return;
    }

    setExportingKardexRowId("__all__");
    try {
      const pdf = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const marginX = 42;
      const contentWidth = pageWidth - marginX * 2;
      const tableTop = 250;
      const rowHeight = 34;
      const tableBottom = pageHeight - 126;
      const backgroundDataUrl = await loadPdfAssetDataUrl("/bg-pdf-01.png", pdfBackgroundDataUrlRef, "bg-pdf-01.png");
      const downloadedAt = new Date();
      const sortedRows = [...rows].sort((left, right) => {
        const leftTime = Math.max(left.closedAt?.getTime() ?? 0, left.updatedAt?.getTime() ?? 0);
        const rightTime = Math.max(right.closedAt?.getTime() ?? 0, right.updatedAt?.getTime() ?? 0);
        return rightTime - leftTime;
      });
      const primaryGroupMeta =
        sortedRows.map((row) => groupMetaById[row.groupId]).find(Boolean) ?? null;
      const resolvedPlantelName = primaryGroupMeta?.plantelName || "UDEL";
      const resolvedProgram = primaryGroupMeta?.program || "N/D";
      const columns = {
        index: { x: marginX, width: 24 },
        course: { x: marginX + 32, width: 286 },
        global: { x: pageWidth - marginX - 168, width: 44 },
        extraordinary: { x: pageWidth - marginX - 114, width: 54 },
        final: { x: pageWidth - marginX - 48, width: 48 },
      };
      let y = tableTop + 26;

      const drawPageBackground = () => {
        if (backgroundDataUrl) {
          pdf.addImage(backgroundDataUrl, "PNG", 0, 0, pageWidth, pageHeight);
        }
      };

      const drawHeader = () => {
        pdf.setTextColor(20, 20, 20);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(20);
        pdf.text("Kardex Institucional", marginX, 116);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10);
        pdf.text("Historial de calificaciones del alumno", marginX, 134);
        pdf.setTextColor(80, 80, 80);
        pdf.text(`Fecha de descarga: ${formatDateTime(downloadedAt)}`, pageWidth - marginX, 116, { align: "right" });

        pdf.setDrawColor(180, 180, 180);
        pdf.setLineWidth(1);
        pdf.line(marginX, 144, marginX + contentWidth, 144);

        const metaY = 166;
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9);
        pdf.setTextColor(60, 60, 60);
        pdf.text("ALUMNO", marginX, metaY);
        pdf.text("PLANTEL", marginX + 250, metaY);
        pdf.text("PROGRAMA", marginX + 372, metaY);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10);
        pdf.setTextColor(20, 20, 20);
        pdf.text((pdf.splitTextToSize(studentName || "Sin nombre", 220) as string[]).slice(0, 2), marginX, metaY + 15);
        pdf.text((pdf.splitTextToSize(resolvedPlantelName, 104) as string[]).slice(0, 2), marginX + 250, metaY + 15);
        pdf.text((pdf.splitTextToSize(resolvedProgram, 150) as string[]).slice(0, 2), marginX + 372, metaY + 15);

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9);
        pdf.setTextColor(20, 20, 20);
        pdf.text(`Materias: ${summary.total}`, marginX, 224);
        pdf.text(`Cerradas: ${summary.closed}`, marginX + 92, 224);
        pdf.text(`Aprobadas: ${summary.approved}`, marginX + 192, 224);
        pdf.text(
          `Promedio aprobadas: ${formatSummaryGradeValue(summary.approvedAvg)}`,
          pageWidth - marginX,
          224,
          { align: "right" },
        );

        pdf.setDrawColor(180, 180, 180);
        pdf.setLineWidth(0.7);
        pdf.line(marginX, tableTop - 24, marginX + contentWidth, tableTop - 24);
        pdf.line(marginX, tableTop + 2, marginX + contentWidth, tableTop + 2);
        pdf.setTextColor(40, 40, 40);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8.5);
        pdf.text("#", columns.index.x + 2, tableTop - 5);
        pdf.text("Materia", columns.course.x, tableTop - 5);
        pdf.text("Global", columns.global.x, tableTop - 5);
        pdf.text("Extraord.", columns.extraordinary.x, tableTop - 5);
        pdf.text("Final", columns.final.x, tableTop - 5);
      };

      const drawFooter = () => {
        pdf.setDrawColor(200, 200, 200);
        pdf.setLineWidth(0.7);
        pdf.line(marginX, pageHeight - 154, marginX + contentWidth, pageHeight - 154);
        pdf.setDrawColor(168, 200, 255);
        pdf.setLineWidth(4);
        pdf.line(marginX, pageHeight - 144, marginX, pageHeight - 102);
        pdf.setLineWidth(0.7);
        pdf.setFont("helvetica", "bolditalic");
        pdf.setFontSize(9.5);
        pdf.setTextColor(20, 20, 20);
        pdf.text(
          `El presente Kárdex de estudios ampara ${summary.approved} de las ${TOTAL_PROGRAM_SUBJECTS} asignaturas totales en el programa.`,
          marginX + 8,
          pageHeight - 136,
        );
        pdf.text(`La calificación mínima aprobatoria es de ${PASSING_GRADE}`, marginX + 8, pageHeight - 122);
        pdf.text(
          `Promedio de materias aprobadas: ${formatSummaryGradeValue(summary.approvedAvg)}`,
          marginX + 8,
          pageHeight - 108,
        );
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        pdf.setTextColor(90, 90, 90);
        pdf.text("Documento generado por Plataforma UDEL.", marginX, pageHeight - 86);
      };

      const addPage = () => {
        pdf.addPage();
        y = tableTop + 26;
        drawPageBackground();
        drawHeader();
        drawFooter();
      };

      drawPageBackground();
      drawHeader();
      drawFooter();

      sortedRows.forEach((row, index) => {
        const groupMeta = groupMetaById[row.groupId] ?? null;
        const groupLabel = groupMeta?.groupName || row.groupName || "N/D";
        const semesterLabel = groupMeta?.semester || "N/D";
        const updatedLabel = formatDate(row.closedAt ?? row.updatedAt);
        const courseLines = (pdf.splitTextToSize(row.courseName || "N/D", columns.course.width) as string[]).slice(0, 2);
        const metadataLine = `Grupo: ${groupLabel}   |   Cuatr.: ${semesterLabel}   |   Actualizado: ${updatedLabel}`;
        const currentRowHeight = Math.max(rowHeight, 24 + courseLines.length * 10);
        if (y + currentRowHeight > tableBottom) addPage();
        const rowTop = y - 14;
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8.5);
        pdf.setTextColor(20, 20, 20);
        pdf.text(String(index + 1), columns.index.x + 2, y + 4);
        pdf.text(courseLines, columns.course.x, y);
        pdf.setFontSize(7);
        pdf.setTextColor(100, 100, 100);
        pdf.text(
          (pdf.splitTextToSize(metadataLine, columns.course.width) as string[]).slice(0, 1),
          columns.course.x,
          y + 10 * courseLines.length + 3,
        );
        pdf.setFontSize(8.5);
        pdf.setTextColor(20, 20, 20);
        pdf.text(formatGradeValue(row.globalExamGrade), columns.global.x, y + 4);
        pdf.text(formatGradeValue(row.extraordinaryExamGrade), columns.extraordinary.x, y + 4);
        pdf.setFont("helvetica", "bold");
        pdf.text(formatGradeValue(row.finalGrade), columns.final.x, y + 4);
        pdf.setFont("helvetica", "normal");
        y += currentRowHeight;
        pdf.setDrawColor(220, 220, 220);
        pdf.setLineWidth(0.7);
        pdf.line(marginX, rowTop + currentRowHeight, marginX + contentWidth, rowTop + currentRowHeight);
      });

      pdf.save(
        `kardex-institucional-${toSafeFileToken(studentName) || "alumno"}-${downloadedAt
          .toISOString()
          .slice(0, 10)}.pdf`,
      );
      toast.success("Kardex institucional descargado.");
    } catch (error) {
      console.error("No se pudo generar el Kardex institucional:", error);
      toast.error("No se pudo descargar el Kardex institucional.");
    } finally {
      setExportingKardexRowId(null);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-full max-w-5xl p-0">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <DialogHeader className="mb-1">
              <DialogTitle>Kardex de calificaciones</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-slate-600">
              {studentName} · {studentEmail}
            </p>
          </div>
          {canDownloadInstitutionalKardex ? (
            <button
              type="button"
              onClick={() => void downloadInstitutionalKardexPdf()}
              disabled={loading || rows.length === 0 || exportingKardexRowId === "__all__"}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#7c152d] bg-white px-3 py-2 text-xs font-semibold text-[#7c152d] hover:bg-[#fff7f7] disabled:opacity-60"
            >
              <Download size={14} />
              <span>{exportingKardexRowId === "__all__" ? "Generando..." : "Descargar Kardex institucional"}</span>
            </button>
          ) : null}
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
                    <th className="px-4 py-2 text-left">Examen extraordinario</th>
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
                      <td className="px-4 py-3 text-slate-700">
                        <div className="flex flex-col gap-1">
                          <span>
                            {row.extraordinaryExamGrade === null
                              ? "—"
                              : row.extraordinaryExamGrade.toFixed(1)}
                          </span>
                          {row.extraordinaryExamSource === "regularization" ? (
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
