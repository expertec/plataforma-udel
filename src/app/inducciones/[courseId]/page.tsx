"use client";

import { use, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { onAuthStateChanged } from "firebase/auth";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Headphones,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  PlayCircle,
  Radio,
} from "lucide-react";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";
import {
  type ClassItem,
  type Course,
  getClasses,
  getCourse,
  getLessons,
  type Lesson,
} from "@/lib/firebase/courses-service";
import { buildLiveClassHref } from "@/app/aula/_lib/gating";
import { sanitizeClassContent } from "@/app/aula/_lib/sanitize";

type LessonWithClasses = Lesson & {
  classes: ClassItem[];
};

type ClassEntry = {
  cls: ClassItem;
  lessonId: string;
  lessonTitle: string;
};

const classTypeLabel: Record<ClassItem["type"], string> = {
  video: "Video",
  text: "Lectura",
  audio: "Audio",
  quiz: "Cuestionario",
  image: "Imagen",
  live: "En vivo",
};

const typeIcon = (type: ClassItem["type"]) => {
  if (type === "quiz") return ListChecks;
  if (type === "text") return FileText;
  if (type === "audio") return Headphones;
  if (type === "image") return ImageIcon;
  if (type === "live") return Radio;
  return PlayCircle;
};

const getEmbedUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com") {
      const id = parsed.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      const id = parsed.pathname.split("/").filter(Boolean).pop();
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }
    return null;
  } catch {
    return null;
  }
};

const isDirectVideoUrl = (url: string): boolean =>
  /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(url.trim());

function EmptyMedia({ message }: { message: string }) {
  return (
    <div className="flex aspect-video w-full items-center justify-center rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] px-6 text-center text-sm text-[var(--aula-text-muted)]">
      {message}
    </div>
  );
}

function ClassMedia({
  cls,
  courseId,
  lessonId,
}: {
  cls: ClassItem;
  courseId: string;
  lessonId?: string;
}) {
  if (cls.type === "video") {
    const videoUrl = cls.videoUrl?.trim() ?? "";
    const embedUrl = getEmbedUrl(videoUrl);
    if (embedUrl) {
      return (
        <div className="aspect-video overflow-hidden rounded-2xl bg-black">
          <iframe
            src={embedUrl}
            title={cls.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="h-full w-full"
          />
        </div>
      );
    }
    if (videoUrl && isDirectVideoUrl(videoUrl)) {
      return (
        <div className="overflow-hidden rounded-2xl bg-black">
          <video src={videoUrl} controls className="aspect-video w-full" />
        </div>
      );
    }
    if (videoUrl) {
      return (
        <div className="flex aspect-video flex-col items-center justify-center gap-4 rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] px-6 text-center">
          <PlayCircle size={42} className="text-[var(--aula-accent-soft)]" />
          <p className="max-w-md text-sm text-[var(--aula-text-muted)]">
            Este video se abre desde su proveedor externo.
          </p>
          <a
            href={videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--aula-accent)] px-5 py-2.5 text-sm font-semibold text-white"
          >
            Abrir video
            <ExternalLink size={16} />
          </a>
        </div>
      );
    }
    return <EmptyMedia message="Esta clase de video todavía no tiene un enlace configurado." />;
  }

  if (cls.type === "audio") {
    if (!cls.audioUrl) return <EmptyMedia message="Esta clase de audio todavía no tiene archivo." />;
    return (
      <div className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-6">
        <p className="mb-4 text-sm font-medium text-[var(--aula-text-muted)]">{cls.title}</p>
        <audio src={cls.audioUrl} controls className="w-full" />
      </div>
    );
  }

  if (cls.type === "image") {
    const images = cls.imageUrls ?? [];
    if (images.length === 0) return <EmptyMedia message="Esta clase todavía no tiene imágenes." />;
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {images.map((imageUrl, index) => (
          <div
            key={`${imageUrl}-${index}`}
            className="relative aspect-video overflow-hidden rounded-2xl border border-[var(--aula-border)] bg-black"
          >
            <Image
              src={imageUrl}
              alt={`${cls.title} ${index + 1}`}
              fill
              unoptimized
              className="object-contain"
            />
          </div>
        ))}
      </div>
    );
  }

  if (cls.type === "live") {
    return (
      <div className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-500/15 text-red-400">
          <Radio size={26} />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-[var(--aula-text)]">{cls.title}</h2>
        <p className="mt-2 text-sm text-[var(--aula-text-muted)]">Esta clase se imparte en vivo.</p>
        <Link
          href={buildLiveClassHref({ classId: cls.id, courseId, lessonId })}
          className="mt-6 inline-flex rounded-xl bg-[var(--aula-accent)] px-5 py-2.5 text-sm font-semibold text-white"
        >
          Ir a la sala
        </Link>
      </div>
    );
  }

  if (cls.type === "quiz") {
    return (
      <div className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-8">
        <div className="flex items-center gap-3 text-[var(--aula-text)]">
          <ListChecks size={24} className="text-[var(--aula-accent-soft)]" />
          <h2 className="text-xl font-semibold">{cls.title}</h2>
        </div>
        <p className="mt-3 text-sm text-[var(--aula-text-muted)]">
          Esta clase contiene un cuestionario. La vista de inducciones permite revisar el contenido
          sin registrar intentos o calificaciones.
        </p>
      </div>
    );
  }

  return null;
}

function InductionCourseExperience({ courseId }: { courseId: string }) {
  const [course, setCourse] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<LessonWithClasses[]>([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (!active) return;
        setLoading(false);
        setError("Inicia sesión para abrir esta inducción.");
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const courseData = await getCourse(courseId);
        if (!courseData || courseData.isInduction !== true) {
          throw new Error("Esta inducción no está disponible.");
        }
        const courseLessons = await getLessons(courseId);
        const lessonsWithClasses = await Promise.all(
          courseLessons.map(async (lesson) => ({
            ...lesson,
            classes: await getClasses(courseId, lesson.id),
          })),
        );
        if (!active) return;
        setCourse(courseData);
        setLessons(lessonsWithClasses);
        setSelectedClassId(lessonsWithClasses.flatMap((lesson) => lesson.classes)[0]?.id ?? "");
      } catch (err) {
        console.error("No se pudo cargar la inducción:", err);
        if (active) {
          setError(err instanceof Error ? err.message : "No pudimos cargar esta inducción.");
        }
      } finally {
        if (active) setLoading(false);
      }
    });

    return () => {
      active = false;
      unsub();
    };
  }, [courseId]);

  const flatClasses = useMemo<ClassEntry[]>(
    () =>
      lessons.flatMap((lesson) =>
        lesson.classes.map((cls) => ({
          cls,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
        })),
      ),
    [lessons],
  );

  const selectedClass =
    flatClasses.find((entry) => entry.cls.id === selectedClassId) ?? flatClasses[0] ?? null;
  const selectedIndex = selectedClass
    ? flatClasses.findIndex((entry) => entry.cls.id === selectedClass.cls.id)
    : -1;
  const selectedClassContent = selectedClass?.cls.content?.trim()
    ? sanitizeClassContent(selectedClass.cls.content)
    : "";

  const selectByOffset = (offset: -1 | 1) => {
    const next = flatClasses[selectedIndex + offset];
    if (next) setSelectedClassId(next.cls.id);
  };

  if (loading) {
    return (
      <main className="aula-shell flex min-h-screen items-center justify-center bg-[var(--aula-bg)] text-[var(--aula-text)]">
        <Loader2 size={30} className="animate-spin text-[var(--aula-text-muted)]" />
      </main>
    );
  }

  if (error || !course) {
    return (
      <main className="aula-shell flex min-h-screen items-center justify-center bg-[var(--aula-bg)] px-4 text-[var(--aula-text)]">
        <div className="max-w-md rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-8 text-center">
          <BookOpen size={40} className="mx-auto text-[var(--aula-text-muted)]" />
          <h1 className="mt-4 text-lg font-semibold">No pudimos abrir la inducción</h1>
          <p className="mt-2 text-sm text-[var(--aula-text-muted)]">
            {error ?? "La inducción no está disponible."}
          </p>
          <Link
            href="/creator/inducciones"
            className="mt-6 inline-flex rounded-xl border border-[var(--aula-border)] px-4 py-2 text-sm font-medium text-[var(--aula-text)] hover:bg-white/5"
          >
            Volver al catálogo
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="aula-shell min-h-screen bg-[var(--aula-bg)] text-[var(--aula-text)]">
      <header className="sticky top-0 z-30 border-b border-[var(--aula-border)] bg-[var(--aula-surface)]">
        <div className="flex min-h-16 items-center gap-3 px-4 lg:px-6">
          <Link
            href="/creator/inducciones"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--aula-border)] text-[var(--aula-text-muted)] hover:bg-white/5 hover:text-[var(--aula-text)]"
            aria-label="Volver al catálogo"
          >
            <ArrowLeft size={18} />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wide text-[var(--aula-text-muted)]">
              Curso de inducción
            </p>
            <h1 className="truncate text-base font-semibold text-[var(--aula-text)]">
              {course.title}
            </h1>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <button
              type="button"
              onClick={() => selectByOffset(-1)}
              disabled={selectedIndex <= 0}
              className="rounded-lg border border-[var(--aula-border)] p-2 text-[var(--aula-text-muted)] hover:bg-white/5 disabled:opacity-30"
              aria-label="Clase anterior"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="min-w-16 text-center text-sm font-semibold text-[var(--aula-text-muted)]">
              {selectedIndex >= 0 ? selectedIndex + 1 : 0}/{flatClasses.length}
            </span>
            <button
              type="button"
              onClick={() => selectByOffset(1)}
              disabled={selectedIndex < 0 || selectedIndex >= flatClasses.length - 1}
              className="rounded-lg border border-[var(--aula-border)] p-2 text-[var(--aula-text-muted)] hover:bg-white/5 disabled:opacity-30"
              aria-label="Siguiente clase"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-4rem)] lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="border-b border-[var(--aula-border)] bg-[var(--aula-surface)] lg:border-b-0 lg:border-r">
          <div className="border-b border-[var(--aula-border)] p-4">
            <div className="relative aspect-video overflow-hidden rounded-2xl bg-black">
              {course.thumbnail ? (
                <Image
                  src={course.thumbnail}
                  alt={course.title}
                  fill
                  unoptimized
                  className="object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[var(--aula-text-muted)]">
                  <BookOpen size={44} />
                </div>
              )}
            </div>
            <p className="mt-3 text-sm leading-relaxed text-[var(--aula-text-muted)]">
              {course.description || "Sin descripción"}
            </p>
          </div>

          <div className="max-h-[42vh] overflow-y-auto px-3 py-3 lg:max-h-[calc(100vh-18rem)]">
            {lessons.length === 0 ? (
              <p className="px-2 py-3 text-sm text-[var(--aula-text-muted)]">
                No hay lecciones configuradas.
              </p>
            ) : (
              lessons.map((lesson) => (
                <section key={lesson.id} className="mb-4">
                  <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-[var(--aula-text-muted)]">
                    {lesson.title}
                  </h2>
                  <div className="mt-2 space-y-1">
                    {lesson.classes.length === 0 ? (
                      <p className="px-2 py-2 text-xs text-[var(--aula-text-muted)]">Sin clases</p>
                    ) : (
                      lesson.classes.map((cls) => {
                        const active = cls.id === selectedClass?.cls.id;
                        const Icon = typeIcon(cls.type);
                        return (
                          <button
                            key={cls.id}
                            type="button"
                            onClick={() => setSelectedClassId(cls.id)}
                            className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                              active
                                ? "bg-[var(--aula-accent)]/15 text-[var(--aula-text)]"
                                : "text-[var(--aula-text)] hover:bg-white/5"
                            }`}
                          >
                            <span className="mt-0.5 shrink-0">
                              {active ? (
                                <CheckCircle2
                                  size={16}
                                  className="text-[var(--aula-accent-soft)]"
                                />
                              ) : (
                                <Icon size={16} className="text-[var(--aula-text-muted)]" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm leading-snug">{cls.title}</span>
                              <span className="mt-0.5 block text-xs text-[var(--aula-text-muted)]">
                                {classTypeLabel[cls.type]}
                              </span>
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </section>
              ))
            )}
          </div>
        </aside>

        <section className="min-w-0 px-4 py-6 sm:px-6 lg:px-8">
          {selectedClass ? (
            <div className="mx-auto max-w-6xl space-y-6">
              <div>
                <p className="text-xs uppercase tracking-wide text-[var(--aula-text-muted)]">
                  {selectedClass.lessonTitle}
                </p>
                <h2 className="mt-1 text-2xl font-semibold text-[var(--aula-text)]">
                  {selectedClass.cls.title}
                </h2>
              </div>
              <ClassMedia
                cls={selectedClass.cls}
                courseId={course.id}
                lessonId={selectedClass.lessonId}
              />
              {selectedClassContent ? (
                <article className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-6">
                  <div
                    className="aula-prose"
                    dangerouslySetInnerHTML={{ __html: selectedClassContent }}
                  />
                </article>
              ) : null}
              <div className="flex items-center justify-between gap-3 sm:hidden">
                <button
                  type="button"
                  onClick={() => selectByOffset(-1)}
                  disabled={selectedIndex <= 0}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--aula-border)] px-4 py-2 text-sm font-medium text-[var(--aula-text)] hover:bg-white/5 disabled:opacity-30"
                >
                  <ChevronLeft size={16} />
                  Anterior
                </button>
                <button
                  type="button"
                  onClick={() => selectByOffset(1)}
                  disabled={selectedIndex < 0 || selectedIndex >= flatClasses.length - 1}
                  className="inline-flex items-center gap-2 rounded-xl bg-[var(--aula-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-30"
                >
                  Siguiente
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex min-h-[60vh] max-w-xl items-center justify-center">
              <EmptyMedia message="Esta inducción todavía no tiene clases configuradas." />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default function InductionCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = use(params);

  return (
    <RoleGate
      allowedRole={[
        "teacher",
        "adminTeacher",
        "superAdminTeacher",
        "coordinadorPlantel",
        "director",
      ]}
    >
      <InductionCourseExperience courseId={courseId} />
    </RoleGate>
  );
}
