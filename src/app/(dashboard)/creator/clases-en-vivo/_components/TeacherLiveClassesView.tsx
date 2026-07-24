"use client";

import Link from "next/link";
import { Download, MoreHorizontal } from "lucide-react";
import { type User } from "firebase/auth";
import { collection, getDocs } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { db } from "@/lib/firebase/firestore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  formatEsMxDateTime,
  parseDateTimeLocalToIso,
  toDateTimeLocalInputValue,
} from "@/lib/utils/date-format";

type TeacherLiveStatus =
  | "scheduled"
  | "live"
  | "processing"
  | "ready"
  | "failed"
  | "finalized";

type TeacherLiveClassItem = {
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
};

type ScheduleGroupOption = {
  groupId: string;
  groupName: string;
  courses: Array<{
    courseId: string;
    courseName: string;
  }>;
};

type TeacherLiveClassesResponse = {
  success?: boolean;
  data?: {
    items?: TeacherLiveClassItem[];
    scheduleGroups?: ScheduleGroupOption[];
    fetchedAt?: string;
  };
  error?: string;
};

type TeacherRecordingAccessResponse = {
  success?: boolean;
  data?: {
    url?: string;
    expiresAt?: string;
    objectPath?: string;
  };
  error?: string;
};

type TeacherAttendanceReportRow = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  attended: boolean;
  attendanceSeconds: number;
  attendancePercentage: number;
  joinCount: number;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
};

type TeacherAttendanceReportResponse = {
  success?: boolean;
  data?: {
    title?: string;
    linkedGroupName?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    classDurationSeconds?: number;
    rows?: TeacherAttendanceReportRow[];
  };
  error?: string;
};

type TeacherLiveClassesViewProps = {
  currentUser: User | null;
  authReady: boolean;
};

type ScheduleFormState = {
  groupId: string;
  courseId: string;
  lessonId: string;
  title: string;
  scheduledStartAtLocal: string;
  scheduledEndAtLocal: string;
  timezone: string;
};

type LessonOption = {
  lessonId: string;
  lessonTitle: string;
};

const DEFAULT_TIMEZONE = "America/Monterrey";

const STATUS_LABELS: Record<TeacherLiveStatus, string> = {
  scheduled: "Programada",
  live: "En vivo",
  processing: "Procesando grabación",
  ready: "Grabación lista",
  failed: "Con error",
  finalized: "Finalizada",
};

const STATUS_CLASSNAMES: Record<TeacherLiveStatus, string> = {
  scheduled: "bg-[#f3e3db] text-[#6e2d2d]",
  live: "bg-[#6e2d2d] text-white",
  processing: "bg-[#efe1de] text-[#7a3232]",
  ready: "bg-[#ead7d2] text-[#551b22]",
  failed: "bg-rose-100 text-rose-700",
  finalized: "bg-[#f6ece8] text-[#754848]",
};

function buildDefaultScheduleRange(timeZone: string) {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);

  const end = new Date(start.getTime() + 60 * 60 * 1000);

  return {
    start: toDateTimeLocalInputValue(start, { timeZone }),
    end: toDateTimeLocalInputValue(end, { timeZone }),
  };
}

function formatDuration(durationSec: number | null): string {
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec <= 0) {
    return "N/D";
  }

  const rounded = Math.round(durationSec);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function buildLiveHref(item: Pick<TeacherLiveClassItem, "classId" | "courseId" | "lessonId">): string {
  const searchParams = new URLSearchParams();
  searchParams.set("courseId", item.courseId);
  searchParams.set("lessonId", item.lessonId);
  return `/live/${encodeURIComponent(item.classId)}?${searchParams.toString()}`;
}

function isAttendanceReportAvailable(item: TeacherLiveClassItem): boolean {
  return (
    Boolean(item.lastEndedAt) ||
    item.sessionStatus === "ended" ||
    item.sessionStatus === "recording_ready" ||
    item.liveStatus === "processing" ||
    item.liveStatus === "ready" ||
    item.liveStatus === "finalized" ||
    item.liveStatus === "failed"
  );
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildAttendanceCsv(params: {
  item: TeacherLiveClassItem;
  report: NonNullable<TeacherAttendanceReportResponse["data"]>;
}): string {
  const rows = params.report.rows ?? [];
  const headers = [
    "Alumno",
    "Correo",
    "Asistio",
    "Tiempo conectado",
    "Segundos conectado",
    "Porcentaje",
    "Entradas",
    "Primera entrada",
    "Ultima salida",
    "Duracion de clase",
  ];
  const csvRows = [
    ["Reporte de asistencia", params.report.title || params.item.title],
    ["Grupo", params.report.linkedGroupName || params.item.linkedGroupName || "Grupo no vinculado"],
    [
      "Inicio real",
      params.report.startedAt
        ? formatEsMxDateTime(params.report.startedAt, { timeZone: params.item.timezone })
        : "N/D",
    ],
    [
      "Fin real",
      params.report.endedAt
        ? formatEsMxDateTime(params.report.endedAt, { timeZone: params.item.timezone })
        : "N/D",
    ],
    ["Duracion", formatDuration(params.report.classDurationSeconds ?? null)],
    [],
    headers,
    ...rows.map((row) => [
      row.studentName || "Sin nombre",
      row.studentEmail || "",
      row.attended ? "Si" : "No",
      formatDuration(row.attendanceSeconds),
      row.attendanceSeconds,
      `${row.attendancePercentage.toFixed(1)}%`,
      row.joinCount,
      row.firstJoinedAt
        ? formatEsMxDateTime(row.firstJoinedAt, { timeZone: params.item.timezone })
        : "",
      row.lastLeftAt
        ? formatEsMxDateTime(row.lastLeftAt, { timeZone: params.item.timezone })
        : "",
      formatDuration(params.report.classDurationSeconds ?? null),
    ]),
  ];

  return csvRows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function downloadCsv(fileName: string, csv: string) {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildAttendanceFileName(item: TeacherLiveClassItem): string {
  const safeTitle = (item.title || "clase-en-vivo")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `asistencia-${safeTitle || "clase-en-vivo"}.csv`;
}

function getInitialForm(groups: ScheduleGroupOption[]): ScheduleFormState {
  const firstGroup = groups[0] ?? null;
  const firstCourse = firstGroup?.courses[0] ?? null;
  const defaultRange = buildDefaultScheduleRange(DEFAULT_TIMEZONE);

  return {
    groupId: firstGroup?.groupId ?? "",
    courseId: firstCourse?.courseId ?? "",
    lessonId: "",
    title: "Clase en vivo",
    scheduledStartAtLocal: defaultRange.start,
    scheduledEndAtLocal: defaultRange.end,
    timezone: DEFAULT_TIMEZONE,
  };
}

export function TeacherLiveClassesView({
  currentUser,
  authReady,
}: TeacherLiveClassesViewProps) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<TeacherLiveClassItem[]>([]);
  const [scheduleGroups, setScheduleGroups] = useState<ScheduleGroupOption[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TeacherLiveStatus>("all");
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [recordingLoadingClassId, setRecordingLoadingClassId] = useState<string | null>(null);
  const [attendanceLoadingClassId, setAttendanceLoadingClassId] = useState<string | null>(null);
  const [detailsItem, setDetailsItem] = useState<TeacherLiveClassItem | null>(null);
  const [openActionsClassId, setOpenActionsClassId] = useState<string | null>(null);
  const [groupSearch, setGroupSearch] = useState("");
  const [groupResultsOpen, setGroupResultsOpen] = useState(false);
  const [form, setForm] = useState<ScheduleFormState>(() => getInitialForm([]));
  const [lessonOptions, setLessonOptions] = useState<LessonOption[]>([]);
  const [lessonsLoading, setLessonsLoading] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);

  const fetchTeacherLiveClasses = useCallback(async () => {
    if (!currentUser) return;

    setLoading(true);
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch("/api/live/classes/teacher", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const payload = (await response.json().catch(() => null)) as TeacherLiveClassesResponse | null;
      if (!response.ok || !payload?.success || !payload.data) {
        throw new Error(payload?.error || "No se pudo cargar el tablero de clases en vivo");
      }

      const nextGroups = payload.data.scheduleGroups ?? [];
      setItems(payload.data.items ?? []);
      setScheduleGroups(nextGroups);
      setFetchedAt(payload.data.fetchedAt ?? new Date().toISOString());
      setForm((current) => {
        if (current.groupId || current.courseId) return current;
        return getInitialForm(nextGroups);
      });
    } catch (error) {
      console.error(error);
      toast.error(
        error instanceof Error
          ? error.message
          : "No se pudo cargar el tablero de clases en vivo",
      );
    } finally {
      setLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!authReady || !currentUser) return;
    void fetchTeacherLiveClasses();
  }, [authReady, currentUser, fetchTeacherLiveClasses]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!openActionsClassId) return;
      if (actionsMenuRef.current?.contains(event.target as Node)) return;
      setOpenActionsClassId(null);
    };

    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [openActionsClassId]);

  const selectedGroup = useMemo(
    () => scheduleGroups.find((group) => group.groupId === form.groupId) ?? null,
    [form.groupId, scheduleGroups],
  );

  const selectedGroupName = selectedGroup?.groupName ?? "";

  const selectedGroupCourses = useMemo(
    () => selectedGroup?.courses ?? [],
    [selectedGroup],
  );

  const filteredScheduleGroups = useMemo(() => {
    const query = groupSearch.trim().toLowerCase();
    if (!query) return scheduleGroups;

    return scheduleGroups.filter((group) => {
      const haystack = [
        group.groupName,
        ...group.courses.map((course) => course.courseName),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [groupSearch, scheduleGroups]);

  useEffect(() => {
    if (!selectedGroup) return;
    if (selectedGroupCourses.some((course) => course.courseId === form.courseId)) return;
    setForm((current) => ({
      ...current,
      courseId: selectedGroupCourses[0]?.courseId ?? "",
    }));
  }, [form.courseId, selectedGroup, selectedGroupCourses]);

  const selectedCourseGroupNames = useMemo(() => {
    if (!form.courseId) return [];
    return scheduleGroups
      .filter((group) => group.courses.some((course) => course.courseId === form.courseId))
      .map((group) => group.groupName);
  }, [form.courseId, scheduleGroups]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      if (statusFilter !== "all" && item.liveStatus !== statusFilter) return false;
      if (!query) return true;

      const haystack = [
        item.title,
        item.courseTitle,
        item.lessonTitle,
        item.linkedGroupName ?? "",
        item.roomName ?? "",
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [items, search, statusFilter]);

  const summary = useMemo(
    () => ({
      total: items.length,
      live: items.filter((item) => item.liveStatus === "live").length,
      scheduled: items.filter((item) => item.liveStatus === "scheduled").length,
      ready: items.filter((item) => item.liveStatus === "ready").length,
    }),
    [items],
  );

  const openScheduleModal = useCallback(() => {
    const nextForm = getInitialForm(scheduleGroups);
    const nextGroup =
      scheduleGroups.find((group) => group.groupId === nextForm.groupId) ?? null;
    setForm(nextForm);
    setGroupSearch(nextGroup?.groupName ?? "");
    setGroupResultsOpen(false);
    setScheduleModalOpen(true);
  }, [scheduleGroups]);

  const handleSelectGroup = useCallback((group: ScheduleGroupOption) => {
    setForm((current) => ({
      ...current,
      groupId: group.groupId,
      courseId: group.courses[0]?.courseId ?? "",
      lessonId: "",
    }));
    setGroupSearch(group.groupName);
    setGroupResultsOpen(false);
  }, []);

  // Carga las lecciones de la materia seleccionada para elegir dónde va el en vivo.
  useEffect(() => {
    if (!scheduleModalOpen || !form.courseId) {
      setLessonOptions([]);
      return;
    }
    const courseId = form.courseId;
    let active = true;
    setLessonsLoading(true);
    (async () => {
      try {
        const snap = await getDocs(collection(db, "courses", courseId, "lessons"));
        if (!active) return;
        const options: LessonOption[] = snap.docs
          .map((lessonDoc) => {
            const data = lessonDoc.data() as { title?: unknown; order?: unknown; lessonNumber?: unknown };
            const orderValue =
              typeof data.order === "number"
                ? data.order
                : typeof data.lessonNumber === "number"
                ? data.lessonNumber
                : Number.MAX_SAFE_INTEGER;
            const lessonTitle =
              typeof data.title === "string" && data.title.trim().length > 0
                ? data.title.trim()
                : "Lección";
            return { lessonId: lessonDoc.id, lessonTitle, order: orderValue };
          })
          .sort((a, b) => a.order - b.order)
          .map(({ lessonId, lessonTitle }) => ({ lessonId, lessonTitle }));

        setLessonOptions(options);
        setForm((current) => {
          if (current.courseId !== courseId) return current;
          const stillValid = options.some((option) => option.lessonId === current.lessonId);
          if (stillValid) return current;
          const liveDefault = options.find(
            (option) => option.lessonTitle.trim().toLowerCase() === "clases en vivo",
          );
          return { ...current, lessonId: liveDefault?.lessonId ?? options[0]?.lessonId ?? "" };
        });
      } catch (error) {
        if (!active) return;
        console.error("No se pudieron cargar las lecciones de la materia:", error);
        setLessonOptions([]);
      } finally {
        if (active) setLessonsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [scheduleModalOpen, form.courseId]);

  const handleScheduleClass = useCallback(async () => {
    if (!currentUser) return;
    if (!form.groupId || !form.courseId || !form.title.trim() || !form.scheduledStartAtLocal.trim()) {
      toast.error("Completa grupo, materia, título e inicio.");
      return;
    }
    if (!form.lessonId) {
      toast.error("Selecciona la lección donde irá la clase en vivo.");
      return;
    }

    const scheduledStartAt = parseDateTimeLocalToIso(form.scheduledStartAtLocal, {
      timeZone: form.timezone,
    });
    if (!scheduledStartAt) {
      toast.error("La fecha de inicio no es válida.");
      return;
    }

    const scheduledEndAt = form.scheduledEndAtLocal.trim()
      ? parseDateTimeLocalToIso(form.scheduledEndAtLocal, { timeZone: form.timezone })
      : null;

    if (form.scheduledEndAtLocal.trim() && !scheduledEndAt) {
      toast.error("La fecha final no es válida.");
      return;
    }

    setSubmitting(true);
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch("/api/live/classes/teacher", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          groupId: form.groupId,
          courseId: form.courseId,
          lessonId: form.lessonId,
          title: form.title.trim(),
          scheduledStartAt,
          scheduledEndAt,
          timezone: form.timezone,
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { success?: boolean; error?: string }
        | null;

      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || "No se pudo programar la clase en vivo");
      }

      toast.success("Clase en vivo programada.");
      setScheduleModalOpen(false);
      await fetchTeacherLiveClasses();
    } catch (error) {
      console.error(error);
      toast.error(
        error instanceof Error ? error.message : "No se pudo programar la clase en vivo",
      );
    } finally {
      setSubmitting(false);
    }
  }, [currentUser, fetchTeacherLiveClasses, form]);

  const openRecording = useCallback(
    async (item: TeacherLiveClassItem) => {
      if (!currentUser) return;

      const previewWindow = window.open("", "_blank", "noopener,noreferrer");
      setRecordingLoadingClassId(item.classId);
      try {
        const token = await currentUser.getIdToken();
        const searchParams = new URLSearchParams();
        searchParams.set("courseId", item.courseId);
        searchParams.set("lessonId", item.lessonId);

        const response = await fetch(
          `/api/live/classes/${encodeURIComponent(item.classId)}/recording?${searchParams.toString()}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );

        const payload = (await response.json().catch(() => null)) as
          | TeacherRecordingAccessResponse
          | null;

        if (!response.ok || !payload?.success || !payload.data?.url) {
          throw new Error(payload?.error || "La grabación aún no está disponible");
        }

        if (previewWindow) {
          previewWindow.location.href = payload.data.url;
        } else {
          window.open(payload.data.url, "_blank", "noopener,noreferrer");
        }
      } catch (error) {
        previewWindow?.close();
        console.error(error);
        toast.error(
          error instanceof Error ? error.message : "No se pudo abrir la grabación",
        );
      } finally {
        setRecordingLoadingClassId(null);
      }
    },
    [currentUser],
  );

  const copyLiveLink = useCallback(async (item: TeacherLiveClassItem) => {
    const href = buildLiveHref(item);
    const absoluteUrl =
      typeof window !== "undefined" ? `${window.location.origin}${href}` : href;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(absoluteUrl);
      } else {
        throw new Error("clipboard-unavailable");
      }
      toast.success("Enlace copiado");
    } catch {
      // Fallback para navegadores/contextos sin permiso de portapapeles.
      window.prompt("Copia el enlace de la clase en vivo:", absoluteUrl);
    }
  }, []);

  const downloadAttendanceReport = useCallback(
    async (item: TeacherLiveClassItem) => {
      if (!currentUser) return;
      if (!isAttendanceReportAvailable(item)) {
        toast.error("El reporte estará disponible cuando termine la sesión.");
        return;
      }

      setAttendanceLoadingClassId(item.classId);
      try {
        const token = await currentUser.getIdToken();
        const searchParams = new URLSearchParams();
        searchParams.set("courseId", item.courseId);
        searchParams.set("lessonId", item.lessonId);

        const response = await fetch(
          `/api/live/classes/${encodeURIComponent(item.classId)}/attendance?${searchParams.toString()}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );

        const payload = (await response.json().catch(() => null)) as
          | TeacherAttendanceReportResponse
          | null;
        if (!response.ok || !payload?.success || !payload.data) {
          throw new Error(payload?.error || "No se pudo generar el reporte de asistencia");
        }

        downloadCsv(
          buildAttendanceFileName(item),
          buildAttendanceCsv({ item, report: payload.data }),
        );
        toast.success("Reporte de asistencia descargado.");
      } catch (error) {
        console.error(error);
        toast.error(
          error instanceof Error ? error.message : "No se pudo descargar la asistencia",
        );
      } finally {
        setAttendanceLoadingClassId(null);
      }
    },
    [currentUser],
  );

  if (!authReady) {
    return (
      <div className="creator-card rounded-xl border p-6 text-sm text-[#754848] shadow-sm">
        Cargando clases en vivo...
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="creator-card rounded-xl border p-6 text-sm text-[#754848] shadow-sm">
        No se pudo validar la sesión del profesor.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="creator-card-muted rounded-2xl border p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#9f6e61]">
                Profesor
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-[#551b22]">Clases En Vivo</h1>
              <p className="mt-2 max-w-3xl text-sm text-[#754848]">
                Revisa tus sesiones live, su estado actual y programa nuevas clases sin entrar al
                creador del curso.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void fetchTeacherLiveClasses()}
                disabled={loading}
                className="rounded-lg border border-[#d9b1a1] bg-white px-4 py-2 text-sm font-semibold text-[#6e2d2d] transition hover:bg-[#fff7f7] disabled:opacity-60"
              >
                {loading ? "Actualizando..." : "Refrescar"}
              </button>
              <button
                type="button"
                onClick={openScheduleModal}
                disabled={scheduleGroups.length === 0}
                className="rounded-lg bg-[#6e2d2d] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#551b22] disabled:opacity-60"
              >
                Programar clase
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="creator-card rounded-2xl border p-5 shadow-sm">
            <p className="text-sm text-[#9f6e61]">Tus clases live</p>
            <p className="mt-2 text-3xl font-semibold text-[#551b22]">{summary.total}</p>
            <p className="mt-1 text-xs text-[#9f6e61]">
              Última actualización: {fetchedAt ? formatEsMxDateTime(fetchedAt) : "N/D"}
            </p>
          </div>
          <div className="creator-kpi-brand rounded-2xl border p-5 shadow-sm">
            <p className="text-sm text-white/70">En vivo</p>
            <p className="mt-2 text-3xl font-semibold text-white">{summary.live}</p>
          </div>
          <div className="creator-kpi rounded-2xl border p-5 shadow-sm">
            <p className="text-sm text-[#9f6e61]">Programadas</p>
            <p className="mt-2 text-3xl font-semibold text-[#6e2d2d]">{summary.scheduled}</p>
          </div>
          <div className="creator-kpi rounded-2xl border p-5 shadow-sm">
            <p className="text-sm text-[#9f6e61]">Grabación lista</p>
            <p className="mt-2 text-3xl font-semibold text-[#551b22]">{summary.ready}</p>
          </div>
        </div>

        <div className="creator-card rounded-2xl border p-5 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-1 flex-col gap-3 sm:flex-row">
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por clase, grupo o materia..."
                className="w-full rounded-lg border border-[#d9b1a1] bg-white px-3 py-2 text-sm text-[#551b22] outline-none transition placeholder:text-[#a48484] focus:border-[#6e2d2d] focus:ring-2 focus:ring-[#6e2d2d]/10"
              />
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as "all" | TeacherLiveStatus)}
                className="rounded-lg border border-[#d9b1a1] bg-white px-3 py-2 text-sm text-[#551b22] outline-none transition focus:border-[#6e2d2d] focus:ring-2 focus:ring-[#6e2d2d]/10"
              >
                <option value="all">Todos los estados</option>
                <option value="scheduled">Programada</option>
                <option value="live">En vivo</option>
                <option value="processing">Procesando</option>
                <option value="ready">Grabación lista</option>
                <option value="finalized">Finalizada</option>
                <option value="failed">Con error</option>
              </select>
            </div>
            <p className="text-xs text-[#9f6e61]">
              Solo se muestran clases live creadas por ti.
            </p>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full divide-y divide-[#ead7d2] text-sm">
              <thead>
                <tr className="text-left text-[#8c5e57]">
                  <th className="px-3 py-3 font-medium">Título</th>
                  <th className="px-3 py-3 font-medium">Inicio</th>
                  <th className="px-3 py-3 font-medium">Estado</th>
                  <th className="px-3 py-3 font-medium">Grabación</th>
                  <th className="px-3 py-3 font-medium text-right">Menú</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1e5df]">
                {filteredItems.map((item) => (
                  <tr key={`${item.classId}-${item.lessonId}`} className="align-top text-[#754848]">
                    <td className="px-3 py-4">
                      <div className="font-semibold text-[#551b22]">{item.title}</div>
                      <div className="mt-1 text-xs text-[#8c5e57]">
                        {item.courseTitle} · {item.linkedGroupName || "Grupo no vinculado"}
                      </div>
                    </td>
                    <td className="px-3 py-4 text-sm text-[#754848]">
                      {item.scheduledStartAt
                        ? formatEsMxDateTime(item.scheduledStartAt, { timeZone: item.timezone })
                        : "N/D"}
                    </td>
                    <td className="px-3 py-4">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLASSNAMES[item.liveStatus]}`}
                      >
                        {STATUS_LABELS[item.liveStatus]}
                      </span>
                    </td>
                    <td className="px-3 py-4 text-sm text-[#754848]">
                      {item.recordingGenerated ? "Disponible" : "Pendiente"}
                    </td>
                    <td className="px-3 py-4">
                      <div className="flex justify-end">
                        <div
                          className="relative"
                          ref={openActionsClassId === item.classId ? actionsMenuRef : null}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setOpenActionsClassId((current) =>
                                current === item.classId ? null : item.classId,
                              )
                            }
                            className="inline-flex items-center gap-2 rounded-lg border border-[#d9b1a1] bg-white px-3 py-2 text-sm font-semibold text-[#6e2d2d] transition hover:bg-[#fff7f7]"
                          >
                            Acciones
                            <MoreHorizontal size={16} />
                          </button>
                          {openActionsClassId === item.classId ? (
                            <div className="absolute right-0 top-12 z-20 w-52 rounded-2xl border border-[#d9b1a1] bg-[#fffaf7] p-2 shadow-[0_20px_40px_rgba(85,27,34,0.12)]">
                              <button
                                type="button"
                                onClick={() => {
                                  setDetailsItem(item);
                                  setOpenActionsClassId(null);
                                }}
                                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm font-medium text-[#551b22] hover:bg-[#f3e3db]"
                              >
                                Info
                              </button>
                              <Link
                                href={buildLiveHref(item)}
                                className="flex rounded-xl px-3 py-2 text-sm font-semibold text-[#551b22] hover:bg-[#f3e3db]"
                                onClick={() => setOpenActionsClassId(null)}
                              >
                                Entrar
                              </Link>
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenActionsClassId(null);
                                  void copyLiveLink(item);
                                }}
                                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm font-medium text-[#551b22] hover:bg-[#f3e3db]"
                              >
                                Copiar enlace
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenActionsClassId(null);
                                  void openRecording(item);
                                }}
                                disabled={
                                  recordingLoadingClassId === item.classId ||
                                  (!item.recordingGenerated && item.liveStatus !== "ready")
                                }
                                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm font-medium text-[#551b22] hover:bg-[#f3e3db] disabled:cursor-not-allowed disabled:text-[#b99a90] disabled:hover:bg-transparent"
                              >
                                {recordingLoadingClassId === item.classId ? "Abriendo..." : "Grabación"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenActionsClassId(null);
                                  void downloadAttendanceReport(item);
                                }}
                                disabled={
                                  attendanceLoadingClassId === item.classId ||
                                  !isAttendanceReportAvailable(item)
                                }
                                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-[#551b22] hover:bg-[#f3e3db] disabled:cursor-not-allowed disabled:text-[#b99a90] disabled:hover:bg-transparent"
                              >
                                <Download size={14} />
                                {attendanceLoadingClassId === item.classId
                                  ? "Generando..."
                                  : "Asistencia CSV"}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!loading && filteredItems.length === 0 ? (
              <div className="mt-4 rounded-2xl border border-dashed border-[#d9b1a1] bg-[#fff7f7] p-10 text-center text-sm text-[#8c5e57]">
                {items.length === 0
                  ? "Aún no tienes clases en vivo programadas."
                  : "No hay resultados con el filtro actual."}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <Dialog open={scheduleModalOpen} onOpenChange={setScheduleModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader className="flex items-start justify-between gap-4">
            <DialogTitle className="text-[#551b22]">Programar clase en vivo</DialogTitle>
            <button
              type="button"
              onClick={() => setScheduleModalOpen(false)}
              aria-label="Cerrar"
              className="-mr-1 -mt-1 rounded-lg p-1.5 text-2xl leading-none text-[#a48484] hover:bg-[#f3e3db] hover:text-[#6e2d2d]"
            >
              ×
            </button>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium text-[#6e2d2d]">Grupo</label>
                <div className="relative">
                  <input
                    type="search"
                    value={groupSearch}
                    onFocus={() => setGroupResultsOpen(true)}
                    onChange={(event) => {
                      setGroupSearch(event.target.value);
                      setGroupResultsOpen(true);
                      if (event.target.value.trim() !== selectedGroupName) {
                        setForm((current) => ({ ...current, groupId: "", courseId: "" }));
                      }
                    }}
                    placeholder="Buscar grupo..."
                    className="w-full rounded-lg border border-[#d9b1a1] px-3 py-2 text-sm text-[#551b22] outline-none transition placeholder:text-[#a48484] focus:border-[#6e2d2d] focus:ring-2 focus:ring-[#6e2d2d]/10"
                  />
                  {groupResultsOpen ? (
                    <div className="absolute z-20 mt-2 max-h-56 w-full overflow-y-auto rounded-xl border border-[#d9b1a1] bg-[#fffaf7] p-2 shadow-lg">
                      {filteredScheduleGroups.length > 0 ? (
                        filteredScheduleGroups.map((group) => (
                          <button
                            key={group.groupId}
                            type="button"
                            onClick={() => handleSelectGroup(group)}
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-[#754848] hover:bg-[#f3e3db]"
                          >
                            <div className="font-medium text-[#551b22]">{group.groupName}</div>
                            <div className="text-xs text-[#8c5e57]">
                              {group.courses.map((course) => course.courseName || "Materia").join(", ")}
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-2 text-sm text-[#8c5e57]">
                          No se encontraron grupos.
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-[#6e2d2d]">Materia</label>
                <select
                  value={form.courseId}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      courseId: event.target.value,
                      lessonId: "",
                    }))
                  }
                  className="w-full rounded-lg border border-[#d9b1a1] px-3 py-2 text-sm text-[#551b22] outline-none transition focus:border-[#6e2d2d] focus:ring-2 focus:ring-[#6e2d2d]/10"
                >
                  {selectedGroupCourses.map((course) => (
                    <option key={course.courseId} value={course.courseId}>
                      {course.courseName || "Materia"}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-[#6e2d2d]">Lección</label>
              <select
                value={form.lessonId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, lessonId: event.target.value }))
                }
                disabled={lessonsLoading || lessonOptions.length === 0}
                className="w-full rounded-lg border border-[#d9b1a1] px-3 py-2 text-sm text-[#551b22] outline-none transition focus:border-[#6e2d2d] focus:ring-2 focus:ring-[#6e2d2d]/10 disabled:bg-[#f7efeb] disabled:text-[#b99a90]"
              >
                {lessonsLoading ? (
                  <option value="">Cargando lecciones...</option>
                ) : lessonOptions.length === 0 ? (
                  <option value="">No hay lecciones en esta materia</option>
                ) : (
                  lessonOptions.map((lesson) => (
                    <option key={lesson.lessonId} value={lesson.lessonId}>
                      {lesson.lessonTitle}
                    </option>
                  ))
                )}
              </select>
              <p className="mt-1 text-xs text-[#8c5e57]">
                La clase en vivo se creará dentro de esta lección.
              </p>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-[#6e2d2d]">Título</label>
              <input
                type="text"
                value={form.title}
                onChange={(event) =>
                  setForm((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="Ej. Sesión de repaso semana 4"
                className="w-full rounded-lg border border-[#d9b1a1] px-3 py-2 text-sm text-[#551b22] outline-none transition placeholder:text-[#a48484] focus:border-[#6e2d2d] focus:ring-2 focus:ring-[#6e2d2d]/10"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium text-[#6e2d2d]">
                  Fecha y hora de inicio
                </label>
                <input
                  type="datetime-local"
                  value={form.scheduledStartAtLocal}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      scheduledStartAtLocal: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-[#d9b1a1] px-3 py-2 text-sm text-[#551b22] outline-none transition focus:border-[#6e2d2d] focus:ring-2 focus:ring-[#6e2d2d]/10"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-[#6e2d2d]">
                  Fecha y hora de cierre
                </label>
                <input
                  type="datetime-local"
                  value={form.scheduledEndAtLocal}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      scheduledEndAtLocal: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-[#d9b1a1] px-3 py-2 text-sm text-[#551b22] outline-none transition focus:border-[#6e2d2d] focus:ring-2 focus:ring-[#6e2d2d]/10"
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-[#6e2d2d]">Zona horaria</label>
              <input
                type="text"
                value={form.timezone}
                onChange={(event) =>
                  setForm((current) => ({ ...current, timezone: event.target.value.trim() }))
                }
                className="w-full rounded-lg border border-[#d9b1a1] px-3 py-2 text-sm text-[#551b22] outline-none transition focus:border-[#6e2d2d] focus:ring-2 focus:ring-[#6e2d2d]/10"
              />
            </div>

            <div className="rounded-xl border border-[#d9b1a1] bg-[#fff7f7] p-4 text-sm text-[#754848]">
              La clase se crea dentro de la materia seleccionada y se vincula al grupo indicado.
              {selectedCourseGroupNames.length > 1 ? (
                <span className="block pt-2">
                  Esta materia también está asignada a: {selectedCourseGroupNames.join(", ")}.
                </span>
              ) : null}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setScheduleModalOpen(false)}
                className="rounded-lg border border-[#d9b1a1] px-4 py-2 text-sm font-semibold text-[#6e2d2d] hover:bg-[#fff7f7]"
              >
                Cerrar
              </button>
              <button
                type="button"
                onClick={() => void handleScheduleClass()}
                disabled={submitting || scheduleGroups.length === 0}
                className="rounded-lg bg-[#6e2d2d] px-4 py-2 text-sm font-semibold text-white hover:bg-[#551b22] disabled:opacity-60"
              >
                {submitting ? "Guardando..." : "Programar"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={detailsItem !== null} onOpenChange={(open) => (!open ? setDetailsItem(null) : null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-[#551b22]">Detalle de clase en vivo</DialogTitle>
          </DialogHeader>

          {detailsItem ? (
            <div className="space-y-5">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-xl font-semibold text-[#551b22]">{detailsItem.title}</h3>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLASSNAMES[detailsItem.liveStatus]}`}
                  >
                    {STATUS_LABELS[detailsItem.liveStatus]}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[#754848]">
                  {detailsItem.courseTitle} · {detailsItem.linkedGroupName || "Grupo no vinculado"}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-[#ead7d2] bg-[#fff7f7] p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-[#9f6e61]">Inicio</div>
                  <div className="mt-1 text-sm text-[#551b22]">
                    {detailsItem.scheduledStartAt
                      ? formatEsMxDateTime(detailsItem.scheduledStartAt, {
                          timeZone: detailsItem.timezone,
                        })
                      : "N/D"}
                  </div>
                </div>
                <div className="rounded-xl border border-[#ead7d2] bg-[#fff7f7] p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-[#9f6e61]">Cierre</div>
                  <div className="mt-1 text-sm text-[#551b22]">
                    {detailsItem.scheduledEndAt
                      ? formatEsMxDateTime(detailsItem.scheduledEndAt, {
                          timeZone: detailsItem.timezone,
                        })
                      : "N/D"}
                  </div>
                </div>
                <div className="rounded-xl border border-[#ead7d2] bg-[#fff7f7] p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-[#9f6e61]">Grabación</div>
                  <div className="mt-1 text-sm text-[#551b22]">
                    {detailsItem.recordingGenerated ? "Disponible" : "Pendiente"}
                  </div>
                </div>
                <div className="rounded-xl border border-[#ead7d2] bg-[#fff7f7] p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-[#9f6e61]">Duración</div>
                  <div className="mt-1 text-sm text-[#551b22]">
                    {formatDuration(detailsItem.durationSec)}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 text-sm text-[#754848] sm:grid-cols-2">
                <div>
                  <span className="font-medium text-[#551b22]">Lección:</span> {detailsItem.lessonTitle}
                </div>
                <div>
                  <span className="font-medium text-[#551b22]">Sala:</span> {detailsItem.roomName || "Pendiente"}
                </div>
                <div>
                  <span className="font-medium text-[#551b22]">Última actividad:</span>{" "}
                  {detailsItem.lastRelevantAt
                    ? formatEsMxDateTime(detailsItem.lastRelevantAt, {
                        timeZone: detailsItem.timezone,
                      })
                    : "N/D"}
                </div>
                <div>
                  <span className="font-medium text-[#551b22]">Zona horaria:</span> {detailsItem.timezone}
                </div>
                <div>
                  <span className="font-medium text-[#551b22]">Estado de sesión:</span>{" "}
                  {detailsItem.sessionStatus || "N/D"}
                </div>
                <div>
                  <span className="font-medium text-[#551b22]">Estado de grabación:</span>{" "}
                  {detailsItem.recordingStatus || "N/D"}
                </div>
                {detailsItem.playbackReadyAt ? (
                  <div className="sm:col-span-2">
                    <span className="font-medium text-[#551b22]">Grabación lista:</span>{" "}
                    {formatEsMxDateTime(detailsItem.playbackReadyAt, {
                      timeZone: detailsItem.timezone,
                    })}
                  </div>
                ) : null}
                {detailsItem.sharedGroupNames.length > 1 ? (
                  <div className="sm:col-span-2">
                    <span className="font-medium text-[#551b22]">Materia compartida con:</span>{" "}
                    {detailsItem.sharedGroupNames.join(", ")}
                  </div>
                ) : null}
              </div>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setDetailsItem(null)}
                  className="rounded-lg border border-[#d9b1a1] px-4 py-2 text-sm font-semibold text-[#6e2d2d] hover:bg-[#fff7f7]"
                >
                  Cerrar
                </button>
                <Link
                  href={buildLiveHref(detailsItem)}
                  className="rounded-lg bg-[#6e2d2d] px-4 py-2 text-sm font-semibold text-white hover:bg-[#551b22]"
                >
                  Entrar
                </Link>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
