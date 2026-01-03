"use client";

import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import toast from "react-hot-toast";
import { createCourse, createLesson, createClass } from "@/lib/firebase/courses-service";
import { auth } from "@/lib/firebase/client";

type BulkUploadCoursesModalProps = {
  open: boolean;
  onClose: () => void;
  teacherId?: string | null;
  teacherName?: string | null;
  onImported?: () => Promise<void> | void;
};

type ParsedRow = {
  row: number;
  courseTitle: string;
  courseDescription: string;
  introVideoUrl: string;
  category: string;
  lessonTitle: string;
  classTitle: string;
  classType: "video" | "text" | "audio" | "quiz" | "image";
  content: string;
  duration: number | null;
  order: number | null;
  imageUrls: string[];
  hasAssignment: boolean;
  assignmentTemplateUrl: string;
};

type ImportResult = {
  row: number;
  title: string;
  lesson: string;
  classTitle: string;
  status: "ok" | "error";
  message?: string;
};

const fieldKeys = {
  courseTitle: ["Curso", "Course", "TítuloCurso", "TituloCurso", "CourseTitle"],
  courseDescription: ["DescripciónCurso", "DescripcionCurso", "CourseDescription", "Descripción"],
  introVideoUrl: ["IntroVideoUrl", "VideoIntro", "Intro Video", "Intro"],
  category: ["Categoría", "Categoria", "Category"],
  lessonTitle: ["Lección", "Leccion", "Lesson", "LessonTitle"],
  classTitle: ["TítuloClase", "TituloClase", "ClassTitle", "Clase"],
  classType: ["Tipo", "ClassType"],
  content: ["Contenido", "Content", "URL", "Link"],
  duration: ["Duración", "Duracion", "Duration"],
  order: ["Orden", "Order"],
  imageUrls: ["ImageUrls", "Imagenes", "Imágenes"],
  hasAssignment: ["HasAssignment", "Asignacion", "Asignación", "TieneTarea"],
  assignmentTemplateUrl: ["AssignmentTemplateUrl", "Template", "Plantilla"],
};

const sampleData = [
  [
    "Curso",
    "DescripciónCurso",
    "IntroVideoUrl",
    "Categoría",
    "Lección",
    "Tipo",
    "TítuloClase",
    "Contenido",
    "Duración",
    "Orden",
    "ImageUrls",
    "HasAssignment",
    "AssignmentTemplateUrl",
  ],
  [
    "Matemáticas 1",
    "Curso base de matemáticas",
    "https://vimeo.com/intro",
    "STEM",
    "Bienvenida",
    "video",
    "Video de bienvenida",
    "https://vimeo.com/123",
    5,
    1,
    "",
    "no",
    "",
  ],
  [
    "Matemáticas 1",
    "",
    "",
    "",
    "Álgebra básica",
    "text",
    "Introducción al álgebra",
    "Conceptos clave de variables y ecuaciones.",
    "",
    2,
    "",
    "",
  ],
  [
    "Historia Moderna",
    "Repaso de eventos clave del siglo XX",
    "",
    "Humanidades",
    "Introducción",
    "image",
    "Mapa histórico",
    "https://images.com/mapa1.jpg;https://images.com/mapa2.jpg",
    "",
    1,
    "",
    "no",
    "",
  ],
];

export function BulkUploadCoursesModal({
  open,
  onClose,
  teacherId,
  teacherName,
  onImported,
}: BulkUploadCoursesModalProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const preview = useMemo(() => parsedRows.slice(0, 5), [parsedRows]);

  const reset = () => {
    setFileName(null);
    setParseError(null);
    setParsedRows([]);
    setResults([]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const getField = (row: Record<string, any>, keys: string[]) => {
    for (const key of keys) {
      if (row[key] === undefined || row[key] === null) continue;
      const value = String(row[key]).trim();
      if (value) return value;
    }
    return "";
  };

  const parseFile = async (file: File) => {
    setParseError(null);
    setParsedRows([]);
    setResults([]);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) {
        setParseError("El archivo no tiene hojas válidas.");
        return;
      }
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
      const normalizeType = (val: string): ParsedRow["classType"] => {
        const t = val.toLowerCase();
        if (["video", "texto", "text"].includes(t)) return t === "video" ? "video" : "text";
        if (["audio"].includes(t)) return "audio";
        if (["quiz", "cuestionario"].includes(t)) return "quiz";
        if (["image", "imagen", "imagenes", "imágenes"].includes(t)) return "image";
        return "text";
      };
      const parseNumber = (val: string): number | null => {
        const n = Number(val);
        return Number.isFinite(n) ? n : null;
      };
      const parseBool = (val: string): boolean => {
        const v = val.toLowerCase();
        return ["si", "sí", "yes", "true", "1"].includes(v);
      };
      const parseList = (val: string): string[] =>
        val
          .split(/[|;,\n]/)
          .map((x) => x.trim())
          .filter(Boolean);

      const mapped: ParsedRow[] = rows
        .map((row, idx) => {
          const courseTitle = getField(row, fieldKeys.courseTitle);
          const lessonTitle = getField(row, fieldKeys.lessonTitle);
          const classTitle = getField(row, fieldKeys.classTitle);
          if (!courseTitle.trim() || !lessonTitle.trim() || !classTitle.trim()) return null;
          const courseDescription = getField(row, fieldKeys.courseDescription);
          const introVideoUrl = getField(row, fieldKeys.introVideoUrl);
          const category = getField(row, fieldKeys.category);
          const classType = normalizeType(getField(row, fieldKeys.classType));
          const content = getField(row, fieldKeys.content);
          const duration = parseNumber(getField(row, fieldKeys.duration));
          const order = parseNumber(getField(row, fieldKeys.order));
          const imageUrls = parseList(getField(row, fieldKeys.imageUrls));
          const hasAssignment = parseBool(getField(row, fieldKeys.hasAssignment));
          const assignmentTemplateUrl = getField(row, fieldKeys.assignmentTemplateUrl);

          return {
            row: idx + 2,
            courseTitle,
            courseDescription,
            introVideoUrl,
            category,
            lessonTitle,
            classTitle,
            classType,
            content,
            duration,
            order,
            imageUrls,
            hasAssignment,
            assignmentTemplateUrl,
          };
        })
        .filter((row): row is ParsedRow => Boolean(row));

      if (mapped.length === 0) {
        setParseError("No se encontraron filas válidas. Asegúrate de incluir Curso, Lección y TítuloClase.");
        return;
      }
      setParsedRows(mapped);
      setFileName(file.name);
      toast.success(`Archivo leído: ${mapped.length} clase(s) detectadas`);
    } catch (err) {
      console.error(err);
      setParseError("No se pudo leer el archivo. Usa un Excel o CSV con encabezados.");
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await parseFile(file);
  };

  const downloadTemplate = () => {
    const sheet = XLSX.utils.aoa_to_sheet(sampleData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Cursos");
    XLSX.writeFile(wb, "plantilla-cursos.xlsx");
  };

  const handleImport = async () => {
    if (!teacherId) {
      toast.error("Debes iniciar sesión para cargar cursos.");
      return;
    }
    if (!parsedRows.length) {
      toast.error("Primero sube un Excel con clases.");
      return;
    }
    setImporting(true);
    setResults([]);
    const outcome: ImportResult[] = [];
    try {
      const courseCache = new Map<string, string>();
      const lessonCache = new Map<string, string>();
      const lessonOrderPerCourse = new Map<string, number>();
      const classOrderPerLesson = new Map<string, number>();

      const ensureCourse = async (row: ParsedRow) => {
        const cached = courseCache.get(row.courseTitle);
        if (cached) return cached;
        const courseId = await createCourse({
          title: row.courseTitle,
          description: row.courseDescription,
          introVideoUrl: row.introVideoUrl,
          category: row.category,
          teacherId,
          teacherName: teacherName ?? auth.currentUser?.displayName ?? "",
        });
        courseCache.set(row.courseTitle, courseId);
        lessonOrderPerCourse.set(row.courseTitle, 0);
        return courseId;
      };

      const ensureLesson = async (courseId: string, row: ParsedRow) => {
        const key = `${row.courseTitle}::${row.lessonTitle}`;
        const cached = lessonCache.get(key);
        if (cached) return cached;
        const nextOrder = (lessonOrderPerCourse.get(row.courseTitle) ?? 0) + 1;
        lessonOrderPerCourse.set(row.courseTitle, nextOrder);
        const lessonId = await createLesson({
          courseId,
          title: row.lessonTitle,
          description: "",
          lessonNumber: nextOrder,
          order: nextOrder,
        });
        lessonCache.set(key, lessonId);
        classOrderPerLesson.set(key, 0);
        return lessonId;
      };

      for (const row of parsedRows) {
        try {
          const courseId = await ensureCourse(row);
          const lessonId = await ensureLesson(courseId, row);

          const classKey = `${row.courseTitle}::${row.lessonTitle}`;
          const nextOrder = row.order ?? (classOrderPerLesson.get(classKey) ?? 0) + 1;
          classOrderPerLesson.set(classKey, nextOrder);

          const payload: Parameters<typeof createClass>[0] = {
            courseId,
            lessonId,
            title: row.classTitle,
            type: row.classType,
            order: nextOrder,
            duration: row.duration ?? undefined,
            hasAssignment: row.hasAssignment,
            assignmentTemplateUrl: row.assignmentTemplateUrl || undefined,
          };

          if (row.classType === "video") payload.videoUrl = row.content;
          else if (row.classType === "audio") payload.audioUrl = row.content;
          else if (row.classType === "text" || row.classType === "quiz") payload.content = row.content;
          else if (row.classType === "image") {
            const urls =
              row.imageUrls.length > 0
                ? row.imageUrls
                : row.content
                    .split(/[|;,\n]/)
                    .map((u) => u.trim())
                    .filter(Boolean);
            payload.imageUrls = urls;
          }

          await createClass(payload);

          outcome.push({
            row: row.row,
            title: row.courseTitle,
            lesson: row.lessonTitle,
            classTitle: row.classTitle,
            status: "ok",
          });
        } catch (err) {
          console.error(err);
          outcome.push({
            row: row.row,
            title: row.courseTitle,
            lesson: row.lessonTitle,
            classTitle: row.classTitle,
            status: "error",
            message: "Error al crear la fila",
          });
        }
      }
      setResults(outcome);
      const success = outcome.filter((r) => r.status === "ok").length;
      const failures = outcome.length - success;
      if (success > 0) {
        toast.success(`Se crearon ${success} clase(s) con sus cursos/lecciones.`);
        await onImported?.();
      }
      if (failures > 0) {
        toast.error(`${failures} fila(s) no se pudieron crear.`);
      }
      if (failures === 0) {
        reset();
        onClose();
      }
    } finally {
      setImporting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-4xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
              Carga masiva
            </p>
            <h2 className="text-xl font-semibold text-slate-900">
              Subir cursos desde Excel
            </h2>
            <p className="text-sm text-slate-600">
              Usa un Excel/CSV con encabezados. Cada fila representa una clase. Columnas
              esperadas: Curso, DescripciónCurso, IntroVideoUrl, Categoría, Lección, Tipo
              (video/text/audio/image/quiz), TítuloClase, Contenido/URL, Duración (opcional),
              Orden (opcional), ImageUrls (opcional, separadas por | o ;), HasAssignment (sí/no),
              AssignmentTemplateUrl.
            </p>
          </div>
          <button
            onClick={() => {
              reset();
              onClose();
            }}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            ✕
          </button>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1.3fr_1fr]">
          <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  Selecciona archivo
                </p>
                <p className="text-xs text-slate-500">
                  Formatos: .xlsx, .xls, .csv
                </p>
              </div>
              <button
                type="button"
                onClick={downloadTemplate}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-blue-500 hover:text-blue-600"
              >
                Descargar plantilla
              </button>
            </div>

            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500 transition hover:border-blue-400">
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleFileChange}
              />
              <span className="text-3xl">📤</span>
              <div>
                <p className="font-semibold text-slate-800">
                  {fileName || "Arrastra o selecciona tu archivo"}
                </p>
                <p className="text-xs text-slate-500">
                  Máximo 5 MB recomendado
                </p>
              </div>
            </label>

            {parseError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {parseError}
              </div>
            ) : parsedRows.length > 0 ? (
              <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                Se detectaron {parsedRows.length} clase(s). Continúa para crearlas.
              </div>
            ) : null}

            {preview.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <p className="text-sm font-semibold text-slate-800">
                    Vista previa (primeras {preview.length} filas)
                  </p>
                  <span className="text-xs text-slate-500">Fila real indicada</span>
                </div>
                <div className="divide-y divide-slate-100 text-sm">
                  {preview.map((row) => (
                    <div key={row.row} className="grid gap-3 px-4 py-3 lg:grid-cols-[60px_1fr]">
                      <div className="text-xs font-semibold text-slate-500">
                        Fila {row.row}
                      </div>
                      <div className="space-y-1">
                        <p className="font-semibold text-slate-900">{row.courseTitle}</p>
                        {row.courseDescription && (
                          <p className="text-xs text-slate-600 line-clamp-2">
                            {row.courseDescription}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                          {row.category && <span>#{row.category}</span>}
                          {row.introVideoUrl && <span>{row.introVideoUrl}</span>}
                        </div>
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
                          <p className="font-semibold text-slate-900">
                            Lección: {row.lessonTitle}
                          </p>
                          <p className="font-semibold text-slate-900">
                            Clase: {row.classTitle} ({row.classType})
                          </p>
                          <div className="flex flex-wrap gap-2 pt-1 text-[11px] text-slate-500">
                            <span>Orden: {row.order ?? "auto"}</span>
                            {row.duration && <span>Duración: {row.duration} min</span>}
                            {row.hasAssignment && <span>Asignación: sí</span>}
                          </div>
                          {row.content && (
                            <p className="pt-1 text-[11px] text-slate-600 line-clamp-2">
                              {row.content}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                          {row.imageUrls.length > 0 && <span>{row.imageUrls.length} imagen(es)</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
            <div className="space-y-2">
                <p className="text-sm font-semibold text-slate-900">Estado</p>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  <p>
                    1) Descarga la plantilla o usa tu Excel con encabezados.
                    2) Revisa la vista previa.
                    3) Haz clic en &quot;Crear cursos&quot; para generar cursos, lecciones y clases.
                  </p>
                  <p className="pt-2 text-xs text-slate-500">
                    Las filas sin título se omiten automáticamente.
                  </p>
                </div>
              </div>

            {results.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-slate-900">Resultados</p>
                <div className="max-h-56 space-y-2 overflow-auto rounded-lg border border-slate-200 p-3 text-sm">
                  {results.map((res) => (
                    <div
                      key={`${res.row}-${res.title}`}
                      className={`flex items-start justify-between gap-3 rounded-lg px-3 py-2 ${
                        res.status === "ok"
                          ? "bg-green-50 text-green-800 border border-green-200"
                          : "bg-red-50 text-red-800 border border-red-200"
                      }`}
                    >
                      <div>
                        <p className="font-semibold">
                          Fila {res.row}: {res.title || "Curso"} / {res.lesson || "Lección"} /{" "}
                          {res.classTitle || "Clase"}
                        </p>
                        {res.message && (
                          <p className="text-xs opacity-80">{res.message}</p>
                        )}
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-wide">
                        {res.status === "ok" ? "Creado" : "Error"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={reset}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                disabled={importing}
              >
                Limpiar
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={importing || parsedRows.length === 0}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {importing ? "Creando cursos..." : "Crear cursos, lecciones y clases"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
