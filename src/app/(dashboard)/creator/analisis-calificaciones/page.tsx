"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import Link from "next/link";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";
import { formatEsMxDateTime } from "@/lib/utils/date-format";
import type { GradeScaleAnalysisRow, GradeCorrection } from "@/lib/students/grade-scale-analysis";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const PAGE_SIZE = 50;
const formatGradeDate = (value: string | null) => value
  ? formatEsMxDateTime(value, { timeZone: "America/Monterrey" }) : "Sin fecha registrada";

export default function GradeScaleAnalysisPage() {
  const [rows, setRows] = useState<GradeScaleAnalysisRow[]>([]);
  const [running, setRunning] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("all");
  const [page, setPage] = useState(0);
  const [correcting, setCorrecting] = useState<GradeScaleAnalysisRow | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [success, setSuccess] = useState("");
  const controller = useRef<AbortController | null>(null);
  const analyze = useCallback(async () => {
    if (controller.current && !controller.current.signal.aborted) return;
    const user = auth.currentUser;
    if (!user) { setError("Inicia sesión para ejecutar el análisis."); return; }
    const abort = new AbortController();
    controller.current = abort;
    setRows([]); setScanned(0); setComplete(false); setError(""); setPage(0); setRunning(true);
    try {
      const token = await user.getIdToken();
      if (abort.signal.aborted) return;
      for (const source of ["studentEnrollments", "studentEnrollmentsArchive"]) {
        let after = "";
        let groupOffset = 0;
        let hasMore = false;
        do {
          const params = new URLSearchParams({ source, after, groupOffset: String(groupOffset) });
          const response = await fetch(`/api/admin/grade-scale-analysis?${params}`, {
            headers: { Authorization: `Bearer ${token}` }, signal: abort.signal,
          });
          const payload = await response.json();
          if (abort.signal.aborted) return;
          if (!response.ok || !payload.success) throw new Error(payload.error || "No se pudo completar el análisis.");
          const data = payload.data as { rows: GradeScaleAnalysisRow[]; scanned: number; nextCursor: string | null; nextGroupOffset: number | null };
          setRows(current => [...current, ...data.rows]);
          setScanned(current => current + data.scanned);
          after = data.nextCursor || "";
          hasMore = Boolean(after) || data.nextGroupOffset !== null;
          groupOffset = data.nextGroupOffset ?? 0;
        } while (hasMore);
      }
      setComplete(true);
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "No se pudo completar el análisis.");
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setRunning(false);
      }
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, user => {
      controller.current?.abort();
      controller.current = null;
      setRows([]); setScanned(0); setComplete(false); setError(""); setRunning(false);
      setCorrecting(null); setHistoryOpen(false); setSuccess("");
      if (user) void analyze();
    });
    return () => {
      unsubscribe();
      controller.current?.abort();
      controller.current = null;
    };
  }, [analyze]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("es-MX");
    return rows.filter(row => (priority === "all" || row.priority === priority) &&
      `${row.studentName} ${row.studentId} ${row.groupName} ${row.courseName}`.toLocaleLowerCase("es-MX").includes(query))
      .sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high") || a.studentName.localeCompare(b.studentName, "es-MX"));
  }, [rows, search, priority]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const students = new Set(rows.map(row => row.studentId || `${row.source}/${row.enrollmentId}`)).size;

  const exportResults = async () => {
    try {
      const XLSX = await import("xlsx");
      const sheet = XLSX.utils.json_to_sheet(filtered.map(row => ({
        Alumno: row.studentName, "ID alumno": row.studentId, Grupo: row.groupName, Materia: row.courseName,
        "Nota actual /100": row.grade, "Posible nota /100": row.suggestedGrade,
        "Fecha de calificación (Monterrey)": formatGradeDate(row.gradedAt),
        "Fecha de cierre (Monterrey)": formatGradeDate(row.closedAt),
        "Cálculo automático /100": row.autoGrade, Prioridad: row.priority === "high" ? "Alta" : "Revisar",
        Motivos: row.reasons.join(" "), Origen: row.source === "studentEnrollmentsArchive" ? "Archivado" : "Actual",
        Inscripción: row.enrollmentId,
      })));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, "Revisión de escala");
      XLSX.writeFile(workbook, "analisis-escalas-calificaciones.xlsx");
    } catch { setError("No se pudo exportar el análisis. Intenta de nuevo."); }
  };

  return <RoleGate allowedRole={["adminTeacher", "superAdminTeacher", "director", "coordinadorPlantel"]}>
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Análisis de calificaciones</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">Detecta notas finales que podrían haberse capturado sobre 10. Revisa cada caso contra el acta: una nota baja también puede ser correcta. Las correcciones se guardan individualmente con su motivo e historial.</p>
        </div>
        <button onClick={() => void analyze()} disabled={running} className="rounded-lg bg-[#6e2d2d] px-4 py-2 font-semibold text-white disabled:opacity-50">{running ? "Analizando…" : "Actualizar análisis"}</button>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700" aria-live="polite">
        <p>{scanned} inscripciones revisadas · {students} alumnos con posibles casos · {rows.length} notas por revisar · {rows.filter(row => row.priority === "high").length} de prioridad alta</p>
        <p className="mt-1 text-slate-500">{running ? "Análisis en curso; los resultados son parciales." : complete ? "Análisis completo de inscripciones actuales y archivadas dentro de tu acceso." : scanned > 0 ? "Análisis incompleto; los resultados son parciales." : "El análisis se inicia automáticamente al entrar."}</p>
        {running && <button onClick={() => controller.current?.abort()} className="mt-2 font-semibold text-[#6e2d2d]">Detener análisis</button>}
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
      {success && <p role="status" className="rounded-lg bg-green-50 p-3 text-green-800">{success}</p>}
      <div className="flex flex-wrap gap-3">
        <input aria-label="Buscar alumno, grupo o materia" placeholder="Buscar alumno, grupo o materia" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-2" />
        <select aria-label="Prioridad" value={priority} onChange={event => { setPriority(event.target.value); setPage(0); }} className="rounded-lg border border-slate-300 px-3 py-2"><option value="all">Todas las prioridades</option><option value="high">Prioridad alta</option><option value="review">Por revisar</option></select>
        <button disabled={!filtered.length || running} onClick={() => void exportResults()} className="rounded-lg border border-slate-300 px-3 py-2 disabled:opacity-50">Exportar resultados filtrados</button>
        <button onClick={() => setHistoryOpen(value => !value)} className="rounded-lg border border-slate-300 px-3 py-2">{historyOpen ? "Ocultar historial" : "Ver historial de correcciones"}</button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr>{["Alumno", "Grupo / materia", "Fecha de calificación", "Nota actual", "Posible conversión", "Evidencia", "Revisión"].map(label => <th key={label} className="px-4 py-3">{label}</th>)}</tr></thead>
          <tbody>{filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(row => <tr key={`${row.source}/${row.enrollmentId}/${row.courseId}`} className="border-t border-slate-100 align-top">
            <td className="px-4 py-3"><p className="font-semibold">{row.studentName}</p><p className="text-xs text-slate-500">{row.studentId}</p></td>
            <td className="px-4 py-3"><p>{row.groupName}</p><p>{row.courseName}</p>{row.source === "studentEnrollmentsArchive" && <p className="text-xs text-slate-500">Inscripción archivada</p>}</td>
            <td className="px-4 py-3"><p>{formatGradeDate(row.gradedAt)}</p>{!row.gradedAt && row.closedAt && <p className="mt-1 text-xs text-slate-500">Cierre: {formatGradeDate(row.closedAt)}</p>}</td>
            <td className="px-4 py-3 font-semibold">{row.grade}/100</td>
            <td className="px-4 py-3">{row.suggestedGrade}/100<p className="text-xs text-slate-500">Si la escala original era de 10</p></td>
            <td className="max-w-md px-4 py-3"><p className="mb-1 font-semibold">{row.priority === "high" ? "Prioridad alta" : "Por revisar"}</p><ul className="list-disc space-y-1 pl-4">{row.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></td>
            <td className="px-4 py-3"><button disabled={running} onClick={() => setCorrecting(row)} className="mb-3 block rounded-lg bg-[#6e2d2d] px-3 py-2 font-semibold text-white disabled:opacity-50">Corregir calificación</button>{row.groupId ? <Link className="font-semibold text-[#6e2d2d] underline" href={`/creator/grupos/${encodeURIComponent(row.groupId)}`}>Abrir grupo</Link> : "Grupo no disponible"}</td>
          </tr>)}</tbody>
        </table>
        {!filtered.length && <p className="p-6 text-center text-sm text-slate-500">{complete ? "No se encontraron casos con estos filtros." : running ? "Buscando posibles casos…" : "Sin resultados disponibles."}</p>}
      </div>
      <div className="flex items-center justify-between text-sm"><span>{filtered.length} resultados · Página {currentPage + 1} de {pages}</span><div className="flex gap-3"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="disabled:opacity-40">Anterior</button><button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)} className="disabled:opacity-40">Siguiente</button></div></div>
      {historyOpen && <GradeCorrectionHistory key={historyVersion} />}
      {correcting && <GradeCorrectionDialog row={correcting} onClose={() => setCorrecting(null)} onSaved={correction => {
        setCorrecting(null);
        setSuccess(`Se corrigió la nota de ${correction.studentName}: ${correction.previousGrade} → ${correction.newGrade}/100. Registro: ${correction.id}.`);
        setHistoryOpen(true); setHistoryVersion(value => value + 1);
        void analyze();
      }} />}
    </div>
  </RoleGate>;
}

function GradeCorrectionDialog({ row, onClose, onSaved }: {
  row: GradeScaleAnalysisRow; onClose: () => void; onSaved: (correction: GradeCorrection) => void;
}) {
  const [grade, setGrade] = useState(String(row.suggestedGrade));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const user = auth.currentUser;
    if (!user) { setError("Inicia sesión para corregir la calificación."); return; }
    setSaving(true); setError("");
    try {
      requestId.current ||= crypto.randomUUID();
      const token = await user.getIdToken();
      const response = await fetch("/api/admin/grade-scale-analysis/corrections", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source: row.source, enrollmentId: row.enrollmentId, courseId: row.courseId,
          revision: row.revision, newGrade: Number(grade), reason: reason.trim(), requestId: requestId.current }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || "No se pudo guardar la corrección.");
      if (auth.currentUser?.uid === user.uid) onSaved(payload.data);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "No se pudo guardar la corrección."); }
    finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent role="dialog" aria-modal="true" aria-labelledby="grade-correction-title" className="max-w-xl">
      <DialogHeader><DialogTitle id="grade-correction-title">Corregir calificación final</DialogTitle></DialogHeader>
      <p className="font-semibold">{row.studentName}</p><p className="text-sm text-slate-600">{row.groupName} · {row.courseName}</p>
      <p className="mt-3 text-sm">Nota actual: <strong>{row.grade}/100</strong>. Posible conversión: <strong>{row.suggestedGrade}/100</strong>.</p>
      <form onSubmit={event => void submit(event)} className="mt-4 space-y-4">
        <label className="block text-sm font-medium">Nueva calificación sobre 100<input autoFocus required type="number" min="0" max="100" step="0.01" value={grade} onChange={event => setGrade(event.target.value)} disabled={saving} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
        <label className="block text-sm font-medium">Motivo y evidencia de la corrección<textarea required minLength={10} maxLength={2000} rows={3} value={reason} onChange={event => setReason(event.target.value)} disabled={saving} placeholder="Indica qué revisaste y por qué corresponde esta nota." className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
        <label className="flex gap-2 text-sm"><input required type="checkbox" disabled={saving} /><span>Revisé la evidencia y confirmo la nueva nota. Se guardarán la nota anterior, el motivo, mis datos de usuario y la fecha de corrección.</span></label>
        <p className="text-xs text-slate-500">El acta y la fecha original de calificación se conservan como antecedente.</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-3"><button type="button" disabled={saving} onClick={onClose} className="rounded-lg border px-4 py-2">Cancelar</button><button disabled={saving} className="rounded-lg bg-[#6e2d2d] px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? "Guardando…" : "Guardar corrección"}</button></div>
      </form>
    </DialogContent>
  </Dialog>;
}

function GradeCorrectionHistory() {
  const [entries, setEntries] = useState<GradeCorrection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const user = auth.currentUser;
        if (!user) throw new Error("Inicia sesión para ver el historial.");
        const token = await user.getIdToken();
        let after = "", groupOffset = 0, more = true;
        const all: GradeCorrection[] = [];
        while (more) {
          const params = new URLSearchParams({ after, groupOffset: String(groupOffset) });
          const response = await fetch(`/api/admin/grade-scale-analysis/corrections?${params}`, {
            headers: { Authorization: `Bearer ${token}` }, signal: abort.signal,
          });
          const payload = await response.json();
          if (abort.signal.aborted) return;
          if (!response.ok || !payload.success) throw new Error(payload.error || "No se pudo cargar el historial.");
          all.push(...payload.data.rows);
          after = payload.data.nextCursor || "";
          more = Boolean(after) || payload.data.nextGroupOffset !== null;
          groupOffset = payload.data.nextGroupOffset ?? 0;
        }
        setEntries(all.sort((a, b) => (b.correctedAt || "").localeCompare(a.correctedAt || "")));
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "No se pudo cargar el historial.");
      } finally { if (!abort.signal.aborted) setLoading(false); }
    })();
    return () => abort.abort();
  }, []);
  return <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
    <h2 className="text-lg font-semibold">Historial de correcciones</h2>
    <p className="text-sm text-slate-500">Registros de los alumnos dentro de tu acceso. Fechas en hora de Monterrey.</p>
    {loading && <p role="status">Cargando historial…</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {!loading && !error && !entries.length && <p className="text-sm text-slate-500">No hay correcciones registradas.</p>}
    {entries.length > 0 && <div className="overflow-x-auto"><table className="min-w-full text-left text-sm">
      <thead><tr>{["Alumno y materia", "Cambio", "Quién corrigió", "Fecha y hora", "Motivo / registro"].map(label => <th key={label} className="px-3 py-2">{label}</th>)}</tr></thead>
      <tbody>{entries.map(entry => <tr key={entry.id} className="border-t align-top">
        <td className="px-3 py-3"><p className="font-semibold">{entry.studentName}</p><p>{entry.groupName} · {entry.courseName}</p><p className="text-xs text-slate-500">{entry.source === "studentEnrollmentsArchive" ? "Archivado" : "Actual"}</p></td>
        <td className="whitespace-nowrap px-3 py-3">{entry.previousGrade} → {entry.newGrade}/100</td>
        <td className="px-3 py-3"><p>{entry.actorName}</p><p>{entry.actorEmail}</p><p className="text-xs text-slate-500">{entry.actorRole} · {entry.actorId}</p></td>
        <td className="px-3 py-3">{formatGradeDate(entry.correctedAt)}</td>
        <td className="max-w-sm px-3 py-3"><p className="whitespace-pre-wrap">{entry.reason}</p><p className="mt-1 break-all text-xs text-slate-500">{entry.id}</p></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
