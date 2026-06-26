"use client";

import Link from "next/link";
import { type User } from "firebase/auth";
import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
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

type TeacherLiveClassesViewProps = {
  currentUser: User | null;
  authReady: boolean;
};

type ScheduleFormState = {
  groupId: string;
  courseId: string;
  title: string;
  scheduledStartAtLocal: string;
  scheduledEndAtLocal: string;
  timezone: string;
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
  scheduled: "bg-blue-100 text-blue-700",
  live: "bg-emerald-100 text-emerald-700",
  processing: "bg-amber-100 text-amber-700",
  ready: "bg-teal-100 text-teal-700",
  failed: "bg-rose-100 text-rose-700",
  finalized: "bg-slate-200 text-slate-700",
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

function getInitialForm(groups: ScheduleGroupOption[]): ScheduleFormState {
  const firstGroup = groups[0] ?? null;
  const firstCourse = firstGroup?.courses[0] ?? null;
  const defaultRange = buildDefaultScheduleRange(DEFAULT_TIMEZONE);

  return {
    groupId: firstGroup?.groupId ?? "",
    courseId: firstCourse?.courseId ?? "",
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
  const [detailsItem, setDetailsItem] = useState<TeacherLiveClassItem | null>(null);
  const [groupSearch, setGroupSearch] = useState("");
  const [groupResultsOpen, setGroupResultsOpen] = useState(false);
  const [form, setForm] = useState<ScheduleFormState>(() => getInitialForm([]));

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
    }));
    setGroupSearch(group.groupName);
    setGroupResultsOpen(false);
  }, []);

  const handleScheduleClass = useCallback(async () => {
    if (!currentUser) return;
    if (!form.groupId || !form.courseId || !form.title.trim() || !form.scheduledStartAtLocal.trim()) {
      toast.error("Completa grupo, materia, título e inicio.");
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

  if (!authReady) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
        Cargando clases en vivo...
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
        No se pudo validar la sesión del profesor.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">
                Profesor
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-slate-900">Mis Clases en Vivo</h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-600">
                Revisa tus sesiones live, su estado actual y programa nuevas clases sin entrar al
                creador del curso.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void fetchTeacherLiveClasses()}
                disabled={loading}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {loading ? "Actualizando..." : "Refrescar"}
              </button>
              <button
                type="button"
                onClick={openScheduleModal}
                disabled={scheduleGroups.length === 0}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
              >
                Programar clase
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">Tus clases live</p>
            <p className="mt-2 text-3xl font-semibold text-slate-900">{summary.total}</p>
            <p className="mt-1 text-xs text-slate-500">
              Última actualización: {fetchedAt ? formatEsMxDateTime(fetchedAt) : "N/D"}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">En vivo</p>
            <p className="mt-2 text-3xl font-semibold text-emerald-700">{summary.live}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">Programadas</p>
            <p className="mt-2 text-3xl font-semibold text-blue-700">{summary.scheduled}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">Grabación lista</p>
            <p className="mt-2 text-3xl font-semibold text-teal-700">{summary.ready}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-1 flex-col gap-3 sm:flex-row">
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por clase, grupo o materia..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-500"
              />
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as "all" | TeacherLiveStatus)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-500"
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
            <p className="text-xs text-slate-500">
              Solo se muestran clases live creadas por ti.
            </p>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="px-3 py-3 font-medium">Título</th>
                  <th className="px-3 py-3 font-medium">Inicio</th>
                  <th className="px-3 py-3 font-medium">Estado</th>
                  <th className="px-3 py-3 font-medium">Grabación</th>
                  <th className="px-3 py-3 font-medium text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredItems.map((item) => (
                  <tr key={`${item.classId}-${item.lessonId}`} className="align-top text-slate-700">
                    <td className="px-3 py-4">
                      <div className="font-semibold text-slate-900">{item.title}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {item.courseTitle} · {item.linkedGroupName || "Grupo no vinculado"}
                      </div>
                    </td>
                    <td className="px-3 py-4 text-sm text-slate-600">
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
                    <td className="px-3 py-4 text-sm text-slate-600">
                      {item.recordingGenerated ? "Disponible" : "Pendiente"}
                    </td>
                    <td className="px-3 py-4">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setDetailsItem(item)}
                          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          Info
                        </button>
                        <Link
                          href={buildLiveHref(item)}
                          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                        >
                          Entrar
                        </Link>
                        <button
                          type="button"
                          onClick={() => void openRecording(item)}
                          disabled={
                            recordingLoadingClassId === item.classId ||
                            (!item.recordingGenerated && item.liveStatus !== "ready")
                          }
                          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-white disabled:opacity-60"
                        >
                          {recordingLoadingClassId === item.classId ? "Abriendo..." : "Grabación"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!loading && filteredItems.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-slate-500">
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
          <DialogHeader>
            <DialogTitle>Programar clase en vivo</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">Grupo</label>
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
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-500"
                  />
                  {groupResultsOpen ? (
                    <div className="absolute z-20 mt-2 max-h-56 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
                      {filteredScheduleGroups.length > 0 ? (
                        filteredScheduleGroups.map((group) => (
                          <button
                            key={group.groupId}
                            type="button"
                            onClick={() => handleSelectGroup(group)}
                            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                          >
                            <div className="font-medium text-slate-900">{group.groupName}</div>
                            <div className="text-xs text-slate-500">
                              {group.courses.map((course) => course.courseName || "Materia").join(", ")}
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-2 text-sm text-slate-500">
                          No se encontraron grupos.
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">Materia</label>
                <select
                  value={form.courseId}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, courseId: event.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-500"
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
              <label className="mb-2 block text-sm font-medium text-slate-700">Título</label>
              <input
                type="text"
                value={form.title}
                onChange={(event) =>
                  setForm((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="Ej. Sesión de repaso semana 4"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-500"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
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
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-500"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
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
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">Zona horaria</label>
              <input
                type="text"
                value={form.timezone}
                onChange={(event) =>
                  setForm((current) => ({ ...current, timezone: event.target.value.trim() }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-500"
              />
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
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
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cerrar
              </button>
              <button
                type="button"
                onClick={() => void handleScheduleClass()}
                disabled={submitting || scheduleGroups.length === 0}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
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
            <DialogTitle>Detalle de clase en vivo</DialogTitle>
          </DialogHeader>

          {detailsItem ? (
            <div className="space-y-5">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-xl font-semibold text-slate-900">{detailsItem.title}</h3>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLASSNAMES[detailsItem.liveStatus]}`}
                  >
                    {STATUS_LABELS[detailsItem.liveStatus]}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  {detailsItem.courseTitle} · {detailsItem.linkedGroupName || "Grupo no vinculado"}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Inicio</div>
                  <div className="mt-1 text-sm text-slate-800">
                    {detailsItem.scheduledStartAt
                      ? formatEsMxDateTime(detailsItem.scheduledStartAt, {
                          timeZone: detailsItem.timezone,
                        })
                      : "N/D"}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Cierre</div>
                  <div className="mt-1 text-sm text-slate-800">
                    {detailsItem.scheduledEndAt
                      ? formatEsMxDateTime(detailsItem.scheduledEndAt, {
                          timeZone: detailsItem.timezone,
                        })
                      : "N/D"}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Grabación</div>
                  <div className="mt-1 text-sm text-slate-800">
                    {detailsItem.recordingGenerated ? "Disponible" : "Pendiente"}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Duración</div>
                  <div className="mt-1 text-sm text-slate-800">
                    {formatDuration(detailsItem.durationSec)}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
                <div>
                  <span className="font-medium text-slate-900">Lección:</span> {detailsItem.lessonTitle}
                </div>
                <div>
                  <span className="font-medium text-slate-900">Sala:</span> {detailsItem.roomName || "Pendiente"}
                </div>
                <div>
                  <span className="font-medium text-slate-900">Última actividad:</span>{" "}
                  {detailsItem.lastRelevantAt
                    ? formatEsMxDateTime(detailsItem.lastRelevantAt, {
                        timeZone: detailsItem.timezone,
                      })
                    : "N/D"}
                </div>
                <div>
                  <span className="font-medium text-slate-900">Zona horaria:</span> {detailsItem.timezone}
                </div>
                <div>
                  <span className="font-medium text-slate-900">Estado de sesión:</span>{" "}
                  {detailsItem.sessionStatus || "N/D"}
                </div>
                <div>
                  <span className="font-medium text-slate-900">Estado de grabación:</span>{" "}
                  {detailsItem.recordingStatus || "N/D"}
                </div>
                {detailsItem.playbackReadyAt ? (
                  <div className="sm:col-span-2">
                    <span className="font-medium text-slate-900">Grabación lista:</span>{" "}
                    {formatEsMxDateTime(detailsItem.playbackReadyAt, {
                      timeZone: detailsItem.timezone,
                    })}
                  </div>
                ) : null}
                {detailsItem.sharedGroupNames.length > 1 ? (
                  <div className="sm:col-span-2">
                    <span className="font-medium text-slate-900">Materia compartida con:</span>{" "}
                    {detailsItem.sharedGroupNames.join(", ")}
                  </div>
                ) : null}
              </div>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setDetailsItem(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cerrar
                </button>
                <Link
                  href={buildLiveHref(detailsItem)}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
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
