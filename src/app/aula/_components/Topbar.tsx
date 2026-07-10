"use client";

import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { ChevronDown, SkipBack, SkipForward } from "lucide-react";
import { useAulaData } from "../_lib/AulaDataContext";
import { buildLockedMessage } from "../_lib/gating";
import type { FeedClass } from "../_lib/types";

export function Topbar({
  cls,
  positionInCourse,
  totalInCourse,
  onOpenCurriculum,
}: {
  cls: FeedClass;
  positionInCourse: number;
  totalInCourse: number;
  onOpenCurriculum: () => void;
}) {
  const router = useRouter();
  const { classes, indexOfClass, isLockedAt } = useAulaData();
  const currentIndex = indexOfClass(cls.id);

  const neighbourInCourse = (direction: -1 | 1) => {
    for (
      let i = currentIndex + direction;
      i >= 0 && i < classes.length;
      i += direction
    ) {
      if (classes[i].courseId === cls.courseId) return i;
    }
    return -1;
  };

  const go = (direction: -1 | 1) => {
    const targetIndex = neighbourInCourse(direction);
    if (targetIndex < 0) return;
    if (isLockedAt(targetIndex)) {
      toast.error(buildLockedMessage(classes[targetIndex]));
      return;
    }
    const target = classes[targetIndex];
    router.push(`/aula/${target.courseId}/${encodeURIComponent(target.id)}`);
  };

  const prevIndex = neighbourInCourse(-1);
  const nextIndex = neighbourInCourse(1);

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-[var(--aula-border)] bg-[var(--aula-surface)] px-4 py-3">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold text-[var(--aula-text)]">{cls.title}</h1>
        <p className="truncate text-xs text-[var(--aula-text-muted)]">{cls.courseTitle}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={prevIndex < 0}
          aria-label="Clase anterior"
          className="rounded-lg p-2 text-[var(--aula-text-muted)] hover:bg-white/5 disabled:opacity-30"
        >
          <SkipBack size={18} />
        </button>

        <button
          type="button"
          onClick={onOpenCurriculum}
          className="flex items-center gap-2 rounded-lg border border-[var(--aula-border)] px-3 py-2 text-sm text-[var(--aula-text)] hover:bg-white/5"
        >
          <span className="hidden sm:inline">Ver clases</span>
          <span className="font-semibold">
            {positionInCourse}/{totalInCourse}
          </span>
          <ChevronDown size={16} className="text-[var(--aula-text-muted)]" />
        </button>

        <button
          type="button"
          onClick={() => go(1)}
          disabled={nextIndex < 0}
          className="flex items-center gap-2 rounded-lg border border-[var(--aula-border)] px-3 py-2 text-sm text-[var(--aula-text)] hover:bg-white/5 disabled:opacity-30"
        >
          <span className="hidden sm:inline">Siguiente clase</span>
          <SkipForward size={18} />
        </button>
      </div>
    </header>
  );
}
