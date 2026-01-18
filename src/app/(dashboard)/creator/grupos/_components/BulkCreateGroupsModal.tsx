"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import * as XLSX from "xlsx";
import { createGroup } from "@/lib/firebase/groups-service";

type CourseOption = { id: string; title: string };

type Props = {
  open: boolean;
  onClose: () => void;
  courses: CourseOption[];
  teacherId: string;
  teacherName: string;
  onImported: () => void;
};

type ParsedRow = {
  row: number;
  groupName: string;
  program: string;
  courseIds: string[];
};

type ImportResult = {
  row: number;
  groupName: string;
  status: "ok" | "error";
  message?: string;
};

const normalize = (value: unknown) =>
  typeof value === "string" ? value.trim() : `${value ?? ""}`.trim();

export function BulkCreateGroupsModal({ open, onClose, courses, teacherId, teacherName, onImported }: Props) {
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [importResults, setImportResults] = useState<ImportResult[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  if (!open) return null;

  const parseFile = async (file: File) => {
    setParsedRows([]);
    setImportResults([]);
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) {
        toast.error("El archivo no tiene hojas válidas");
        return;
      }
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const mapped: ParsedRow[] = rows
        .map((row, index) => {
          const groupName =
            normalize(row.Nombre || row.name || row["Nombre del grupo"] || row["Group Name"]);
          const program =
            normalize(row.Programa || row.program || row["Programa"] || "Licenciatura") || "Licenciatura";
          const courseStr = normalize(row.Cursos || row.courses || row["Cursos"]);
          const courseIds = courseStr
            .split(/[,;|]/)
            .map((value) => value.trim())
            .filter(Boolean);
          if (!groupName) return null;
          return {
            row: index + 2,
            groupName,
            program,
            courseIds,
          };
        })
        .filter(Boolean) as ParsedRow[];
      if (!mapped.length) {
        toast.error("No se encontraron filas válidas (Nombre del grupo obligatorio)");
        return;
      }
      setParsedRows(mapped);
      toast.success(`Archivo listo (${mapped.length} filas válidas)`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo leer el archivo. Usa formato .xlsx");
    }
  };

  const handleDownloadTemplate = () => {
    const rows = [
      ["Nombre del grupo", "Programa", "Cursos (IDs separados por coma)"],
      ["Grupo A", "Licenciatura", "courseId1,courseId2"],
      ["Grupo B", "Maestría", "courseId3"],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Plantilla");
    XLSX.writeFile(workbook, "plantilla-grupos.xlsx");
  };

  const handleImport = async () => {
    if (!parsedRows.length) {
      toast.error("Carga un archivo para importar");
      return;
    }
    setImporting(true);
    const results: ImportResult[] = [];
    for (const row of parsedRows) {
      try {
        const coursesPayload = row.courseIds
          .map((cid) => {
            const found = courses.find((c) => c.id === cid);
            return found ? { courseId: found.id, courseName: found.title } : null;
          })
          .filter(Boolean) as Array<{ courseId: string; courseName: string }>;
        await createGroup({
          groupName: row.groupName,
          program: row.program,
          courses: coursesPayload,
          courseIds: coursesPayload.map((c) => c.courseId),
          teacherId,
          teacherName,
          maxStudents: 0,
        });
        results.push({ row: row.row, groupName: row.groupName, status: "ok" });
      } catch (err) {
        console.error(err);
        results.push({
          row: row.row,
          groupName: row.groupName,
          status: "error",
          message: (err as { message?: string })?.message ?? "No se pudo crear el grupo",
        });
      }
    }
    setImportResults(results);
    setImporting(false);
    if (results.some((r) => r.status === "ok")) {
      toast.success("Importación completada");
      onImported();
    } else {
      toast.error("No se creó ningún grupo");
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    parseFile(file);
    event.target.value = "";
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-6">
      <div className="w-full max-w-2xl max-h-[calc(100vh-3rem)] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Crear grupos desde Excel</h2>
          <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">
            ✕
          </button>
        </div>
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-sm text-slate-700">Sube un archivo .xlsx con columnas Nombre del grupo, Programa y Cursos (IDs separados por coma)</p>
            <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
              <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} className="hidden" />
              {fileName ? "Cambiar archivo" : "Seleccionar archivo"}
            </label>
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="ml-2 mt-2 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 shadow-sm hover:border-blue-400 hover:bg-blue-100"
            >
              Descargar plantilla
            </button>
            {fileName ? (
              <p className="mt-1 text-xs text-slate-500">Archivo seleccionado: {fileName}</p>
            ) : null}
          </div>
          {parsedRows.length ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <p className="text-xs font-semibold text-slate-600">Filas preparadas</p>
              <div className="mt-2 space-y-1 text-[13px]">
                {parsedRows.slice(0, 5).map((row) => (
                  <div key={row.row} className="flex items-center justify-between">
                    <span>{row.groupName}</span>
                    <span className="text-xs text-slate-500">Fila {row.row}</span>
                  </div>
                ))}
                {parsedRows.length > 5 ? (
                  <p className="text-xs text-slate-500">{parsedRows.length - 5} más...</p>
                ) : null}
              </div>
            </div>
          ) : null}
          {importResults.length ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
              <p className="text-xs font-semibold text-slate-600">Resultados recientes</p>
              <div className="mt-2 space-y-1 text-[11px]">
                {importResults.map((res) => (
                  <div key={`${res.row}-${res.groupName}`} className="flex items-center justify-between">
                    <span>
                      {res.status === "ok" ? "✅" : "⚠️"} {res.groupName}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {res.status === "ok" ? "Creado" : res.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={importing || !parsedRows.length}
            onClick={handleImport}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {importing ? "Importando..." : "Crear grupos"}
          </button>
        </div>
      </div>
    </div>
  );
}
