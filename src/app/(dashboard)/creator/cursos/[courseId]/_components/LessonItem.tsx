"use client";

import { ClassItem } from "./ClassItem";
import type { ClassItem as ClassData, Lesson } from "@/lib/firebase/courses-service";
import { useState } from "react";

type LessonItemProps = {
  lesson: Lesson;
  expanded: boolean;
  onToggle: (id: string) => void;
  classes: ClassData[];
  loadingClasses?: boolean;
  onAddClass: (lesson: Lesson) => void;
  onDeleteClass: (lessonId: string, classId: string) => void;
  onDeleteLesson: (lessonId: string) => void;
  onEditClass: (lesson: Lesson, classItem: ClassData) => void;
};

export function LessonItem({
  lesson,
  expanded,
  onToggle,
  classes,
  loadingClasses,
  onAddClass,
  onDeleteClass,
  onDeleteLesson,
  onEditClass,
}: LessonItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="rounded-lg border border-slate-200 border-l-4 border-l-blue-500 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => onToggle(lesson.id)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <span className="text-sm text-slate-700">
            {expanded ? "▼" : "▶"}
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Lección {lesson.lessonNumber}: {lesson.title}
            </p>
            {lesson.description ? (
              <p className="text-xs text-slate-500 line-clamp-2">
                {lesson.description}
              </p>
            ) : null}
          </div>
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
          >
            ⋮
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-7 z-10 w-40 rounded-lg border border-slate-200 bg-white shadow-lg">
              {[
                { key: "edit", label: "Editar información" },
                { key: "duplicate", label: "Duplicar curso" },
                { key: "stats", label: "Ver estadísticas" },
                { key: "archive", label: "Archivar" },
                { key: "delete", label: "Eliminar" },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
                  onClick={() => {
                    setMenuOpen(false);
                    if (item.key === "delete") {
                      onDeleteLesson(lesson.id);
                    }
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="mt-4 space-y-2">
          {loadingClasses ? (
            <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
              Cargando clases...
            </div>
          ) : classes.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
              Aún no hay clases en esta lección.
            </div>
          ) : (
            classes.map((cls) => (
              <ClassItem
                key={cls.id}
                item={cls}
                onDelete={(classId) => onDeleteClass(lesson.id, classId)}
                onEditClass={(classItem) => onEditClass(lesson, classItem)}
              />
            ))
          )}
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-blue-600 hover:border-blue-400"
            onClick={() => onAddClass(lesson)}
          >
            + Agregar Clase
          </button>
        </div>
      ) : null}
    </div>
  );
}
