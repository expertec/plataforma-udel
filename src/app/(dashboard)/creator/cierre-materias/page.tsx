"use client";

import { onAuthStateChanged, type User } from "firebase/auth";
import { CheckCircle2, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";

type ClosureReviewItem = {
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  teacherId: string;
  teacherName: string;
  enabledAt: string;
  estimatedCloseAt: string;
  daysSinceEnabled: number;
  weeksSinceEnabled: number;
  daysUntilDue: number;
  due: boolean;
  reviewReady: boolean;
  closedCount: number;
  openCount: number;
  totalCount: number;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin fecha";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function dueLabel(item: ClosureReviewItem): string {
  if (item.daysUntilDue <= 0) {
    const overdueDays = Math.abs(item.daysUntilDue);
    return overdueDays === 0
      ? "7 semanas cumplidas"
      : `7+ semanas, vencida hace ${overdueDays} dia${overdueDays === 1 ? "" : "s"}`;
  }
  if (!item.reviewReady) {
    return `Cierre estimado en ${item.daysUntilDue} dia${item.daysUntilDue === 1 ? "" : "s"}`;
  }
  return `6 semanas, faltan ${item.daysUntilDue} dia${item.daysUntilDue === 1 ? "" : "s"} para 7`;
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
  } catch {
    // ignore and use fallback
  }
  return "No se pudo completar la operacion";
}

export default function CourseClosureReviewPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [authReady, setAuthReady] = useState(Boolean(auth.currentUser));
  const [items, setItems] = useState<ClosureReviewItem[]>([]);
  const [reviewStartDays, setReviewStartDays] = useState(42);
  const [dueDays, setDueDays] = useState(49);
  const [loading, setLoading] = useState(true);
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [canCloseCourse, setCanCloseCourse] = useState(false);

  const loadItems = useCallback(async (user: User) => {
    setLoading(true);
    setError(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/admin/course-auto-closures?review=true", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as {
        data?: {
          reviewStartDays?: number;
          dueDays?: number;
          canClose?: boolean;
          items?: ClosureReviewItem[];
        };
      };
      setReviewStartDays(payload.data?.reviewStartDays ?? 42);
      setDueDays(payload.data?.dueDays ?? 49);
      setCanCloseCourse(payload.data?.canClose === true);
      setItems(payload.data?.items ?? []);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "No se pudo cargar la revision";
      setError(message);
      setCanCloseCourse(false);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthReady(true);
      if (user) {
        void loadItems(user);
      } else {
        setLoading(false);
      }
    });
    return unsub;
  }, [loadItems]);

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter((item) =>
      [item.groupName, item.courseName, item.teacherName]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [items, search]);

  const dueCount = useMemo(() => items.filter((item) => item.due).length, [items]);
  const reviewReadyCount = useMemo(
    () => items.filter((item) => item.reviewReady && !item.due).length,
    [items],
  );
  const estimatedCount = Math.max(items.length - dueCount - reviewReadyCount, 0);

  const closeCourse = async (item: ClosureReviewItem) => {
    if (!currentUser) return;
    const confirmed = window.confirm(
      `Cerrar "${item.courseName}" en "${item.groupName}" para ${item.openCount} alumno(s)?`,
    );
    if (!confirmed) return;

    const key = `${item.groupId}:${item.courseId}`;
    setClosingKey(key);
    setError(null);
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch("/api/admin/course-auto-closures", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "closeCourse",
          groupId: item.groupId,
          courseId: item.courseId,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as {
        data?: {
          result?: {
            closedCount?: number;
            skippedInvalidGradeCount?: number;
          };
          closedByName?: string;
        };
      };
      const closedCount = payload.data?.result?.closedCount ?? 0;
      const skipped = payload.data?.result?.skippedInvalidGradeCount ?? 0;
      toast.success(
        skipped > 0
          ? `Cerradas ${closedCount}. ${skipped} quedaron pendientes por calificacion invalida.`
          : `Materia cerrada para ${closedCount} alumno(s).`,
      );
      await loadItems(currentUser);
    } catch (closeError) {
      const message = closeError instanceof Error ? closeError.message : "No se pudo cerrar la materia";
      setError(message);
      toast.error(message);
    } finally {
      setClosingKey(null);
    }
  };

  return (
    <RoleGate allowedRole={["adminTeacher", "superAdminTeacher", "coordinadorPlantel", "director"]}>
      <div className="space-y-6 text-slate-900">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[#9f6e61]">Cierres</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#551b22]">Cierre de materias</h1>
              <p className="mt-1 text-sm text-[#754848]">
                Materias abiertas con fecha estimada de cierre. Las de {Math.floor(dueDays / 7)} semanas o mas aparecen primero,
                seguidas por las de {Math.floor(reviewStartDays / 7)} semanas.
                {!canCloseCourse ? " Vista filtrada a tus grupos relacionados." : ""}
              </p>
          </div>
          <button
            type="button"
            onClick={() => currentUser && loadItems(currentUser)}
            disabled={!authReady || loading}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-[#b67a68]/40 bg-[#fffaf7] px-4 py-2 text-sm font-medium text-[#6e2d2d] shadow-sm transition hover:-translate-y-0.5 hover:border-[#8a1f28] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw size={16} />
            Actualizar
          </button>
        </header>

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          <SummaryCard label="7 semanas o mas" value={dueCount.toString()} tone="danger" />
          <SummaryCard label="6 semanas" value={reviewReadyCount.toString()} tone="warning" />
          <SummaryCard label="Cierre futuro" value={estimatedCount.toString()} tone="neutral" />
        </div>

        <section className="creator-card overflow-hidden rounded-2xl border">
          <div className="flex flex-col gap-3 border-b border-[#d9b1a1]/60 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">Revision manual</p>
              <h2 className="text-lg font-semibold text-[#551b22]">Materias abiertas por grupo</h2>
            </div>
            <label className="relative w-full lg:w-96">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9f6e61]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar grupo, materia o profesor"
                className="w-full rounded-lg border border-[#d9b1a1]/70 bg-white px-9 py-2 text-sm text-[#551b22] outline-none transition focus:border-[#8a1f28] focus:ring-2 focus:ring-[#6e2d2d]/10"
              />
            </label>
          </div>

          {loading ? (
            <div className="px-5 py-6 text-sm text-[#754848]">Cargando materias...</div>
          ) : filteredItems.length === 0 ? (
            <div className="px-5 py-6 text-sm text-[#754848]">
              No hay materias abiertas con fecha estimada de cierre que coincidan con la busqueda.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[#d9b1a1]/60 text-left text-sm">
                <thead className="bg-[#f3e3db]/60 text-xs uppercase tracking-[0.14em] text-[#754848]">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Estado</th>
                    <th className="px-5 py-3 font-semibold">Grupo</th>
                    <th className="px-5 py-3 font-semibold">Materia</th>
                    <th className="px-5 py-3 font-semibold">Profesor</th>
                    <th className="px-5 py-3 font-semibold">Cierre estimado</th>
                    <th className="px-5 py-3 font-semibold">Avance</th>
                    {canCloseCourse ? <th className="px-5 py-3 font-semibold">Accion</th> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#d9b1a1]/50 bg-white/60">
                  {filteredItems.map((item) => {
                    const key = `${item.groupId}:${item.courseId}`;
                    return (
                      <tr key={key} className="align-top">
                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                              item.due
                                ? "bg-red-100 text-red-700"
                                : item.reviewReady
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-slate-100 text-slate-700"
                            }`}
                          >
                            <ShieldCheck size={14} />
                            {dueLabel(item)}
                          </span>
                        </td>
                        <td className="min-w-56 px-5 py-4">
                          <p className="font-semibold text-[#551b22]">{item.groupName}</p>
                          <p className="text-xs text-[#754848]">
                            {item.weeksSinceEnabled} semana(s), {item.daysSinceEnabled} dias activa
                          </p>
                        </td>
                        <td className="min-w-56 px-5 py-4 font-medium text-[#551b22]">
                          {item.courseName}
                        </td>
                        <td className="min-w-48 px-5 py-4 text-[#754848]">{item.teacherName}</td>
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">{formatDate(item.estimatedCloseAt)}</p>
                          <p className="text-xs">Habilitada: {formatDate(item.enabledAt)}</p>
                        </td>
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">
                            {item.closedCount}/{item.totalCount} cerrados
                          </p>
                          <p className="text-xs">{item.openCount} pendientes</p>
                        </td>
                        {canCloseCourse ? (
                          <td className="px-5 py-4">
                            <button
                              type="button"
                              onClick={() => closeCourse(item)}
                              disabled={closingKey === key}
                              className="inline-flex whitespace-nowrap items-center gap-2 rounded-lg bg-[#6e2d2d] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#551b22] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <CheckCircle2 size={16} />
                              {closingKey === key ? "Cerrando..." : "Cerrar materia"}
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </RoleGate>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "danger" | "warning" | "neutral";
}) {
  const toneClass =
    tone === "danger"
      ? "bg-red-100 text-red-700"
      : tone === "warning"
        ? "bg-amber-100 text-amber-700"
        : "bg-slate-100 text-slate-700";
  return (
    <div className="creator-card rounded-2xl border p-5">
      <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">{label}</p>
      <div className="mt-3 flex items-center gap-3">
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${toneClass}`}>{value}</span>
      </div>
    </div>
  );
}
