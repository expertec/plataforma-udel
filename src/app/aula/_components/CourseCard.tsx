"use client";

import Image from "next/image";
import Link from "next/link";
import { GraduationCap } from "lucide-react";

export function CourseCard({
  courseId,
  courseTitle,
  coverUrl,
  totalClasses,
  completedClasses,
}: {
  courseId: string;
  courseTitle: string;
  coverUrl?: string;
  totalClasses: number;
  completedClasses: number;
}) {
  const pct = totalClasses === 0 ? 0 : Math.round((completedClasses / totalClasses) * 100);

  return (
    <Link
      href={`/aula/${courseId}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] transition-colors hover:border-[var(--aula-accent)]"
    >
      <div className="relative aspect-video w-full bg-[var(--aula-bg)]">
        {coverUrl ? (
          <Image
            src={coverUrl}
            alt={courseTitle}
            fill
            unoptimized
            className="object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--aula-text-muted)]">
            <GraduationCap size={40} />
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <h2 className="line-clamp-2 font-semibold text-[var(--aula-text)]">{courseTitle}</h2>

        <div className="mt-auto space-y-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-[var(--aula-accent)]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-[var(--aula-text-muted)]">
            {completedClasses} de {totalClasses} clases · {pct}%
          </p>
        </div>
      </div>
    </Link>
  );
}
