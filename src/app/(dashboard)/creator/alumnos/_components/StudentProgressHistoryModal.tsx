"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Award,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Clock3,
  LogIn,
  Upload,
  Wifi,
} from "lucide-react";
import toast from "react-hot-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { auth } from "@/lib/firebase/client";

type Props = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  isOpen: boolean;
  onClose: () => void;
};

type TimelineEvent = {
  id: string;
  type:
    | "login"
    | "lastLogin"
    | "submission"
    | "graded"
    | "progress"
    | "completed"
    | "liveJoined"
    | "liveLeft";
  at: string;
  title: string;
  description: string;
  groupId?: string;
  groupName?: string;
  courseId?: string;
  courseName?: string;
  classId?: string;
  className?: string;
  value?: number;
};

type CourseProgress = {
  id: string;
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  totalClasses: number;
  completedClasses: number;
  progressAverage: number;
  submissionsCount: number;
  gradedSubmissionsCount: number;
  averageGrade: number | null;
  lastActivityAt: string | null;
};

type StudentActivityResponse = {
  success?: boolean;
  error?: string;
  data?: {
    summary?: {
      courses: number;
      totalClasses: number;
      completedClasses: number;
      submissions: number;
      lastActivityAt: string | null;
    };
    courseProgress?: CourseProgress[];
    timeline?: TimelineEvent[];
  };
};

type TimelineFilter = "all" | "logins" | "submissions" | "grades" | "progress" | "live";

const eventStyles: Record<
  TimelineEvent["type"],
  {
    icon: typeof Clock3;
    dot: string;
    badge: string;
    label: string;
  }
> = {
  login: {
    icon: LogIn,
    dot: "bg-slate-600",
    badge: "bg-slate-100 text-slate-700",
    label: "Ingreso",
  },
  lastLogin: {
    icon: LogIn,
    dot: "bg-slate-600",
    badge: "bg-slate-100 text-slate-700",
    label: "Último acceso",
  },
  submission: {
    icon: Upload,
    dot: "bg-purple-600",
    badge: "bg-purple-50 text-purple-700",
    label: "Entrega",
  },
  graded: {
    icon: Award,
    dot: "bg-amber-500",
    badge: "bg-amber-50 text-amber-700",
    label: "Calificación",
  },
  progress: {
    icon: BarChart3,
    dot: "bg-blue-600",
    badge: "bg-blue-50 text-blue-700",
    label: "Avance",
  },
  completed: {
    icon: CheckCircle2,
    dot: "bg-emerald-600",
    badge: "bg-emerald-50 text-emerald-700",
    label: "Completado",
  },
  liveJoined: {
    icon: Wifi,
    dot: "bg-cyan-600",
    badge: "bg-cyan-50 text-cyan-700",
    label: "Conexión",
  },
  liveLeft: {
    icon: Wifi,
    dot: "bg-cyan-600",
    badge: "bg-cyan-50 text-cyan-700",
    label: "Salida",
  },
};

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin fecha";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatGrade(value: number | null): string {
  return value === null ? "N/D" : value.toFixed(1);
}

const filterMatchesEvent = (filter: TimelineFilter, event: TimelineEvent): boolean => {
  if (filter === "all") return true;
  if (filter === "logins") return event.type === "login" || event.type === "lastLogin";
  if (filter === "submissions") return event.type === "submission";
  if (filter === "grades") return event.type === "graded";
  if (filter === "progress") return event.type === "progress" || event.type === "completed";
  return event.type === "liveJoined" || event.type === "liveLeft";
};

export function StudentProgressHistoryModal({
  studentId,
  studentName,
  studentEmail,
  isOpen,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [courseProgress, setCourseProgress] = useState<CourseProgress[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const [summary, setSummary] = useState({
    courses: 0,
    totalClasses: 0,
    completedClasses: 0,
    submissions: 0,
    lastActivityAt: null as string | null,
  });

  useEffect(() => {
    if (!isOpen || !studentId) return;
    let active = true;

    const loadActivity = async () => {
      setLoading(true);
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) {
          throw new Error("No hay sesión activa para consultar actividad");
        }

        const response = await fetch(`/api/students/${encodeURIComponent(studentId)}/activity`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => ({}))) as StudentActivityResponse;
        if (!response.ok || payload.success !== true) {
          throw new Error(payload.error || "No se pudo cargar el historial");
        }
        if (!active) return;
        setTimelineFilter("all");
        setCourseProgress(payload.data?.courseProgress ?? []);
        setTimeline(payload.data?.timeline ?? []);
        setSummary({
          courses: payload.data?.summary?.courses ?? 0,
          totalClasses: payload.data?.summary?.totalClasses ?? 0,
          completedClasses: payload.data?.summary?.completedClasses ?? 0,
          submissions: payload.data?.summary?.submissions ?? 0,
          lastActivityAt: payload.data?.summary?.lastActivityAt ?? null,
        });
      } catch (error) {
        console.error("Error cargando historial de alumno:", error);
        if (active) {
          setCourseProgress([]);
          setTimeline([]);
          toast.error(error instanceof Error ? error.message : "No se pudo cargar el historial");
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadActivity();
    return () => {
      active = false;
    };
  }, [isOpen, studentId]);

  const completedPct = useMemo(() => {
    if (summary.totalClasses === 0) return 0;
    return Math.round((summary.completedClasses / summary.totalClasses) * 100);
  }, [summary.completedClasses, summary.totalClasses]);

  const timelineFilters = useMemo(
    () =>
      [
        { key: "all" as const, label: "Todos" },
        { key: "logins" as const, label: "Ingresos" },
        { key: "submissions" as const, label: "Entregas" },
        { key: "grades" as const, label: "Calificaciones" },
        { key: "progress" as const, label: "Avance" },
        { key: "live" as const, label: "Clases en vivo" },
      ].map((filter) => ({
        ...filter,
        count: timeline.filter((event) => filterMatchesEvent(filter.key, event)).length,
      })),
    [timeline],
  );

  const filteredTimeline = useMemo(
    () => timeline.filter((event) => filterMatchesEvent(timelineFilter, event)),
    [timeline, timelineFilter],
  );

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-full max-w-6xl p-0">
        <div className="border-b border-slate-200 px-6 py-4">
          <DialogHeader className="mb-1">
            <DialogTitle>Historial y progreso</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">
            {studentName} · {studentEmail}
          </p>
        </div>

        <div className="space-y-4 p-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Materias</p>
              <p className="text-lg font-semibold text-slate-900">{summary.courses}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Clases completadas</p>
              <p className="text-lg font-semibold text-emerald-700">
                {summary.completedClasses}/{summary.totalClasses} · {completedPct}%
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Entregas</p>
              <p className="text-lg font-semibold text-purple-700">{summary.submissions}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Última actividad</p>
              <p className="text-sm font-semibold text-blue-700">{formatDateTime(summary.lastActivityAt)}</p>
            </div>
          </div>

          <Tabs defaultValue="progress">
            <TabsList>
              <TabsTrigger value="progress">Progreso por materia</TabsTrigger>
              <TabsTrigger value="timeline">Línea de tiempo</TabsTrigger>
            </TabsList>

            <TabsContent value="progress" className="mt-4">
              {loading ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                  Cargando progreso...
                </div>
              ) : courseProgress.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                  No hay progreso registrado para este alumno.
                </div>
              ) : (
                <div className="max-h-[52vh] overflow-auto rounded-lg border border-slate-200">
                  <table className="min-w-full text-sm text-slate-800">
                    <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                      <tr className="border-b border-slate-200">
                        <th className="min-w-[170px] px-4 py-2 text-left">Grupo</th>
                        <th className="min-w-[220px] px-4 py-2 text-left">Materia</th>
                        <th className="min-w-[190px] px-4 py-2 text-left">Avance</th>
                        <th className="min-w-[120px] px-4 py-2 text-left">Entregas</th>
                        <th className="min-w-[120px] px-4 py-2 text-left">Promedio</th>
                        <th className="min-w-[160px] px-4 py-2 text-left">Última actividad</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {courseProgress.map((row) => (
                        <tr key={row.id} className="align-middle">
                          <td className="px-4 py-3 text-slate-700">{row.groupName}</td>
                          <td className="px-4 py-3 font-medium text-slate-900">{row.courseName}</td>
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <div className="flex items-center justify-between gap-3 text-xs text-slate-600">
                                <span>
                                  {row.completedClasses}/{row.totalClasses} clases
                                </span>
                                <span className="font-semibold text-blue-700">
                                  {formatPercent(row.progressAverage)}
                                </span>
                              </div>
                              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className="h-full rounded-full bg-blue-600"
                                  style={{ width: formatPercent(row.progressAverage) }}
                                />
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {row.submissionsCount} enviadas
                            <span className="block text-xs text-slate-500">
                              {row.gradedSubmissionsCount} calificadas
                            </span>
                          </td>
                          <td className="px-4 py-3 font-semibold text-slate-800">
                            {formatGrade(row.averageGrade)}
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            {formatDateTime(row.lastActivityAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="timeline" className="mt-4">
              {loading ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                  Cargando línea de tiempo...
                </div>
              ) : timeline.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                  No hay eventos registrados para este alumno.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                    {timelineFilters.map((filter) => (
                      <button
                        key={filter.key}
                        type="button"
                        onClick={() => setTimelineFilter(filter.key)}
                        className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                          timelineFilter === filter.key
                            ? "bg-white text-slate-900 shadow-sm"
                            : "text-slate-600 hover:bg-white hover:text-slate-900"
                        }`}
                      >
                        {filter.label} ({filter.count})
                      </button>
                    ))}
                  </div>

                  {filteredTimeline.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                      No hay eventos para este filtro.
                    </div>
                  ) : (
                    <div className="max-h-[54vh] overflow-auto rounded-lg border border-slate-200 bg-white p-4">
                      <div className="space-y-0">
                    {filteredTimeline.map((event, index) => {
                      const style = eventStyles[event.type] ?? eventStyles.progress;
                      const Icon = style.icon;
                      return (
                        <div key={event.id} className="relative grid grid-cols-[32px_1fr] gap-3 pb-5 last:pb-0">
                          {index < filteredTimeline.length - 1 ? (
                            <div className="absolute left-4 top-8 h-[calc(100%-2rem)] w-px bg-slate-200" />
                          ) : null}
                          <div className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full ${style.dot} text-white`}>
                            <Icon size={16} />
                          </div>
                          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.badge}`}>
                                    {style.label}
                                  </span>
                                  <p className="text-sm font-semibold text-slate-900">{event.title}</p>
                                </div>
                                <p className="mt-1 text-sm text-slate-700">{event.description}</p>
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                                  {event.courseName ? (
                                    <span className="inline-flex items-center gap-1">
                                      <BookOpen size={13} />
                                      {event.courseName}
                                    </span>
                                  ) : null}
                                  {event.groupName ? <span>{event.groupName}</span> : null}
                                  {event.value !== undefined && event.type === "liveJoined" ? (
                                    <span>{event.value} conexión{event.value === 1 ? "" : "es"}</span>
                                  ) : null}
                                </div>
                              </div>
                              <span className="whitespace-nowrap text-xs font-medium text-slate-500">
                                {formatDateTime(event.at)}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                      </div>
                    </div>
                  )}
                  </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
