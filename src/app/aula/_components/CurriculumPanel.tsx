"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import {
  Check,
  ChevronDown,
  FileText,
  Headphones,
  Image as ImageIcon,
  ListChecks,
  Lock,
  PlayCircle,
  Radio,
  X,
} from "lucide-react";
import { useAulaData } from "../_lib/AulaDataContext";
import { buildLockedMessage } from "../_lib/gating";
import type { CurriculumCourse } from "../_lib/types";

const typeIcon = (type: string) => {
  if (type === "quiz") return ListChecks;
  if (type === "text") return FileText;
  if (type === "audio") return Headphones;
  if (type === "image") return ImageIcon;
  if (type === "live") return Radio;
  return PlayCircle;
};

export function CurriculumPanel({
  course,
  activeClassId,
  open,
  onClose,
}: {
  course: CurriculumCourse;
  activeClassId: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { classes, isComplete, isLockedAt, indexOfClass } = useAulaData();
  // Solo guardamos los pliegues que el alumno cambió a mano; el resto se deriva.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const activeLessonId = course.lessons.find((lesson) =>
    lesson.items.some((item) => item.id === activeClassId),
  )?.lessonId;

  const isLessonCollapsed = (lessonId: string) =>
    toggled[lessonId] ?? lessonId !== activeLessonId;

  if (!open) return null;

  const handleSelect = (classId: string) => {
    const index = indexOfClass(classId);
    if (index < 0) return;
    if (isLockedAt(index)) {
      toast.error(buildLockedMessage(classes[index]));
      return;
    }
    onClose();
    router.push(`/aula/${course.courseId}/${encodeURIComponent(classId)}`);
  };

  return (
    <>
      <button
        type="button"
        aria-label="Cerrar temario"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/60"
      />
      <aside className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-md flex-col border-l border-[var(--aula-border)] bg-[var(--aula-surface)]">
        <header className="flex items-center justify-between border-b border-[var(--aula-border)] px-5 py-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--aula-text-muted)]">Temario</p>
            <h2 className="mt-0.5 line-clamp-1 font-semibold text-[var(--aula-text)]">
              {course.courseTitle}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-[var(--aula-text-muted)] hover:bg-white/5"
          >
            <X size={20} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-2 py-3">
          {course.lessons.map((lesson) => {
            const isCollapsed = isLessonCollapsed(lesson.lessonId);
            const doneCount = lesson.items.filter((item) => isComplete(classes[item.index])).length;

            return (
              <section key={lesson.lessonId} className="mb-1">
                <button
                  type="button"
                  onClick={() =>
                    setToggled((prev) => ({ ...prev, [lesson.lessonId]: !isCollapsed }))
                  }
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-white/5"
                >
                  <ChevronDown
                    size={16}
                    className={`shrink-0 text-[var(--aula-text-muted)] transition-transform ${
                      isCollapsed ? "-rotate-90" : ""
                    }`}
                  />
                  <span className="flex-1 text-sm font-medium text-[var(--aula-text)]">
                    {lesson.lessonTitle}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--aula-text-muted)]">
                    {doneCount}/{lesson.items.length}
                  </span>
                </button>

                {!isCollapsed && (
                  <ul className="mt-0.5 space-y-0.5 pl-4">
                    {lesson.items.map((item) => {
                      const cls = classes[item.index];
                      const locked = isLockedAt(item.index);
                      const done = isComplete(cls);
                      const active = item.id === activeClassId;
                      const Icon = typeIcon(item.type);

                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => handleSelect(item.id)}
                            className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                              active
                                ? "bg-[var(--aula-accent)]/15 text-[var(--aula-text)]"
                                : locked
                                  ? "text-[var(--aula-text-muted)] hover:bg-white/5"
                                  : "text-[var(--aula-text)] hover:bg-white/5"
                            }`}
                          >
                            <span className="mt-0.5 shrink-0">
                              {locked ? (
                                <Lock size={16} className="text-[var(--aula-text-muted)]" />
                              ) : done ? (
                                <Check size={16} className="text-emerald-400" />
                              ) : (
                                <Icon
                                  size={16}
                                  className={active ? "text-[var(--aula-accent-soft)]" : "text-[var(--aula-text-muted)]"}
                                />
                              )}
                            </span>
                            <span className="flex-1 text-sm leading-snug">{item.title}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </aside>
    </>
  );
}
