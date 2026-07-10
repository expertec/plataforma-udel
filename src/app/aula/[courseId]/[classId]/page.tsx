"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, MessagesSquare } from "lucide-react";
import toast from "react-hot-toast";
import { useAulaData } from "../../_lib/AulaDataContext";
import { sanitizeClassContent } from "../../_lib/sanitize";
import { buildLockedMessage } from "../../_lib/gating";
import { ClassStage } from "../../_components/ClassStage";
import { ClassPanel } from "../../_components/ClassPanel";
import { CurriculumPanel } from "../../_components/CurriculumPanel";
import { Topbar } from "../../_components/Topbar";

type TabId = "comentarios" | "foro" | "tarea";

export default function ClassPage({
  params,
}: {
  params: Promise<{ courseId: string; classId: string }>;
}) {
  const { courseId, classId } = use(params);
  const router = useRouter();
  const {
    classes,
    curriculum,
    indexOfClass,
    isLockedAt,
    isComplete,
    markComplete,
    forumDone,
  } = useAulaData();

  const [curriculumOpen, setCurriculumOpen] = useState(false);
  // La pestaña se guarda junto a su clase: al cambiar de clase vuelve a comentarios.
  const [tabState, setTabState] = useState<{ classId: string; tab: TabId }>({
    classId,
    tab: "comentarios",
  });
  const activeTab: TabId = tabState.classId === classId ? tabState.tab : "comentarios";
  const setActiveTab = useCallback(
    (tab: TabId) => setTabState({ classId, tab }),
    [classId],
  );

  const index = indexOfClass(classId);
  const cls = index >= 0 ? classes[index] : null;
  const course = curriculum.find((entry) => entry.courseId === courseId);

  const locked = index >= 0 && isLockedAt(index);

  // Una clase bloqueada no se abre por URL: se regresa a la portada del curso.
  useEffect(() => {
    if (index < 0 || !locked) return;
    toast.error(buildLockedMessage(classes[index]));
    router.replace(`/aula/${courseId}`);
  }, [index, locked, classes, courseId, router]);

  const rawContent = cls?.content ?? "";
  const contentHtml = useMemo(
    () => (rawContent.trim() ? sanitizeClassContent(rawContent) : ""),
    [rawContent],
  );

  const courseItems = useMemo(
    () => course?.lessons.flatMap((lesson) => lesson.items) ?? [],
    [course],
  );
  const positionInCourse = courseItems.findIndex((item) => item.id === classId) + 1;

  if (!cls || !course) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center px-4">
        <p className="text-[var(--aula-text-muted)]">No encontramos esta clase.</p>
      </main>
    );
  }

  if (locked) return null;

  const done = isComplete(cls);
  const forumPending = cls.forumEnabled === true && forumDone[cls.id] !== true;

  return (
    <>
      <Topbar
        cls={cls}
        positionInCourse={positionInCourse}
        totalInCourse={courseItems.length}
        onOpenCurriculum={() => setCurriculumOpen(true)}
      />

      <main className="mx-auto grid max-w-[1600px] gap-6 px-4 py-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-6">
          <ClassStage cls={cls} contentHtml={contentHtml} />

          <div className="flex flex-wrap items-center gap-3">
            {done ? (
              <span className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-400">
                <CheckCircle2 size={16} />
                Clase completada
              </span>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  const ok = await markComplete(cls);
                  if (ok) toast.success("Clase marcada como completada");
                  else toast.error("No se pudo marcar la clase");
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--aula-border)] px-4 py-2 text-sm font-medium text-[var(--aula-text)] hover:bg-white/5"
              >
                <CheckCircle2 size={16} />
                Marcar como completada
              </button>
            )}

            {forumPending && (
              <button
                type="button"
                onClick={() => setActiveTab("foro")}
                className="inline-flex items-center gap-2 rounded-xl bg-[var(--aula-accent)] px-4 py-2 text-sm font-medium text-white"
              >
                <MessagesSquare size={16} />
                Participar en el foro
              </button>
            )}
          </div>

          {forumPending && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              Participa en el foro de esta clase para poder avanzar a la siguiente.
            </p>
          )}

          {contentHtml && cls.type !== "text" && (
            <section className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--aula-text-muted)]">
                Resumen
              </h2>
              <div className="aula-prose mt-4" dangerouslySetInnerHTML={{ __html: contentHtml }} />
            </section>
          )}
        </div>

        <div className="min-w-0 xl:sticky xl:top-24 xl:h-[calc(100vh-7rem)]">
          <ClassPanel cls={cls} activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      </main>

      <CurriculumPanel
        course={course}
        activeClassId={cls.id}
        open={curriculumOpen}
        onClose={() => setCurriculumOpen(false)}
      />
    </>
  );
}
