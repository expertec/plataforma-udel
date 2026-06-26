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

  const selectedGroupCourses = useMemo(
    () => selectedGroup?.courses ?? [],
    [selectedGroup],
  );

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
    setForm(getInitialForm(scheduleGroups));
    setScheduleModalOpen(true);
  }, [scheduleGroups]);

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
              <h1 className="mt-2 text-2xl font-semibold text-slate-900">Clases en vivo</h1>
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

          <div className="mt-5 space-y-4">
            {filteredItems.map((item) => (
              <div
                key={`${item.classId}-${item.lessonId}`}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
              >
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold text-slate-900">{item.title}</h2>
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLASSNAMES[item.liveStatus]}`}
                      >
                        {STATUS_LABELS[item.liveStatus]}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">
                      {item.courseTitle} · {item.linkedGroupName || "Grupo no vinculado"}
                    </p>
                    <div className="mt-3 grid gap-3 text-sm text-slate-600 sm:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <span className="font-medium text-slate-800">Inicio:</span>{" "}
                        {item.scheduledStartAt
                          ? formatEsMxDateTime(item.scheduledStartAt, { timeZone: item.timezone })
                          : "N/D"}
                      </div>
                      <div>
                        <span className="font-medium text-slate-800">Fin:</span>{" "}
                        {item.scheduledEndAt
                          ? formatEsMxDateTime(item.scheduledEndAt, { timeZone: item.timezone })
                          : "N/D"}
                      </div>
                      <div>
                        <span className="font-medium text-slate-800">Grabación:</span>{" "}
                        {item.recordingGenerated ? "Disponible" : STATUS_LABELS[item.liveStatus]}
                      </div>
                      <div>
                        <span className="font-medium text-slate-800">Duración:</span>{" "}
                        {formatDuration(item.durationSec)}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2 xl:grid-cols-3">
                      <div>Lección: {item.lessonTitle}</div>
                      <div>Sala: {item.roomName || "Pendiente"}</div>
                      <div>
                        Última actividad:{" "}
                        {item.lastRelevantAt
                          ? formatEsMxDateTime(item.lastRelevantAt, { timeZone: item.timezone })
                          : "N/D"}
                      </div>
                      {item.playbackReadyAt ? (
                        <div>
                          Grabación lista:{" "}
                          {formatEsMxDateTime(item.playbackReadyAt, { timeZone: item.timezone })}
                        </div>
                      ) : null}
                      {item.sharedGroupNames.length > 1 ? (
                        <div className="sm:col-span-2 xl:col-span-3">
                          Materia compartida con: {item.sharedGroupNames.join(", ")}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 xl:justify-end">
                    <Link
                      href={buildLiveHref(item)}
                      className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
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
                      className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white disabled:opacity-60"
                    >
                      {recordingLoadingClassId === item.classId
                        ? "Abriendo..."
                        : "Ver grabación"}
                    </button>
                  </div>
                </div>
              </div>
            ))}

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
                <select
                  value={form.groupId}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, groupId: event.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-500"
                >
                  {scheduleGroups.map((group) => (
                    <option key={group.groupId} value={group.groupId}>
                      {group.groupName}
                    </option>
                  ))}
                </select>
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
    </>
  );
}
