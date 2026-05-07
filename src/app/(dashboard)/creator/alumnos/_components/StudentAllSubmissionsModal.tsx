"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Submission, deleteSubmission } from "@/lib/firebase/submissions-service";
import { collection, collectionGroup, query, where, getDocs, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import toast from "react-hot-toast";

type Props = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  scopePlantelId?: string;
  readOnly?: boolean;
  isOpen: boolean;
  onClose: () => void;
};

type SubmissionWithGroup = Submission & {
  groupId: string;
  groupName?: string;
};

type GroupMapEntry = {
  groupName: string;
  courseNameMap: Map<string, string>;
};

const parseTimestamp = (value: unknown): Date | null => {
  if (!value || typeof value !== "object") return null;
  const maybeTimestamp = value as { toDate?: () => Date };
  return typeof maybeTimestamp.toDate === "function" ? maybeTimestamp.toDate() : null;
};

const normalizeStatus = (value: unknown): "pending" | "graded" | "late" => {
  if (value === "pending" || value === "graded" || value === "late") return value;
  return "pending";
};

async function buildGroupsMap(
  groupIds: string[],
  requiredPlantelId?: string,
): Promise<Map<string, GroupMapEntry>> {
  const groupsMap = new Map<string, GroupMapEntry>();
  if (groupIds.length === 0) return groupsMap;

  for (let i = 0; i < groupIds.length; i += 30) {
    const batch = groupIds.slice(i, i + 30);
    const groupsQuery = query(collection(db, "groups"), where("__name__", "in", batch));
    const groupsSnap = await getDocs(groupsQuery);
    groupsSnap.docs.forEach((groupDoc) => {
      const groupData = groupDoc.data() as Record<string, unknown>;
      const groupPlantelId =
        typeof groupData.plantelId === "string" ? groupData.plantelId.trim() : "";
      if (requiredPlantelId && groupPlantelId !== requiredPlantelId) return;
      const courseNameMap = new Map<string, string>();
      const coursesArray = Array.isArray(groupData.courses) ? groupData.courses : [];
      coursesArray.forEach((course) => {
        if (!course || typeof course !== "object") return;
        const c = course as { courseId?: unknown; courseName?: unknown };
        if (typeof c.courseId === "string" && c.courseId.trim()) {
          courseNameMap.set(
            c.courseId.trim(),
            typeof c.courseName === "string" ? c.courseName : "",
          );
        }
      });
      if (
        typeof groupData.courseId === "string" &&
        groupData.courseId.trim() &&
        typeof groupData.courseName === "string"
      ) {
        courseNameMap.set(groupData.courseId.trim(), groupData.courseName);
      }
      groupsMap.set(groupDoc.id, {
        groupName: typeof groupData.groupName === "string" && groupData.groupName.trim()
          ? groupData.groupName
          : "Sin nombre",
        courseNameMap,
      });
    });
  }

  return groupsMap;
}

function mapSubmissionDoc(
  submissionId: string,
  groupId: string,
  groupName: string,
  data: Record<string, unknown>,
): SubmissionWithGroup {
  return {
    id: submissionId,
    groupId,
    groupName,
    classId: typeof data.classId === "string" ? data.classId : "",
    classDocId: typeof data.classDocId === "string" ? data.classDocId : undefined,
    courseId: typeof data.courseId === "string" ? data.courseId : undefined,
    courseTitle: typeof data.courseTitle === "string" ? data.courseTitle : undefined,
    className: typeof data.className === "string" ? data.className : "",
    classType: typeof data.classType === "string" ? data.classType : "",
    studentId: typeof data.studentId === "string" ? data.studentId : "",
    studentName: typeof data.studentName === "string" ? data.studentName : "",
    submittedAt: parseTimestamp(data.submittedAt),
    fileUrl: typeof data.fileUrl === "string" ? data.fileUrl : "",
    audioUrl: typeof data.audioUrl === "string" ? data.audioUrl : "",
    content: typeof data.content === "string" ? data.content : "",
    status: normalizeStatus(data.status),
    grade: typeof data.grade === "number" && Number.isFinite(data.grade) ? data.grade : undefined,
    feedback: typeof data.feedback === "string" ? data.feedback : "",
    gradedAt: parseTimestamp(data.gradedAt),
    gradedById: typeof data.gradedById === "string" ? data.gradedById : undefined,
    gradedByName: typeof data.gradedByName === "string" ? data.gradedByName : undefined,
  };
}

export function StudentAllSubmissionsModal({
  studentId,
  studentName,
  studentEmail,
  scopePlantelId = "",
  readOnly = false,
  isOpen,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [submissions, setSubmissions] = useState<SubmissionWithGroup[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedCourseId, setSelectedCourseId] = useState("all");
  const [selectedType, setSelectedType] = useState("all");

  useEffect(() => {
    if (!isOpen) return;
    // Reset filters when modal opens
    setSelectedCourseId("all");
    setSelectedType("all");
    const load = async () => {
      setLoading(true);
      try {
        const allSubmissions: SubmissionWithGroup[] = [];
        let groupsMap = new Map<string, { groupName: string; courseNameMap: Map<string, string> }>();

        if (readOnly && scopePlantelId) {
          const enrollmentQuery = query(
            collection(db, "studentEnrollments"),
            where("studentId", "==", studentId),
            where("plantelId", "==", scopePlantelId),
          );
          const enrollmentsSnap = await getDocs(enrollmentQuery);
          const groupIds = Array.from(
            new Set(
              enrollmentsSnap.docs
                .map((docSnap) => {
                  const enrollmentData = docSnap.data() as Record<string, unknown>;
                  return typeof enrollmentData.groupId === "string" ? enrollmentData.groupId : "";
                })
                .filter((groupId): groupId is string => groupId.length > 0),
            ),
          );
          groupsMap = await buildGroupsMap(groupIds, scopePlantelId);

          await Promise.all(
            Array.from(groupsMap.entries()).map(async ([groupId, groupInfo]) => {
              const submissionsQuery = query(
                collection(db, "groups", groupId, "submissions"),
                where("studentId", "==", studentId),
              );
              const submissionsSnap = await getDocs(submissionsQuery);
              submissionsSnap.docs.forEach((submissionDoc) => {
                allSubmissions.push(
                  mapSubmissionDoc(
                    submissionDoc.id,
                    groupId,
                    groupInfo.groupName,
                    submissionDoc.data() as Record<string, unknown>,
                  ),
                );
              });
            }),
          );
        } else {
          const submissionsQuery = query(
            collectionGroup(db, "submissions"),
            where("studentId", "==", studentId),
            orderBy("submittedAt", "desc"),
          );
          const submissionsSnap = await getDocs(submissionsQuery);
          const groupIds = Array.from(
            new Set(
              submissionsSnap.docs
                .map((docSnap) => {
                  const pathParts = docSnap.ref.path.split("/");
                  return pathParts[0] === "groups" && pathParts[1] ? pathParts[1] : "";
                })
                .filter((groupId): groupId is string => groupId.length > 0),
            ),
          );
          groupsMap = await buildGroupsMap(groupIds);

          submissionsSnap.docs.forEach((submissionDoc) => {
            const pathParts = submissionDoc.ref.path.split("/");
            const groupId = pathParts[1] ?? "";
            if (!groupId) return;
            const groupInfo = groupsMap.get(groupId);
            allSubmissions.push(
              mapSubmissionDoc(
                submissionDoc.id,
                groupId,
                groupInfo?.groupName ?? "Sin nombre",
                submissionDoc.data() as Record<string, unknown>,
              ),
            );
          });
        }

        // 4. Consultar foros usando collectionGroup
        try {
          const forumsQuery = query(
            collectionGroup(db, "forums"),
            where("authorId", "==", studentId)
          );
          const forumsSnap = await getDocs(forumsQuery);

          // Usar Set para evitar duplicados de foros
          const seenForumIds = new Set<string>();
          forumsSnap.docs.forEach((forumDoc) => {
            const uniqueForumKey = forumDoc.ref.path;
            if (seenForumIds.has(uniqueForumKey)) return;
            seenForumIds.add(uniqueForumKey);

            const forumData = forumDoc.data();
            const pathParts = forumDoc.ref.path.split("/");
            const courseId = pathParts[1] ?? "";
            const lessonId = pathParts[3] ?? "";
            const classId = pathParts[5] ?? "";

            // Buscar el grupo que tiene este curso
            let groupId = "";
            let groupName = "Sin nombre";
            let courseTitle = "";
            for (const [gId, gInfo] of groupsMap.entries()) {
              if (gInfo.courseNameMap.has(courseId)) {
                groupId = gId;
                groupName = gInfo.groupName;
                courseTitle = gInfo.courseNameMap.get(courseId) ?? "";
                break;
              }
            }
            if (!groupId) return;

            allSubmissions.push({
              id: `forum-${courseId}-${lessonId}-${classId}-${forumDoc.id}`,
              groupId,
              groupName,
              classId,
              classDocId: classId,
              courseId,
              courseTitle,
              className: forumData.classTitle ?? "Foro",
              classType: "forum",
              studentId: forumData.authorId ?? "",
              studentName: forumData.authorName ?? "",
              submittedAt: forumData.createdAt?.toDate?.() ?? null,
              fileUrl: forumData.mediaUrl ?? "",
              audioUrl: "",
              content: forumData.text ?? "",
              status:
                forumData.status === "graded" || typeof forumData.grade === "number"
                  ? "graded"
                  : "pending",
              grade:
                typeof forumData.grade === "number" && Number.isFinite(forumData.grade)
                  ? forumData.grade
                  : undefined,
              feedback: typeof forumData.feedback === "string" ? forumData.feedback : "",
              gradedAt: forumData.gradedAt?.toDate?.() ?? null,
              gradedById: typeof forumData.gradedById === "string" ? forumData.gradedById : undefined,
              gradedByName: typeof forumData.gradedByName === "string" ? forumData.gradedByName : undefined,
            });
          });
        } catch (forumErr) {
          console.error("Error cargando foros:", forumErr);
        }

        // Ordenar por fecha de entrega (más reciente primero)
        allSubmissions.sort((a, b) => {
          if (!a.submittedAt) return 1;
          if (!b.submittedAt) return -1;
          return b.submittedAt.getTime() - a.submittedAt.getTime();
        });

        setSubmissions(allSubmissions);
      } catch (err) {
        console.error("Error cargando submissions:", err);
        toast.error("No se pudieron cargar las tareas");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isOpen, readOnly, scopePlantelId, studentId]);

  function normalizeSubmissionType(value: string) {
    const normalized = (value || "").toLowerCase().trim();
    if (["quiz", "quizz", "cuestionario"].includes(normalized)) return "quiz";
    if (["forum", "foro", "post", "discussion"].includes(normalized)) return "forum";
    if (["assignment", "tarea", "homework"].includes(normalized)) return "assignment";
    if (["video", "text", "texto", "audio", "image", "imagen", "document", "doc"].includes(normalized)) {
      return "assignment";
    }
    return normalized || "assignment";
  }

  const handleResetSubmission = async (submission: SubmissionWithGroup) => {
    if (readOnly) {
      toast.error("Vista de solo lectura: no puedes resetear entregas.");
      return;
    }
    const normalizedType = normalizeSubmissionType(submission.classType);
    const submissionLabel = normalizedType === "forum"
      ? { label: "aporte", article: "el", pronoun: "lo" }
      : normalizedType === "quiz"
        ? { label: "quiz", article: "el", pronoun: "lo" }
        : { label: "tarea", article: "la", pronoun: "la" };
    if (
      !confirm(
        `¿Estás seguro de que deseas resetear ${submissionLabel.article} ${submissionLabel.label} "${submission.className}" del grupo "${submission.groupName}"? Esto permitirá que ${studentName} vuelva a enviar${submissionLabel.pronoun}.`
      )
    ) {
      return;
    }

    setDeletingIds((prev) => new Set(prev).add(submission.id));
    try {
      await deleteSubmission(submission.groupId, submission.id);
      const resetMessage = submissionLabel.label === "tarea"
        ? "Tarea reseteada exitosamente"
        : submissionLabel.label === "quiz"
          ? "Quiz reseteado exitosamente"
          : "Aporte reseteado exitosamente";
      toast.success(resetMessage);

      // Remover de la lista
      setSubmissions((prev) => prev.filter((s) => s.id !== submission.id));
    } catch (err) {
      console.error("Error al resetear la tarea:", err);
      toast.error("No se pudo resetear la tarea");
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(submission.id);
        return next;
      });
    }
  };

  const formatDate = (date?: Date | null) => {
    if (!date) return "-";
    return date.toLocaleString("es-MX", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getClassTypeLabel = (type: string) => {
    const normalized = normalizeSubmissionType(type);
    if (normalized === "quiz") return "Quiz";
    if (normalized === "forum") return "Foro";
    if (normalized === "assignment") return "Tarea";
    return "Tarea";
  };

  const escapeCsv = (value: string) => {
    const safe = value.replace(/"/g, "\"\"");
    return `"${safe}"`;
  };

  const formatDateIso = (date?: Date | null) => {
    if (!date) return "";
    return date.toISOString();
  };

  const buildHistoryCsv = (rows: SubmissionWithGroup[]) => {
    const header = [
      "Alumno",
      "Email",
      "Curso",
      "Grupo",
      "Tipo",
      "Actividad",
      "Estado",
      "Calificacion",
      "EnviadoISO",
      "Enviado",
      "CalificadoISO",
      "Calificado",
      "ArchivoURL",
      "AudioURL",
      "Contenido",
    ];
    const lines = [header.map(escapeCsv).join(",")];
    rows.forEach((sub) => {
      const normalizedType = normalizeSubmissionType(sub.classType);
      const status =
        sub.status === "graded" || sub.grade != null
          ? "Calificada"
          : sub.status === "late"
            ? "Tarde"
            : "Pendiente";
      const row = [
        studentName || "",
        studentEmail || "",
        sub.courseTitle || "",
        sub.groupName || "",
        getClassTypeLabel(normalizedType),
        sub.className || "",
        status,
        sub.grade != null ? `${sub.grade}` : "",
        formatDateIso(sub.submittedAt),
        formatDate(sub.submittedAt),
        formatDateIso(sub.gradedAt),
        formatDate(sub.gradedAt),
        sub.fileUrl || "",
        sub.audioUrl || "",
        sub.content || "",
      ];
      lines.push(row.map((value) => escapeCsv(String(value ?? ""))).join(","));
    });
    return lines.join("\n");
  };

  const handleDownloadHistory = () => {
    const rows = visibleSubmissions.length ? visibleSubmissions : submissions;
    if (!rows.length) {
      toast.error("No hay entregas para descargar.");
      return;
    }
    const csv = buildHistoryCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeName = studentName.replace(/[^a-zA-Z0-9-_]+/g, "_");
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `historial_tareas_${safeName}_${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const getStatusBadge = (submission: Submission) => {
    // Si tiene calificación (incluyendo quizzes auto-calificados), mostrar como calificada
    if (submission.status === "graded" || submission.grade != null) {
      const gradeColor = submission.grade != null
        ? submission.grade >= 80 ? "bg-emerald-100 text-emerald-700"
          : submission.grade >= 60 ? "bg-amber-100 text-amber-700"
          : "bg-red-100 text-red-700"
        : "bg-green-100 text-green-700";
      return (
        <span className={`rounded-full px-2 py-1 text-xs font-medium ${gradeColor}`}>
          {submission.grade != null ? `${submission.grade}` : "Calificada"}
        </span>
      );
    }
    if (submission.status === "late") {
      return (
        <span className="rounded-full bg-orange-100 px-2 py-1 text-xs font-medium text-orange-700">
          Tarde
        </span>
      );
    }
    return (
      <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700">
        Pendiente
      </span>
    );
  };

  const courseOptions = useMemo(() => {
    const options = new Map<string, string>();
    let hasNoCourse = false;
    submissions.forEach((sub) => {
      if (!sub.courseId) {
        hasNoCourse = true;
        return;
      }
      if (!options.has(sub.courseId)) {
        options.set(sub.courseId, sub.courseTitle || "Curso sin titulo");
      }
    });
    const list = Array.from(options.entries()).map(([id, label]) => ({ id, label }));
    if (hasNoCourse) {
      list.push({ id: "no-course", label: "Sin curso" });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [submissions]);

  const visibleSubmissions = useMemo(() => {
    return submissions.filter((sub) => {
      const courseMatch = selectedCourseId === "all"
        ? true
        : (sub.courseId ?? "no-course") === selectedCourseId;
      const normalizedType = normalizeSubmissionType(sub.classType);
      const typeMatch = selectedType === "all"
        ? true
        : normalizedType === selectedType;
      return courseMatch && typeMatch;
    });
  }, [submissions, selectedCourseId, selectedType]);

  useEffect(() => {
    if (selectedCourseId === "all") return;
    const isValid = courseOptions.some((opt) => opt.id === selectedCourseId);
    if (!isValid) setSelectedCourseId("all");
  }, [courseOptions, selectedCourseId]);

  useEffect(() => {
    if (selectedType === "all") return;
    const hasType = submissions.some((sub) => normalizeSubmissionType(sub.classType) === selectedType);
    if (!hasType) setSelectedType("all");
  }, [selectedType, submissions]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-w-5xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Tareas de {studentName}
            <span className="ml-2 text-sm font-normal text-slate-500">({studentEmail})</span>
          </DialogTitle>
          {readOnly ? (
            <p className="text-xs text-slate-500">
              Vista de solo lectura: puedes visualizar fecha y hora de entrega, sin resetear tareas.
            </p>
          ) : null}
        </DialogHeader>

        {loading ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
            Cargando tareas de todos los grupos...
          </div>
        ) : submissions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
            Este alumno no ha enviado ninguna tarea en ningún grupo.
          </div>
        ) : visibleSubmissions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
            No hay entregas para los filtros seleccionados.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-slate-600">
                Total de entregas: <span className="font-semibold">{visibleSubmissions.length}</span>
                {selectedCourseId !== "all" ? (
                  <span className="text-slate-400"> de {submissions.length}</span>
                ) : null}
              </p>
              <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
                <button
                  type="button"
                  onClick={handleDownloadHistory}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-blue-500 hover:text-blue-600"
                >
                  Descargar historial
                </button>
                <label className="flex items-center gap-2">
                  <span>Filtrar por curso</span>
                  <select
                    value={selectedCourseId}
                    onChange={(e) => setSelectedCourseId(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700"
                  >
                    <option value="all">Todos los cursos</option>
                    {courseOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span>Filtrar por tipo</span>
                  <select
                    value={selectedType}
                    onChange={(e) => setSelectedType(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700"
                  >
                    <option value="all">Todos</option>
                    <option value="assignment">Tarea</option>
                    <option value="forum">Foro</option>
                    <option value="quiz">Quiz</option>
                  </select>
                </label>
              </div>
            </div>
            {visibleSubmissions.map((sub) => {
              const isExpanded = expandedId === sub.id;
              return (
                <div
                  key={sub.id}
                  className="rounded-lg border border-slate-200 bg-white shadow-sm transition hover:shadow-md"
                >
                  <div className="flex items-center justify-between gap-4 p-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <h3 className="font-semibold text-slate-900">{sub.className}</h3>
                        <span className="rounded-full bg-purple-100 px-2 py-1 text-xs font-medium text-purple-700">
                          {sub.groupName}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                          {getClassTypeLabel(sub.classType)}
                        </span>
                        {getStatusBadge(sub)}
                      </div>
                      <div className="mt-1 flex items-center gap-4 text-xs text-slate-500">
                        {sub.courseTitle ? (
                          <span>Curso: {sub.courseTitle}</span>
                        ) : null}
                        <span>Tipo: {getClassTypeLabel(sub.classType)}</span>
                        <span>Enviado: {formatDate(sub.submittedAt)}</span>
                        {sub.gradedAt ? (
                          <span>Evaluó: {sub.gradedByName || "Docente"} · {formatDate(sub.gradedAt)}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? null : sub.id)}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        {isExpanded ? "Ocultar" : "Ver detalles"}
                      </button>
                      {!readOnly ? (
                        <button
                          type="button"
                          onClick={() => handleResetSubmission(sub)}
                          disabled={deletingIds.has(sub.id)}
                          className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 hover:border-red-400 hover:bg-red-100 disabled:opacity-60"
                        >
                          {deletingIds.has(sub.id) ? "Reseteando..." : "Resetear"}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {isExpanded ? (
                    <div className="border-t border-slate-200 bg-slate-50 p-4">
                      <div className="grid gap-4 md:grid-cols-2">
                        {sub.fileUrl ? (
                          <div>
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                              Archivo adjunto
                            </p>
                            <a
                              href={sub.fileUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                            >
                              <svg
                                className="h-4 w-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                />
                              </svg>
                              Descargar archivo
                            </a>
                          </div>
                        ) : null}

                        {sub.audioUrl ? (
                          <div>
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                              Audio
                            </p>
                            <audio
                              controls
                              src={sub.audioUrl}
                              className="w-full rounded-lg border border-slate-200 bg-white p-1"
                            />
                          </div>
                        ) : null}

                    {sub.classType === "quiz" ? (
                      <div>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                          Calificación
                        </p>
                        <div className={`rounded-lg p-3 text-sm font-semibold ${
                          sub.grade != null
                            ? sub.grade >= 80 ? "bg-emerald-50 text-emerald-700"
                              : sub.grade >= 60 ? "bg-amber-50 text-amber-700"
                              : "bg-red-50 text-red-700"
                            : "bg-white text-slate-900"
                        }`}>
                          {sub.grade != null ? `${sub.grade}` : "Pendiente de calificación"}
                        </div>
                      </div>
                    ) : sub.content ? (
                      <div>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                          Contenido / Enlace
                        </p>
                        <div className="rounded-lg bg-white p-3 text-sm text-slate-700">
                          {sub.content.startsWith("http") ? (
                            <a
                              href={sub.content}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              {sub.content}
                            </a>
                          ) : (
                            <p className="whitespace-pre-wrap">{sub.content}</p>
                          )}
                        </div>
                      </div>
                    ) : null}

                        {sub.feedback ? (
                          <div className="md:col-span-2">
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                              Retroalimentación
                            </p>
                            <div className="rounded-lg bg-white p-3 text-sm text-slate-700">
                              {sub.feedback}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
