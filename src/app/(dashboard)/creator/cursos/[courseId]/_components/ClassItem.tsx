"use client";

import { ClassItem as ClassData } from "@/lib/firebase/courses-service";
import type { DragEventHandler } from "react";

type DragProps = {
  draggable?: boolean;
  isDragging?: boolean;
  isDragOver?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  onDragEnd?: DragEventHandler<HTMLDivElement>;
};

type ClassItemProps = {
  item: ClassData;
  onDelete: (id: string) => void;
  onEditClass?: (item: ClassData) => void;
  onOpenComments?: (item: ClassData) => void;
  dragProps?: DragProps;
};

const Icon = ({ path }: { path: string }) => (
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
    <path d={path} />
  </svg>
);

const iconMap: Record<ClassData["type"], string> = {
  video: "M15 10.5V7a1 1 0 00-1-1H5.5A1.5 1.5 0 004 7.5v9A1.5 1.5 0 005.5 18H14a1 1 0 001-1v-3l4 3V7.5l-4 3z",
  text: "M7 5h10M7 9h6M7 13h10M7 17h6",
  audio: "M9 17V7l7-2v10m0 0a2 2 0 11-4 0 2 2 0 114 0z",
  quiz: "M9 7l6 4-6 4V7z",
  image: "M4 7.5A1.5 1.5 0 015.5 6h13A1.5 1.5 0 0120 7.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 16.5v-9zm0 8l4-4 3 3 4-4 5 5",
};

export function ClassItem({
  item,
  onDelete,
  onEditClass,
  onOpenComments,
  dragProps,
}: ClassItemProps) {
  const dragStyles = [
    dragProps?.isDragging ? "opacity-70" : "",
    dragProps?.isDragOver ? "bg-slate-100" : "",
    dragProps?.draggable ? "cursor-grab" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`flex items-center justify-between rounded-md px-3 py-2 pl-8 text-sm text-slate-700 hover:bg-slate-50 ${dragStyles}`}
      draggable={dragProps?.draggable ?? false}
      onDragStart={dragProps?.onDragStart}
      onDragOver={dragProps?.onDragOver}
      onDrop={dragProps?.onDrop}
      onDragEnd={dragProps?.onDragEnd}
    >
      <div className="flex items-center gap-3">
        <Icon path={iconMap[item.type]} />
        <div>
          <div className="flex items-center gap-2">
            <p className="font-medium text-slate-900">{item.title}</p>
            {item.hasAssignment ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                Tarea
              </span>
            ) : null}
          </div>
          {item.duration ? (
            <p className="text-xs text-slate-500">{item.duration} min</p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <button
          type="button"
          onClick={() => onOpenComments?.(item)}
          className="rounded-md px-2 py-1 text-xs font-semibold text-blue-600 hover:bg-slate-100"
        >
          Comentarios
        </button>
        <button
          type="button"
          onClick={() => onEditClass?.(item)}
          className="rounded-md p-2 hover:bg-slate-100"
          aria-label="Editar clase"
        >
          <Icon path="M4 15.5V19h3.5l10-10-3.5-3.5-10 10zM14.5 6.5l3.5 3.5" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(item.id)}
          className="rounded-md p-2 hover:bg-slate-100"
          aria-label="Eliminar clase"
        >
          <Icon path="M6 6h12M9 6v12m6-12v12M5 6h14" />
        </button>
      </div>
    </div>
  );
}
