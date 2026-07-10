"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAulaData } from "../_lib/AulaDataContext";

export default function CourseEntryPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = use(params);
  const router = useRouter();
  const { curriculum, classes, isComplete } = useAulaData();

  const course = curriculum.find((entry) => entry.courseId === courseId);

  // Entra por la primera clase pendiente; si todo está completo, por la primera.
  useEffect(() => {
    if (!course) return;
    const items = course.lessons.flatMap((lesson) => lesson.items);
    if (items.length === 0) return;
    const target = items.find((item) => !isComplete(classes[item.index])) ?? items[0];
    router.replace(`/aula/${courseId}/${encodeURIComponent(target.id)}`);
  }, [course, classes, courseId, isComplete, router]);

  if (!course) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center px-4">
        <p className="text-[var(--aula-text-muted)]">No encontramos esta materia entre tus materias.</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-[60vh] items-center justify-center">
      <Loader2 size={26} className="animate-spin text-[var(--aula-text-muted)]" />
    </main>
  );
}
