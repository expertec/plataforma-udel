"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getCourses, type Course } from "@/lib/firebase/courses-service";
import { cancelStudentEquivalency, createStudentEquivalencies, getStudentEquivalencies, updateStudentEquivalency } from "@/lib/firebase/equivalencies-service";
import { equivalencyFinalGrade, equivalencyNameKey, validateEquivalencyInput, type EquivalencyInput, type StudentEquivalency } from "@/lib/students/equivalencies";

type Props = { studentId: string; studentName: string; onClose: () => void };
type Draft = Omit<EquivalencyInput, "grade"> & { grade: string };
const inputClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:bg-slate-100";
const buttonClass = "rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";

function emptyDraft(): Draft {
  const now = new Date();
  const recognizedAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return { courseId: null, courseName: "", grade: "", gradeScale: 100, institution: "", period: "", recognizedAt, notes: "" };
}

export function StudentEquivalenciesModal({ studentId, studentName, onClose }: Props) {
  const [records, setRecords] = useState<StudentEquivalency[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [mode, setMode] = useState<"catalog" | "manual">("catalog");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [queue, setQueue] = useState<EquivalencyInput[]>([]);
  const [editing, setEditing] = useState<StudentEquivalency | null>(null);
  const [cancelling, setCancelling] = useState<StudentEquivalency | null>(null);
  const [reason, setReason] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setLoadError("");
      setCatalogError("");
      const [equivalencies, catalog] = await Promise.allSettled([getStudentEquivalencies(studentId, true), getCourses()]);
      if (!active) return;
      if (equivalencies.status === "fulfilled") setRecords(equivalencies.value);
      else setLoadError(equivalencies.reason instanceof Error ? equivalencies.reason.message : "No se pudieron cargar las equivalencias.");
      if (catalog.status === "fulfilled") setCourses(catalog.value.filter((course) => !course.isArchived && !course.isInduction));
      else setCatalogError("No se pudo cargar el catálogo. Puedes reintentar o capturar el nombre manualmente.");
      setLoading(false);
    }
    void load();
    return () => { active = false; };
  }, [studentId, reload]);

  const matchingCourses = useMemo(() => {
    const query = equivalencyNameKey(search);
    return courses.filter((course) => equivalencyNameKey(`${course.title} ${course.program || course.category || ""}`).includes(query));
  }, [courses, search]);

  const setField = <Key extends keyof Draft>(key: Key, value: Draft[Key]) => setDraft((current) => ({ ...current, [key]: value }));
  const resetForm = () => {
    setDraft((current) => ({ ...emptyDraft(), institution: current.institution, period: current.period, recognizedAt: current.recognizedAt, gradeScale: current.gradeScale }));
    setEditing(null);
    setReason("");
    setSearch("");
  };
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : "No se pudo guardar la equivalencia.";

  async function submitEntry(event: FormEvent) {
    event.preventDefault();
    try {
      if (mode === "catalog" && !draft.courseId) throw new Error("Selecciona una materia del catálogo.");
      if (!draft.grade.trim()) throw new Error("Captura una calificación.");
      const entry = validateEquivalencyInput({ ...draft, grade: Number(draft.grade) });
      const duplicates = [...records.filter((record) => record.status === "active" && record.id !== editing?.id), ...queue];
      if (duplicates.some((record) => (entry.courseId && entry.courseId === record.courseId) || equivalencyNameKey(entry.courseName) === equivalencyNameKey(record.courseName))) throw new Error("Esta materia ya tiene una equivalencia vigente o está en la lista por guardar.");
      if (editing) {
        if (!reason.trim()) throw new Error("Indica el motivo de la corrección.");
        setSaving(true);
        setRecords(await updateStudentEquivalency(studentId, editing.id, editing.version, entry, reason.trim()));
        toast.success("Equivalencia corregida.");
      } else {
        if (queue.length >= 40) throw new Error("Guarda la lista antes de agregar más materias (máximo 40).");
        setQueue((current) => [...current, entry]);
      }
      resetForm();
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); }
  }

  async function saveQueue() {
    setSaving(true);
    try {
      setRecords(await createStudentEquivalencies(studentId, queue));
      setQueue([]);
      toast.success("Equivalencias registradas en el kardex.");
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); }
  }

  async function cancelRecord() {
    if (!cancelling || !reason.trim()) return;
    setSaving(true);
    try {
      setRecords(await cancelStudentEquivalency(studentId, cancelling.id, cancelling.version, reason.trim()));
      setCancelling(null);
      setReason("");
      toast.success("Equivalencia anulada. El historial se conserva.");
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); }
  }

  function editRecord(record: StudentEquivalency) {
    setEditing(record);
    setCancelling(null);
    setReason("");
    setMode(record.courseId ? "catalog" : "manual");
    setDraft({ courseId: record.courseId, courseName: record.courseName, grade: String(record.grade), gradeScale: record.gradeScale, institution: record.institution, period: record.period, recognizedAt: record.recognizedAt, notes: record.notes });
  }

  const close = () => {
    if (saving) return;
    if ((queue.length > 0 || editing || draft.courseName || draft.grade) && !window.confirm("Hay cambios sin guardar. ¿Deseas cerrar y descartarlos?")) return;
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-w-5xl">
        <div className="flex items-start justify-between gap-4">
          <DialogHeader>
            <DialogTitle>Equivalencias</DialogTitle>
            <p className="text-sm text-slate-600">{studentName}</p>
            <p className="mt-2 text-sm text-slate-600">Las materias reconocidas aparecen en el kardex y su PDF. Las calificaciones se guardan en escala de 100 y participan en el promedio.</p>
          </DialogHeader>
          <button type="button" onClick={close} disabled={saving} className={buttonClass}>Cerrar</button>
        </div>
        {loading ? <p className="py-6 text-sm text-slate-600">Cargando equivalencias y catálogo…</p> : loadError ? (
          <div role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{loadError} <button type="button" className="underline" onClick={() => setReload((current) => current + 1)}>Reintentar</button></div>
        ) : (
          <div className="space-y-6">
            <form onSubmit={submitEntry} className="rounded-xl border border-slate-200 p-4">
              <fieldset disabled={saving || Boolean(cancelling)} className="space-y-4">
                <legend className="mb-3 font-semibold text-slate-900">{editing ? "Corregir equivalencia" : "Agregar materia"}</legend>
                <div className="flex gap-4 text-sm text-slate-700">
                  <label><input type="radio" name="equivalency-mode" checked={mode === "catalog"} onChange={() => { setMode("catalog"); setDraft((current) => ({ ...current, courseId: null, courseName: "" })); }} /> Buscar en catálogo</label>
                  <label><input type="radio" name="equivalency-mode" checked={mode === "manual"} onChange={() => { setMode("manual"); setField("courseId", null); }} /> Escribir nombre</label>
                </div>
                {mode === "catalog" ? (
                  <div className="space-y-2">
                    {catalogError && <p role="alert" className="text-sm text-amber-700">{catalogError} <button type="button" className="underline" onClick={() => setReload((current) => current + 1)}>Reintentar</button></p>}
                    <label className="block text-sm text-slate-700">Buscar materia o programa<input value={search} onChange={(event) => setSearch(event.target.value)} className={inputClass} placeholder="Escribe para buscar…" /></label>
                    {draft.courseId && <p className="text-sm font-semibold text-blue-700">Seleccionada: {draft.courseName}</p>}
                    <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200">
                      {matchingCourses.slice(0, 30).map((course) => <button key={course.id} type="button" onClick={() => setDraft((current) => ({ ...current, courseId: course.id, courseName: course.title }))} className={`block w-full px-3 py-2 text-left text-sm hover:bg-blue-50 ${draft.courseId === course.id ? "bg-blue-50 text-blue-800" : "text-slate-800"}`}>{course.title}{course.program || course.category ? <span className="ml-2 text-xs text-slate-500">{course.program || course.category}</span> : null}</button>)}
                      {matchingCourses.length === 0 && <p className="p-3 text-sm text-slate-500">No se encontraron materias.</p>}
                    </div>
                    {matchingCourses.length > 30 && <p className="text-xs text-slate-500">Se muestran 30 resultados. Escribe más para afinar la búsqueda.</p>}
                  </div>
                ) : <label className="block text-sm text-slate-700">Nombre de la materia<input required maxLength={200} value={draft.courseName} onChange={(event) => setField("courseName", event.target.value)} className={inputClass} /><span className="text-xs text-slate-500">Aparecerá en el historial. Para acreditar una materia específica del programa, selecciónala del catálogo.</span></label>}
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm text-slate-700">Escala<select value={draft.gradeScale} onChange={(event) => setDraft((current) => ({ ...current, gradeScale: Number(event.target.value) as 10 | 100, grade: "" }))} className={inputClass}><option value={100}>0 a 100</option><option value={10}>0 a 10</option></select></label>
                  <label className="text-sm text-slate-700">Calificación<input required type="number" min={draft.gradeScale * 0.7} max={draft.gradeScale} step="0.1" value={draft.grade} onChange={(event) => setField("grade", event.target.value)} className={inputClass} /></label>
                  <label className="text-sm text-slate-700">Fecha de reconocimiento<input required type="date" value={draft.recognizedAt} onChange={(event) => setField("recognizedAt", event.target.value)} className={inputClass} /></label>
                </div>
                <p className="text-xs text-slate-500">Solo se reconocen calificaciones aprobatorias: mínimo {draft.gradeScale * 0.7}. Una nota de 9 en escala de 10 se registra como 90.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-slate-700">Institución de procedencia<input maxLength={200} value={draft.institution} onChange={(event) => setField("institution", event.target.value)} className={inputClass} /></label>
                  <label className="text-sm text-slate-700">Periodo o semestre<input maxLength={100} value={draft.period} onChange={(event) => setField("period", event.target.value)} className={inputClass} /></label>
                </div>
                <label className="block text-sm text-slate-700">Observaciones<textarea maxLength={2000} rows={2} value={draft.notes} onChange={(event) => setField("notes", event.target.value)} className={inputClass} /></label>
                {editing && <label className="block text-sm text-slate-700">Motivo de la corrección<input required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} className={inputClass} /></label>}
                <div className="flex gap-2">
                  <button type="submit" className="rounded-lg bg-[#7c152d] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Guardando…" : editing ? "Guardar corrección" : "Agregar a la lista"}</button>
                  {editing && <button type="button" onClick={resetForm} className={buttonClass}>Cancelar corrección</button>}
                </div>
              </fieldset>
            </form>

            {queue.length > 0 && <section className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
              <h3 className="font-semibold text-slate-900">Materias por guardar ({queue.length})</h3>
              {queue.map((entry, index) => <div key={`${entry.courseId || entry.courseName}-${index}`} className="flex items-center justify-between gap-3 text-sm text-slate-800"><span>{entry.courseName} · {equivalencyFinalGrade(entry).toFixed(1)} / 100</span><button type="button" disabled={saving} onClick={() => setQueue((current) => current.filter((_, entryIndex) => entryIndex !== index))} className="text-red-700">Quitar</button></div>)}
              <button type="button" onClick={() => void saveQueue()} disabled={saving || Boolean(editing) || Boolean(cancelling)} className="rounded-lg bg-[#7c152d] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Guardando…" : "Guardar equivalencias en el kardex"}</button>
            </section>}

            {cancelling && <section className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <h3 className="font-semibold text-red-800">Anular: {cancelling.courseName}</h3>
              <p className="text-sm text-slate-700">Dejará de aparecer en el kardex y en el promedio. Su registro e historial se conservan.</p>
              <label className="block text-sm text-slate-700">Motivo de la anulación<input maxLength={1000} value={reason} disabled={saving} onChange={(event) => setReason(event.target.value)} className={inputClass} /></label>
              <div className="flex gap-2"><button type="button" disabled={saving || !reason.trim()} onClick={() => void cancelRecord()} className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Confirmar anulación</button><button type="button" disabled={saving} onClick={() => { setCancelling(null); setReason(""); }} className={buttonClass}>Cancelar</button></div>
            </section>}

            <section className="space-y-3">
              <h3 className="font-semibold text-slate-900">Equivalencias registradas</h3>
              {records.length === 0 && <p className="text-sm text-slate-500">Este alumno todavía no tiene equivalencias.</p>}
              {records.map((record) => <article key={record.id} className="space-y-2 rounded-xl border border-slate-200 p-4 text-sm text-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold text-slate-900">{record.courseName} · {record.finalGrade.toFixed(1)} / 100</h4><span className={record.status === "active" ? "text-emerald-700" : "text-red-700"}>{record.status === "active" ? "Vigente" : "Anulada"}</span></div>
                <p>{record.institution || "Sin institución registrada"} · {record.period || "Sin periodo"} · Reconocimiento: {record.recognizedAt}</p>
                <p className="text-xs text-slate-500">{record.courseId ? "Vinculada al catálogo" : "Materia de captura manual"} · Nota de origen: {record.grade} / {record.gradeScale} · Versión {record.version} · Actualización: {new Date(record.updatedAt).toLocaleString("es-MX")}</p>
                {record.notes && <p className="whitespace-pre-wrap">{record.notes}</p>}
                <p className="text-xs text-slate-500">Último motivo: {record.changeReason}</p>
                {record.status === "active" && <div className="flex gap-2"><button type="button" disabled={saving || Boolean(editing) || Boolean(cancelling)} onClick={() => editRecord(record)} className={buttonClass}>Corregir</button><button type="button" disabled={saving || Boolean(editing) || Boolean(cancelling)} onClick={() => { setCancelling(record); setReason(""); }} className="rounded-lg px-3 py-2 text-sm font-semibold text-red-700 disabled:opacity-50">Anular</button></div>}
              </article>)}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
