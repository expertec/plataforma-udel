"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import toast from "react-hot-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getCourses, type Course } from "@/lib/firebase/courses-service";
import { cancelStudentAcademicHistory, createStudentAcademicHistory, getStudentAcademicHistory, updateStudentAcademicHistory } from "@/lib/firebase/academic-history-service";
import { equivalencyNameKey } from "@/lib/students/equivalencies";
import { getAllGroups, getGroupsByPlantel, type Group } from "@/lib/firebase/groups-service";
import { accreditationLabels, academicHistoryFinalGrade, formatManualRegistrationDate, sameAcademicAttempt, validateAcademicHistoryInput, type AcademicHistoryInput, type StudentAcademicHistory } from "@/lib/students/academic-history";

type Props = { studentId: string; studentName: string; canManageRecords: boolean; scopePlantelId?: string; onClose: () => void };
type Draft = Omit<AcademicHistoryInput, "grade"> & { grade: string };
const inputClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:bg-slate-100";
const buttonClass = "rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";

function emptyDraft(): Draft {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Monterrey", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
  const registeredAt = `${part("year")}-${part("month")}-${part("day")}`;
  return { courseId: null, courseName: "", groupId: null, groupName: "", cycle: "", semester: "", section: "academic", accreditationType: "ordinary", grade: "", gradeScale: 100, registeredAt, notes: "" };
}

export function StudentAcademicHistoryModal({ studentId, studentName, canManageRecords, scopePlantelId, onClose }: Props) {
  const [records, setRecords] = useState<StudentAcademicHistory[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupError, setGroupError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [mode, setMode] = useState<"catalog" | "manual">("catalog");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [queue, setQueue] = useState<AcademicHistoryInput[]>([]);
  const [editing, setEditing] = useState<StudentAcademicHistory | null>(null);
  const [cancelling, setCancelling] = useState<StudentAcademicHistory | null>(null);
  const [reason, setReason] = useState("");
  const [reload, setReload] = useState(0);
  const [excelAction, setExcelAction] = useState<"download" | "import" | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const excelInput = useRef<HTMLInputElement>(null);
  const busy = saving || excelAction !== null;

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setLoadError("");
      setCatalogError("");
      const [history, catalog, groupList] = await Promise.allSettled([
        getStudentAcademicHistory(studentId, canManageRecords), getCourses(),
        canManageRecords ? getAllGroups() : getGroupsByPlantel(scopePlantelId ?? ""),
      ]);
      if (!active) return;
      if (history.status === "fulfilled") setRecords(history.value);
      else setLoadError(history.reason instanceof Error ? history.reason.message : "No se pudieron cargar los registros académicos.");
      if (catalog.status === "fulfilled") setCourses(catalog.value.filter((course) => !course.isInduction));
      else setCatalogError("No se pudo cargar el catálogo. Puedes reintentar o capturar el nombre manualmente.");
      if (groupList.status === "fulfilled") { setGroups(groupList.value); setGroupError(""); }
      else setGroupError("No se pudieron cargar los grupos. Puedes escribir el grupo histórico o reintentar.");
      setLoading(false);
    }
    void load();
    return () => { active = false; };
  }, [studentId, reload, canManageRecords, scopePlantelId]);

  const matchingCourses = useMemo(() => {
    const query = equivalencyNameKey(search);
    return courses.filter((course) => equivalencyNameKey(`${course.title} ${course.program || course.category || ""}`).includes(query));
  }, [courses, search]);

  const setField = <Key extends keyof Draft>(key: Key, value: Draft[Key]) => setDraft((current) => ({ ...current, [key]: value }));
  const resetForm = () => {
    setDraft((current) => ({ ...emptyDraft(), groupId: current.groupId, groupName: current.groupName, cycle: current.cycle, semester: current.semester, section: current.section, accreditationType: current.accreditationType, registeredAt: current.registeredAt, gradeScale: current.gradeScale }));
    setEditing(null);
    setDirty(false);
    setReason("");
    setSearch("");
  };
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : "No se pudo guardar el registro académico.";

  async function downloadTemplate() {
    if (busy) return;
    setExcelAction("download");
    try {
      const { downloadAcademicHistoryTemplate } = await import("@/lib/students/academic-history-excel");
      downloadAcademicHistoryTemplate({ courses, groups });
    } catch (error) { toast.error(error instanceof Error ? error.message : "No se pudo descargar la plantilla."); }
    finally { setExcelAction(null); }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy || editing || cancelling) return;
    setImportErrors([]);
    setExcelAction("import");
    try {
      const { ACADEMIC_HISTORY_EXCEL_MAX_BYTES, readAcademicHistoryExcel } = await import("@/lib/students/academic-history-excel");
      if (!/\.xlsx?$/i.test(file.name)) throw new Error("Selecciona un archivo de Excel .xlsx o .xls.");
      if (file.size > ACADEMIC_HISTORY_EXCEL_MAX_BYTES) throw new Error("El archivo debe pesar como máximo 5 MB.");
      const result = readAcademicHistoryExcel(await file.arrayBuffer(), { courses, groups }, [
        ...records.filter((record) => record.status === "active"), ...queue,
      ]);
      if (result.errors.length) { setImportErrors(result.errors); return; }
      if (queue.length + result.entries.length > 40) throw new Error(`Solo quedan ${40 - queue.length} lugares en la lista. Guarda las materias pendientes o divide el archivo.`);
      setQueue((current) => [...current, ...result.entries]);
      toast.success(`${result.entries.length} materias agregadas a la lista. Revísalas antes de guardar.`);
    } catch (error) {
      setImportErrors([error instanceof Error ? error.message : "No se pudo leer el archivo. Usa la plantilla de Excel."]);
    } finally { setExcelAction(null); }
  }

  async function submitEntry(event: FormEvent) {
    event.preventDefault();
    try {
      if (mode === "catalog" && !draft.courseId) throw new Error("Selecciona una materia del catálogo.");
      if (!draft.grade.trim()) throw new Error("Captura una calificación.");
      const entry = validateAcademicHistoryInput({ ...draft, grade: Number(draft.grade) });
      const duplicates = [...records.filter((record) => record.status === "active" && record.id !== editing?.id), ...queue];
      if (duplicates.some((record) => sameAcademicAttempt(entry, record))) throw new Error("Esta materia ya tiene un registro para ese grupo y ciclo o está en la lista por guardar.");
      if (editing) {
        if (!reason.trim()) throw new Error("Indica el motivo de la corrección.");
        setSaving(true);
        setRecords(await updateStudentAcademicHistory(studentId, editing.id, editing.version, entry, reason.trim()));
        toast.success("Registro académico corregido.");
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
      setRecords(await createStudentAcademicHistory(studentId, queue));
      setQueue([]);
      toast.success("Historial académico registrado en el kárdex.");
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); }
  }

  async function cancelRecord() {
    if (!cancelling || !reason.trim()) return;
    setSaving(true);
    try {
      setRecords(await cancelStudentAcademicHistory(studentId, cancelling.id, cancelling.version, reason.trim()));
      setCancelling(null);
      setReason("");
      toast.success("Registro académico anulado. El historial se conserva.");
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); }
  }

  function editRecord(record: StudentAcademicHistory) {
    setEditing(record);
    setCancelling(null);
    setReason("");
    setMode(record.courseId ? "catalog" : "manual");
    setDraft({ ...record, grade: String(record.grade) });
    setDirty(false);
  }

  const close = () => {
    if (busy) return;
    if ((queue.length > 0 || editing || dirty || (cancelling && reason)) && !window.confirm("Hay cambios sin guardar. ¿Deseas cerrar y descartarlos?")) return;
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-w-5xl">
        <div className="flex items-start justify-between gap-4">
          <DialogHeader>
            <DialogTitle>Historial académico</DialogTitle>
            <p className="text-sm text-slate-600">{studentName}</p>
            <p className="mt-2 text-sm text-slate-600">Captura materias cursadas en UDEL que faltan en la plataforma. Aparecerán en el kárdex y su PDF con fecha manual (M). Las calificaciones se guardan en escala de 100 y participan en el promedio.</p>
          </DialogHeader>
          <button type="button" onClick={close} disabled={busy} className={buttonClass}>Cerrar</button>
        </div>
        {loading ? <p className="py-6 text-sm text-slate-600">Cargando registros académicos y catálogo…</p> : loadError ? (
          <div role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{loadError} <button type="button" className="underline" onClick={() => setReload((current) => current + 1)}>Reintentar</button></div>
        ) : (
          <div className="space-y-6">
            <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="font-semibold text-slate-900">Cargar materias desde Excel</h3>
              <p className="text-sm text-slate-600">Descarga la plantilla, completa la hoja Materias e impórtala para este alumno. Puedes revisar hasta 40 materias en la lista antes de guardarlas.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void downloadTemplate()} disabled={busy} className={buttonClass}>{excelAction === "download" ? "Preparando plantilla…" : "Descargar plantilla Excel"}</button>
                <button type="button" onClick={() => excelInput.current?.click()} disabled={busy || Boolean(editing) || Boolean(cancelling) || Boolean(catalogError) || Boolean(groupError) || queue.length >= 40} className={buttonClass}>{excelAction === "import" ? "Leyendo Excel…" : "Importar Excel"}</button>
                <input ref={excelInput} type="file" accept=".xlsx,.xls" aria-label="Archivo Excel de historial académico" className="hidden" onChange={(event) => void importFile(event)} />
              </div>
              <p className="text-xs text-slate-500">Formatos .xlsx y .xls · Máximo 5 MB. Los nombres que coincidan con el catálogo se vinculan automáticamente; los demás se conservan como materias históricas.</p>
              {(catalogError || groupError) && <p className="text-sm text-amber-700">Para importar, reintenta la carga del catálogo y de los grupos desde los avisos del formulario.</p>}
              {importErrors.length > 0 && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <p className="font-semibold">No se agregó ninguna materia del archivo. Corrige estos datos y vuelve a importarlo:</p>
                <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto pl-5">{importErrors.map((error, index) => <li key={index}>{error}</li>)}</ul>
              </div>}
            </section>
            <form onSubmit={submitEntry} onChange={() => setDirty(true)} className="rounded-xl border border-slate-200 p-4">
              <fieldset disabled={busy || Boolean(cancelling)} className="space-y-4">
                <legend className="mb-3 font-semibold text-slate-900">{editing ? "Corregir registro académico" : "Agregar materia"}</legend>
                <div className="flex gap-4 text-sm text-slate-700">
                  <label><input type="radio" name="academic-history-mode" checked={mode === "catalog"} onChange={() => { setMode("catalog"); setDraft((current) => ({ ...current, courseId: null, courseName: "" })); }} /> Buscar en catálogo</label>
                  <label><input type="radio" name="academic-history-mode" checked={mode === "manual"} onChange={() => { setMode("manual"); setField("courseId", null); }} /> Escribir nombre</label>
                </div>
                {mode === "catalog" ? (
                  <div className="space-y-2">
                    {catalogError && <p role="alert" className="text-sm text-amber-700">{catalogError} <button type="button" className="underline" onClick={() => setReload((current) => current + 1)}>Reintentar</button></p>}
                    <label className="block text-sm text-slate-700">Buscar materia o programa<input value={search} onChange={(event) => setSearch(event.target.value)} className={inputClass} placeholder="Escribe para buscar…" /></label>
                    {draft.courseId && <p className="text-sm font-semibold text-blue-700">Seleccionada: {draft.courseName}</p>}
                    <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200">
                      {matchingCourses.slice(0, 30).map((course) => <button key={course.id} type="button" onClick={() => { setDirty(true); setDraft((current) => ({ ...current, courseId: course.id, courseName: course.title })); }} className={`block w-full px-3 py-2 text-left text-sm hover:bg-blue-50 ${draft.courseId === course.id ? "bg-blue-50 text-blue-800" : "text-slate-800"}`}>{course.title}{course.isArchived && <span className="ml-2 text-xs text-slate-500">Archivada</span>}{course.program || course.category ? <span className="ml-2 text-xs text-slate-500">{course.program || course.category}</span> : null}</button>)}
                      {matchingCourses.length === 0 && <p className="p-3 text-sm text-slate-500">No se encontraron materias.</p>}
                    </div>
                    {matchingCourses.length > 30 && <p className="text-xs text-slate-500">Se muestran 30 resultados. Escribe más para afinar la búsqueda.</p>}
                  </div>
                ) : <label className="block text-sm text-slate-700">Nombre de la materia<input required maxLength={200} value={draft.courseName} onChange={(event) => setField("courseName", event.target.value)} className={inputClass} /><span className="text-xs text-slate-500">Aparecerá en el historial. Para acreditar una materia específica del programa, selecciónala del catálogo.</span></label>}
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm text-slate-700">Escala<select value={draft.gradeScale} onChange={(event) => setDraft((current) => ({ ...current, gradeScale: Number(event.target.value) as 10 | 100, grade: "" }))} className={inputClass}><option value={100}>0 a 100</option><option value={10}>0 a 10</option></select></label>
                  <label className="text-sm text-slate-700">Calificación<input required type="number" min={0} max={draft.gradeScale} step="0.1" value={draft.grade} onChange={(event) => setField("grade", event.target.value)} className={inputClass} /></label>
                  <label className="text-sm text-slate-700">Fecha de registro<input required type="date" value={draft.registeredAt} onChange={(event) => setField("registeredAt", event.target.value)} className={inputClass} /></label>
                </div>
                <p className="text-xs text-slate-500">Se permiten calificaciones de 0 a {draft.gradeScale}, incluidas reprobatorias. Una nota de 9 en escala de 10 se registra como 90. Fecha en kárdex: <strong>{formatManualRegistrationDate(draft.registeredAt)}</strong>.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-slate-700">Grupo existente (opcional)
                    <select value={draft.groupId || ""} onChange={(event) => {
                      const group = groups.find((item) => item.id === event.target.value);
                      setDraft((current) => ({ ...current, groupId: group?.id || null, groupName: group?.groupName || "", semester: group?.semester || current.semester }));
                    }} className={inputClass}>
                      <option value="">Escribir grupo histórico</option>
                      {draft.groupId && !groups.some((group) => group.id === draft.groupId) && <option value={draft.groupId}>{draft.groupName} (no disponible)</option>}
                      {groups.map((group) => <option key={group.id} value={group.id}>{group.groupName}</option>)}
                    </select>
                  </label>
                  <label className="text-sm text-slate-700">Nombre del grupo<input required maxLength={200} readOnly={Boolean(draft.groupId)} value={draft.groupName} onChange={(event) => setField("groupName", event.target.value)} className={inputClass} placeholder="Ej. LPI2023" /></label>
                  {groupError && <p role="alert" className="text-sm text-amber-700 sm:col-span-2">{groupError} <button type="button" onClick={() => setReload((current) => current + 1)} className="underline">Reintentar</button></p>}
                  <label className="text-sm text-slate-700">Ciclo escolar<input required maxLength={100} value={draft.cycle} onChange={(event) => setField("cycle", event.target.value)} className={inputClass} placeholder="Ej. 2024-2" /></label>
                  <label className="text-sm text-slate-700">Cuatrimestre<input required type="number" min={1} max={99} step={1} value={draft.semester} onChange={(event) => setField("semester", event.target.value)} className={inputClass} /></label>
                  <label className="text-sm text-slate-700">Tipo de acreditación<select value={draft.accreditationType} onChange={(event) => setField("accreditationType", event.target.value as AcademicHistoryInput["accreditationType"])} className={inputClass}>
                    <option value="ordinary">Ordinario</option><option value="extraordinary">Extraordinario</option><option value="global">Global</option>
                  </select></label>
                  <label className="text-sm text-slate-700">Apartado del kárdex<select value={draft.section} onChange={(event) => setField("section", event.target.value as AcademicHistoryInput["section"])} className={inputClass}>
                    <option value="academic">Licenciatura</option><option value="certifications">Certificaciones</option>
                  </select></label>
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
              {queue.map((entry, index) => <div key={`${entry.courseId || entry.courseName}-${index}`} className="flex items-center justify-between gap-3 text-sm text-slate-800"><span>{entry.courseName} ({entry.courseId ? "Vinculada al catálogo" : "Nombre histórico, sin vínculo al catálogo"}) · {academicHistoryFinalGrade(entry).toFixed(1)} / 100 · {entry.groupName} · {entry.cycle} · C. {entry.semester} · {entry.section === "academic" ? "Licenciatura" : "Certificaciones"} · {accreditationLabels[entry.accreditationType]} · {formatManualRegistrationDate(entry.registeredAt)}</span><button type="button" disabled={busy} onClick={() => setQueue((current) => current.filter((_, entryIndex) => entryIndex !== index))} className="text-red-700">Quitar</button></div>)}
              <button type="button" onClick={() => void saveQueue()} disabled={busy || Boolean(editing) || Boolean(cancelling)} className="rounded-lg bg-[#7c152d] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Guardando…" : "Guardar registros académicos en el kardex"}</button>
            </section>}

            {cancelling && <section className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <h3 className="font-semibold text-red-800">Anular: {cancelling.courseName}</h3>
              <p className="text-sm text-slate-700">Dejará de aparecer en el kardex y en el promedio. Su registro e historial se conservan.</p>
              <label className="block text-sm text-slate-700">Motivo de la anulación<input maxLength={1000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} className={inputClass} /></label>
              <div className="flex gap-2"><button type="button" disabled={busy || !reason.trim()} onClick={() => void cancelRecord()} className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Confirmar anulación</button><button type="button" disabled={busy} onClick={() => { setCancelling(null); setReason(""); }} className={buttonClass}>Cancelar</button></div>
            </section>}

            <section className="space-y-3">
              <h3 className="font-semibold text-slate-900">Materias registradas manualmente</h3>
              {records.length === 0 && <p className="text-sm text-slate-500">Este alumno todavía no tiene materias de captura manual.</p>}
              {records.map((record) => <article key={record.id} className="space-y-2 rounded-xl border border-slate-200 p-4 text-sm text-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold text-slate-900">{record.courseName} · {record.finalGrade.toFixed(1)} / 100</h4><span className={record.status === "active" ? "text-emerald-700" : "text-red-700"}>{record.status === "active" ? "Vigente" : "Anulada"}</span></div>
                <p>{record.groupName} · Ciclo: {record.cycle} · Cuatrimestre: {record.semester} · {record.section === "academic" ? "Licenciatura" : "Certificaciones"} · {accreditationLabels[record.accreditationType]} · {formatManualRegistrationDate(record.registeredAt)}</p>
                <p className="text-xs text-slate-500">{record.courseId ? "Vinculada al catálogo" : "Materia de captura manual"} · Nota de origen: {record.grade} / {record.gradeScale} · Versión {record.version} · Actualización: {new Date(record.updatedAt).toLocaleString("es-MX", { timeZone: "America/Monterrey" })}</p>
                {record.notes && <p className="whitespace-pre-wrap">{record.notes}</p>}
                <p className="text-xs text-slate-500">Último motivo: {record.changeReason}</p>
                {canManageRecords && record.status === "active" && <div className="flex gap-2"><button type="button" disabled={busy || Boolean(editing) || Boolean(cancelling)} onClick={() => editRecord(record)} className={buttonClass}>Corregir</button><button type="button" disabled={busy || Boolean(editing) || Boolean(cancelling)} onClick={() => { setCancelling(record); setReason(""); }} className="rounded-lg px-3 py-2 text-sm font-semibold text-red-700 disabled:opacity-50">Anular</button></div>}
              </article>)}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
