"use client";

import { useAulaData } from "./_lib/AulaDataContext";
import { CourseCard } from "./_components/CourseCard";

export default function AulaHomePage() {
  const { curriculum, classes, courseCovers, isComplete, studentName } = useAulaData();

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8">
        <p className="text-sm text-[var(--aula-text-muted)]">
          {studentName ? `Hola, ${studentName}` : "Hola"}
        </p>
        <h1 className="mt-1 text-3xl font-semibold text-[var(--aula-text)]">Mis materias</h1>
      </header>

      {curriculum.length === 0 ? (
        <p className="text-[var(--aula-text-muted)]">Todavía no tienes materias disponibles.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-3">
          {curriculum.map((course) => {
            const items = course.lessons.flatMap((lesson) => lesson.items);
            const completedClasses = items.filter((item) => isComplete(classes[item.index])).length;

            return (
              <CourseCard
                key={course.courseId}
                courseId={course.courseId}
                courseTitle={course.courseTitle}
                coverUrl={courseCovers[course.courseId]}
                totalClasses={items.length}
                completedClasses={completedClasses}
              />
            );
          })}
        </div>
      )}
    </main>
  );
}
