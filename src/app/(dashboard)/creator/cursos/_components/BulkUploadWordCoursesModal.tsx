"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { auth } from "@/lib/firebase/client";
import {
  createClass,
  createCourse,
  createLesson,
  createQuizQuestion,
} from "@/lib/firebase/courses-service";
import { getPrograms } from "@/lib/firebase/programs-service";
import {
  parseWordCourseTemplate,
  type WordImportedClass,
  type WordImportedLesson,
  type WordImportedQuizQuestion,
} from "@/lib/course-word-template-parser";

type BulkUploadWordCoursesModalProps = {
  open: boolean;
  onClose: () => void;
  teacherId?: string | null;
  teacherName?: string | null;
  onImported?: () => Promise<void> | void;
};

type ParsedLessonFromFile = WordImportedLesson & {
  sourceFileName: string;
};

type ImportResult = {
  lessonTitle: string;
  classTitle?: string;
  status: "ok" | "error";
  message: string;
};

type MammothResult = {
  value: string;
  messages: Array<{ type: string; message: string }>;
};

type MammothModule = {
  extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<MammothResult>;
};

type ImportVimeoApiResponse = {
  success?: boolean;
  data?: {
    downloadUrl?: string;
  };
  error?: string;
};

const previewIconPaths: Record<WordImportedClass["type"], string> = {
  video:
    "M15 10.5V7a1 1 0 00-1-1H5.5A1.5 1.5 0 004 7.5v9A1.5 1.5 0 005.5 18H14a1 1 0 001-1v-3l4 3V7.5l-4 3z",
  text: "M7 5h10M7 9h6M7 13h10M7 17h6",
  quiz: "M9 7l6 4-6 4V7z",
};

const previewTypeLabel: Record<WordImportedClass["type"], string> = {
  video: "Video",
  text: "Texto",
  quiz: "Quiz",
};

const stripFileExtension = (fileName: string): string =>
  fileName.replace(/\.[^/.]+$/, "").trim() || "Lección";

const inferCourseTitleFromFileName = (fileName: string): string =>
  stripFileExtension(fileName)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const totalClassesCount = (lessons: ParsedLessonFromFile[]): number =>
  lessons.reduce((acc, lesson) => acc + lesson.classes.length, 0);

const totalVideoCount = (lessons: ParsedLessonFromFile[]): number =>
  lessons.reduce(
    (acc, lesson) => acc + lesson.classes.filter((classItem) => classItem.type === "video").length,
    0,
  );

const totalAssignmentCount = (lessons: ParsedLessonFromFile[]): number =>
  lessons.reduce(
    (acc, lesson) => acc + lesson.classes.filter((classItem) => classItem.hasAssignment).length,
    0,
  );

const totalForumCount = (lessons: ParsedLessonFromFile[]): number =>
  lessons.reduce(
    (acc, lesson) => acc + lesson.classes.filter((classItem) => classItem.forumEnabled).length,
    0,
  );

const previewLessonKey = (lesson: ParsedLessonFromFile, index: number): string =>
  `${lesson.sourceFileName}:${index}:${lesson.title}`;

const isVimeoUrl = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.includes("vimeo.com");
  } catch {
    return /vimeo\.com/i.test(url);
  }
};

async function extractRawTextFromDocx(file: File): Promise<MammothResult> {
  const mammothImport = (await import("mammoth")) as unknown as {
    default?: MammothModule;
  } & MammothModule;
  const mammoth = mammothImport.default ?? mammothImport;
  return mammoth.extractRawText({
    arrayBuffer: await file.arrayBuffer(),
  });
}

function normalizeLessonTitle(title: string, fallback: string): string {
  const trimmed = title.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/\s+/g, " ");
}

function PreviewClassIcon({ type }: { type: WordImportedClass["type"] }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5 text-slate-500"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={previewIconPaths[type]} />
    </svg>
  );
}

function classPreviewSubtitle(classItem: WordImportedClass): string {
  if (classItem.type === "video") {
    return classItem.videoUrl?.trim() || "Sin URL de video";
  }
  if (classItem.type === "quiz") {
    const questionsCount = classItem.quizQuestions?.length ?? 0;
    return `${questionsCount} pregunta(s) importadas`;
  }
  if (classItem.content?.trim()) {
    return classItem.content.replace(/\s+/g, " ").slice(0, 120);
  }
  return previewTypeLabel[classItem.type];
}

function classToPayload(
  courseId: string,
  lessonId: string,
  classItem: WordImportedClass,
  order: number,
): Parameters<typeof createClass>[0] {
  const sharedFlags = {
    hasAssignment: classItem.hasAssignment ?? false,
    assignmentSubmissionType:
      classItem.hasAssignment && classItem.assignmentSubmissionType === "audio"
        ? "audio"
        : "file",
    forumEnabled: classItem.forumEnabled ?? false,
    forumRequiredFormat: classItem.forumEnabled ? classItem.forumRequiredFormat ?? "text" : null,
  } as const;

  if (classItem.type === "video") {
    return {
      courseId,
      lessonId,
      title: classItem.title,
      type: "video",
      order,
      videoUrl: classItem.videoUrl ?? "",
      content: classItem.content ?? "",
      ...sharedFlags,
    };
  }
  if (classItem.type === "quiz") {
    return {
      courseId,
      lessonId,
      title: classItem.title,
      type: "quiz",
      order,
      content: classItem.content ?? "Cuestionario importado desde Word",
      ...sharedFlags,
    };
  }
  return {
    courseId,
    lessonId,
    title: classItem.title,
    type: "text",
    order,
    content: classItem.content ?? "",
    ...sharedFlags,
  };
}

async function createImportedQuizQuestions(params: {
  courseId: string;
  lessonId: string;
  classId: string;
  questions: WordImportedQuizQuestion[];
}) {
  const { courseId, lessonId, classId, questions } = params;
  const defaultPointValue =
    questions.find((question) => Number.isFinite(question.pointValue))?.pointValue ?? 1;

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!;
    const options = (question.options ?? [])
      .filter((option) => option.text.trim().length > 0)
      .map((option, optionIndex) => ({
        id: `q${index + 1}-o${optionIndex + 1}`,
        text: option.text.trim(),
        isCorrect: option.isCorrect === true,
      }));

    if (question.type !== "open" && options.length < 2) {
      continue;
    }

    const hasCorrect = options.some((option) => option.isCorrect);
    if (!hasCorrect && options.length > 0) {
      options[0]!.isCorrect = true;
    }

    await createQuizQuestion({
      courseId,
      lessonId,
      classId,
      prompt: question.prompt.trim(),
      explanation: question.explanation?.trim() || "",
      type: question.type ?? "multiple",
      options: question.type === "open" ? [] : options,
      answerText: question.type === "open" ? question.answerText?.trim() || "" : undefined,
      order: index,
      pointValue:
        typeof question.pointValue === "number" && Number.isFinite(question.pointValue)
          ? question.pointValue
          : defaultPointValue,
    });
  }
}

export function BulkUploadWordCoursesModal({
  open,
  onClose,
  teacherId,
  teacherName,
  onImported,
}: BulkUploadWordCoursesModalProps) {
  const [courseTitle, setCourseTitle] = useState("");
  const [courseDescription, setCourseDescription] = useState("");
  const [introVideoUrl, setIntroVideoUrl] = useState("");
  const [program, setProgram] = useState("");
  const [programOptions, setProgramOptions] = useState<string[]>([]);
  const [programLoading, setProgramLoading] = useState(false);

  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [mirrorVimeoToFirebase, setMirrorVimeoToFirebase] = useState(true);
  const [allowVimeoFallback, setAllowVimeoFallback] = useState(true);
  const [parseError, setParseError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [parsedLessons, setParsedLessons] = useState<ParsedLessonFromFile[]>([]);
  const [expandedPreviewLessons, setExpandedPreviewLessons] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ImportResult[]>([]);

  const inputRef = useRef<HTMLInputElement | null>(null);

  const summary = useMemo(
    () => ({
      lessons: parsedLessons.length,
      classes: totalClassesCount(parsedLessons),
      videos: totalVideoCount(parsedLessons),
      assignments: totalAssignmentCount(parsedLessons),
      forums: totalForumCount(parsedLessons),
    }),
    [parsedLessons],
  );

  useEffect(() => {
    if (!open) return;
    let active = true;
    const loadPrograms = async () => {
      setProgramLoading(true);
      try {
        const data = await getPrograms();
        if (!active) return;
        const names = Array.from(new Set(data.map((p) => p.name).filter(Boolean)));
        setProgramOptions(names);
      } catch (error) {
        console.error(error);
        toast.error("No se pudieron cargar los programas");
      } finally {
        if (active) setProgramLoading(false);
      }
    };
    loadPrograms();
    return () => {
      active = false;
    };
  }, [open]);

  const reset = () => {
    setCourseTitle("");
    setCourseDescription("");
    setIntroVideoUrl("");
    setProgram("");
    setMirrorVimeoToFirebase(true);
    setAllowVimeoFallback(true);
    setParseError(null);
    setWarnings([]);
    setSelectedFiles([]);
    setParsedLessons([]);
    setExpandedPreviewLessons(new Set());
    setResults([]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const parseFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const docxFiles = Array.from(files).filter((file) => file.name.toLowerCase().endsWith(".docx"));
    if (docxFiles.length === 0) {
      setParseError("Selecciona al menos un archivo .docx");
      return;
    }

    const inferredCourseTitle = inferCourseTitleFromFileName(docxFiles[0]?.name ?? "");
    if (inferredCourseTitle) {
      setCourseTitle(inferredCourseTitle);
    }

    setParsing(true);
    setParseError(null);
    setWarnings([]);
    setParsedLessons([]);
    setExpandedPreviewLessons(new Set());
    setSelectedFiles(docxFiles);
    setResults([]);

    try {
      const nextLessons: ParsedLessonFromFile[] = [];
      const parseWarnings: string[] = [];

      for (const file of docxFiles) {
        const raw = await extractRawTextFromDocx(file);
        if (raw.messages.length > 0) {
          parseWarnings.push(
            ...raw.messages.map((message) => `${file.name}: ${message.message}`),
          );
        }

        const fallbackTitle = stripFileExtension(file.name);
        const lessonBlocks = parseWordCourseTemplate(raw.value, fallbackTitle);

        if (lessonBlocks.length === 0) {
          parseWarnings.push(
            `${file.name}: no se detectó contenido utilizable para crear lecciones.`,
          );
          continue;
        }

        lessonBlocks.forEach((lesson, index) => {
          nextLessons.push({
            ...lesson,
            title: normalizeLessonTitle(lesson.title, `${fallbackTitle} ${index + 1}`),
            sourceFileName: file.name,
          });
        });
      }

      if (nextLessons.length === 0) {
        setParseError("No fue posible extraer lecciones válidas de los archivos Word.");
        return;
      }

      setParsedLessons(nextLessons);
      setExpandedPreviewLessons(
        new Set(nextLessons.map((lesson, index) => previewLessonKey(lesson, index))),
      );
      setWarnings(parseWarnings);
      toast.success(
        `Se detectaron ${nextLessons.length} lección(es) y ${totalClassesCount(nextLessons)} clase(s).`,
      );
    } catch (error) {
      console.error(error);
      setParseError("No se pudo leer el archivo Word. Verifica que sea .docx.");
    } finally {
      setParsing(false);
    }
  };

  const mirrorVimeoVideoInFirebase = async (params: {
    courseId: string;
    lessonId: string;
    classId: string;
    title: string;
    sourceUrl: string;
  }): Promise<string> => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      throw new Error("Debes iniciar sesión para importar videos");
    }

    const idToken = await currentUser.getIdToken();
    const response = await fetch(
      `/api/courses/${encodeURIComponent(params.courseId)}/videos/import-vimeo`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          sourceUrl: params.sourceUrl,
          lessonId: params.lessonId,
          classId: params.classId,
          title: params.title,
        }),
      },
    );

    const payload = (await response.json().catch(() => null)) as ImportVimeoApiResponse | null;
    if (!response.ok || !payload?.success || !payload?.data?.downloadUrl) {
      throw new Error(payload?.error || "No se pudo copiar el video a Firebase");
    }

    return payload.data.downloadUrl;
  };

  const handleImport = async () => {
    if (!teacherId) {
      toast.error("Debes iniciar sesión para importar cursos.");
      return;
    }
    if (!courseTitle.trim()) {
      toast.error("Ingresa el título del curso.");
      return;
    }
    if (parsedLessons.length === 0) {
      toast.error("Primero carga y valida al menos un archivo Word.");
      return;
    }

    setImporting(true);
    setResults([]);
    const outcome: ImportResult[] = [];
    let vimeoFallbackCount = 0;

    try {
      const courseId = await createCourse({
        title: courseTitle.trim(),
        description: courseDescription.trim(),
        introVideoUrl: introVideoUrl.trim(),
        program: program.trim(),
        teacherId,
        teacherName: teacherName ?? auth.currentUser?.displayName ?? "",
      });

      for (let lessonIndex = 0; lessonIndex < parsedLessons.length; lessonIndex += 1) {
        const lesson = parsedLessons[lessonIndex];
        const lessonOrder = lessonIndex + 1;

        try {
          const lessonId = await createLesson({
            courseId,
            title: lesson.title,
            description: "",
            lessonNumber: lessonOrder,
            order: lessonOrder,
          });

          outcome.push({
            lessonTitle: lesson.title,
            status: "ok",
            message: "Lección creada",
          });

          for (let classIndex = 0; classIndex < lesson.classes.length; classIndex += 1) {
            const classItem = lesson.classes[classIndex];
            try {
              let classToCreate = classItem;
              let classMessageSuffix = "";

              if (
                mirrorVimeoToFirebase &&
                classItem.type === "video" &&
                classItem.videoUrl &&
                isVimeoUrl(classItem.videoUrl)
              ) {
                try {
                  const mirroredUrl = await mirrorVimeoVideoInFirebase({
                    courseId,
                    lessonId,
                    classId: `orden-${classIndex + 1}`,
                    title: classItem.title,
                    sourceUrl: classItem.videoUrl,
                  });
                  classToCreate = {
                    ...classItem,
                    videoUrl: mirroredUrl,
                  };
                  classMessageSuffix = " (video guardado en Firebase)";
                } catch (mirrorError) {
                  if (!allowVimeoFallback) {
                    throw mirrorError;
                  }
                  vimeoFallbackCount += 1;
                  const reason =
                    mirrorError instanceof Error && mirrorError.message
                      ? mirrorError.message
                      : "No se pudo copiar video a Firebase";
                  console.warn(`No se pudo copiar video a Firebase, se mantiene Vimeo: ${reason}`);
                  classMessageSuffix = " (fallback: se mantuvo Vimeo)";
                }
              }

              const classId = await createClass(
                classToPayload(courseId, lessonId, classToCreate, classIndex + 1),
              );

              if (classToCreate.type === "quiz" && (classToCreate.quizQuestions?.length ?? 0) > 0) {
                await createImportedQuizQuestions({
                  courseId,
                  lessonId,
                  classId,
                  questions: classToCreate.quizQuestions ?? [],
                });
              }

              outcome.push({
                lessonTitle: lesson.title,
                classTitle: classItem.title,
                status: "ok",
                message: `Clase creada${classMessageSuffix}`,
              });
            } catch (classError) {
              console.error(classError);
              outcome.push({
                lessonTitle: lesson.title,
                classTitle: classItem.title,
                status: "error",
                message: "No se pudo crear la clase",
              });
            }
          }
        } catch (lessonError) {
          console.error(lessonError);
          outcome.push({
            lessonTitle: lesson.title,
            status: "error",
            message: "No se pudo crear la lección",
          });
        }
      }

      setResults(outcome);
      const okCount = outcome.filter((item) => item.status === "ok").length;
      const failCount = outcome.length - okCount;

      if (okCount > 0) {
        toast.success("Curso importado desde Word");
        if (vimeoFallbackCount > 0) {
          toast(
            `${vimeoFallbackCount} video(s) no se pudieron copiar a Firebase y se dejaron con URL de Vimeo.`,
            { duration: 6000 },
          );
        }
        await onImported?.();
      }
      if (failCount > 0) {
        toast.error(`${failCount} elemento(s) fallaron durante la importación.`);
      }

      if (failCount === 0) {
        reset();
        onClose();
      }
    } catch (error) {
      console.error(error);
      toast.error("No se pudo crear el curso desde Word.");
    } finally {
      setImporting(false);
    }
  };

  const togglePreviewLesson = (lessonKey: string) => {
    setExpandedPreviewLessons((current) => {
      const next = new Set(current);
      if (next.has(lessonKey)) {
        next.delete(lessonKey);
      } else {
        next.add(lessonKey);
      }
      return next;
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-6">
      <div className="w-full max-w-5xl max-h-[calc(100vh-3rem)] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
              Importación Word
            </p>
            <h2 className="text-xl font-semibold text-slate-900">
              Subir curso desde plantilla .docx
            </h2>
            <p className="text-sm text-slate-600">
              Detecta lecciones y clases (texto + enlaces de video/recurso) a partir de plantillas
              de Word.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            ✕
          </button>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
          <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="text-sm font-medium text-slate-800">
                  Título del curso *
                </label>
                <input
                  value={courseTitle}
                  onChange={(event) => setCourseTitle(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="Ej. Inducción a la Psicología"
                />
              </div>

              <div className="md:col-span-2">
                <label className="text-sm font-medium text-slate-800">
                  Descripción corta (opcional)
                </label>
                <textarea
                  rows={3}
                  value={courseDescription}
                  onChange={(event) => setCourseDescription(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-slate-800">
                  Intro video URL (opcional)
                </label>
                <input
                  value={introVideoUrl}
                  onChange={(event) => setIntroVideoUrl(event.target.value)}
                  placeholder="https://vimeo.com/..."
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-slate-800">
                  Programa / carrera
                </label>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={program}
                  onChange={(event) => setProgram(event.target.value)}
                >
                  <option value="">{programLoading ? "Cargando..." : "Seleccionar"}</option>
                  {!programLoading && programOptions.length === 0 ? (
                    <option value="" disabled>
                      No hay programas
                    </option>
                  ) : null}
                  {programOptions.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
              <label className="flex items-start gap-2 text-sm text-slate-800">
                <input
                  type="checkbox"
                  checked={mirrorVimeoToFirebase}
                  onChange={(event) => setMirrorVimeoToFirebase(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span>
                  Copiar videos de Vimeo a Firebase Storage durante la importación
                </span>
              </label>

              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={allowVimeoFallback}
                  onChange={(event) => setAllowVimeoFallback(event.target.checked)}
                  disabled={!mirrorVimeoToFirebase}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                />
                <span>
                  Si falla la copia, conservar URL de Vimeo (fallback)
                </span>
              </label>
              <p className="text-xs text-slate-500">
                Intenta primero sin token (modo unlisted/config). Si no alcanza, usa{" "}
                <code>VIMEO_ACCESS_TOKEN</code> como fallback recomendado.
              </p>
            </div>

            <label className="mt-2 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500 transition hover:border-blue-400">
              <input
                ref={inputRef}
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                multiple
                className="hidden"
                onChange={(event) => {
                  void parseFiles(event.target.files);
                }}
              />
              <span className="text-3xl">📄</span>
              <div>
                <p className="font-semibold text-slate-800">
                  {selectedFiles.length > 0
                    ? `${selectedFiles.length} archivo(s) seleccionado(s)`
                    : "Selecciona una o varias plantillas Word"}
                </p>
                <p className="text-xs text-slate-500">
                  Formato: .docx | secciones tipo &quot;SEMANA 1&quot; se convierten en lecciones
                </p>
              </div>
            </label>

            {parseError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {parseError}
              </div>
            ) : null}

            {warnings.length > 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p className="font-semibold">Advertencias de parseo</p>
                <div className="mt-1 max-h-28 space-y-1 overflow-auto text-xs">
                  {warnings.map((warning, index) => (
                    <p key={`${warning}-${index}`}>{warning}</p>
                  ))}
                </div>
              </div>
            ) : null}

            {parsedLessons.length > 0 ? (
              <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                Detectadas {summary.lessons} lección(es), {summary.classes} clase(s), {summary.videos} video(s),{" "}
                {summary.assignments} con tarea y {summary.forums} con foro.
              </div>
            ) : null}

            {parsedLessons.length > 0 ? (
              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <p className="text-sm font-semibold text-slate-900">
                    Vista previa de lecciones
                  </p>
                  <span className="text-xs text-slate-500">
                    Misma estructura del constructor
                  </span>
                </div>
                <div className="max-h-[28rem] space-y-3 overflow-auto p-3">
                  {parsedLessons.map((lesson, lessonIndex) => {
                    const lessonKey = previewLessonKey(lesson, lessonIndex);
                    const lessonExpanded = expandedPreviewLessons.has(lessonKey);
                    return (
                      <div
                        key={lessonKey}
                        className="rounded-lg border border-slate-200 border-l-4 border-l-blue-500 bg-white p-3 shadow-sm"
                      >
                        <button
                          type="button"
                          onClick={() => togglePreviewLesson(lessonKey)}
                          className="flex w-full items-center gap-2 text-left"
                        >
                          <span className="text-sm text-slate-700">
                            {lessonExpanded ? "▼" : "▶"}
                          </span>
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              Lección {lessonIndex + 1}: {lesson.title}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              Archivo: {lesson.sourceFileName} · {lesson.classes.length} clase(s)
                            </p>
                          </div>
                        </button>

                        {lessonExpanded ? (
                          <div className="mt-3 space-y-1">
                            {lesson.classes.map((classItem, classIndex) => (
                              <div
                                key={`${lessonKey}-class-${classIndex}`}
                                className="flex items-start justify-between rounded-md px-3 py-2 pl-6 text-sm text-slate-700 hover:bg-slate-50"
                              >
                                <div className="flex min-w-0 items-start gap-3">
                                  <PreviewClassIcon type={classItem.type} />
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="font-medium text-slate-900">
                                        {classIndex + 1}. {classItem.title}
                                      </p>
                                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                                        {previewTypeLabel[classItem.type]}
                                      </span>
                                      {classItem.hasAssignment ? (
                                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                                          Tarea
                                        </span>
                                      ) : null}
                                      {classItem.forumEnabled ? (
                                        <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                                          Foro
                                        </span>
                                      ) : null}
                                    </div>
                                    <p className="mt-0.5 truncate text-xs text-slate-500">
                                      {classPreviewSubtitle(classItem)}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <p className="font-semibold text-slate-900">Flujo</p>
              <p className="pt-1">
                1) Define los datos del curso.
                <br />
                2) Sube plantillas Word (.docx).
                <br />
                3) Revisa vista previa.
                <br />
                4) Crea curso, lecciones y clases.
              </p>
            </div>

            {results.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-slate-900">Resultados</p>
                <div className="max-h-80 space-y-2 overflow-auto rounded-lg border border-slate-200 p-3 text-sm">
                  {results.map((result, index) => (
                    <div
                      key={`${result.lessonTitle}-${result.classTitle ?? "lesson"}-${index}`}
                      className={`rounded-lg border px-3 py-2 ${
                        result.status === "ok"
                          ? "border-green-200 bg-green-50 text-green-800"
                          : "border-red-200 bg-red-50 text-red-800"
                      }`}
                    >
                      <p className="font-semibold">
                        {result.lessonTitle}
                        {result.classTitle ? ` / ${result.classTitle}` : ""}
                      </p>
                      <p className="text-xs opacity-90">{result.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={reset}
                disabled={parsing || importing}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Limpiar
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={parsing || importing || parsedLessons.length === 0}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {parsing
                  ? "Analizando Word..."
                  : importing
                    ? "Creando curso..."
                    : "Crear curso desde Word"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
