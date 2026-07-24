"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "firebase/auth";
import toast from "react-hot-toast";
import {
  getStudentHomeRoute,
  saveStudentPlatformViewForUser,
  type StudentPlatformView,
} from "@/lib/student-platform-view";

type StudentViewSwitchProps = {
  currentView: StudentPlatformView;
  user: User | null;
  variant?: "modernTopbar" | "aulaRail";
};

export function StudentViewSwitch({
  currentView,
  user,
  variant = "modernTopbar",
}: StudentViewSwitchProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const modernActive = currentView === "modern";
  const nextView: StudentPlatformView = modernActive ? "traditional" : "modern";

  const handleToggle = async () => {
    if (!user || saving) return;

    setSaving(true);
    try {
      const savedView = await saveStudentPlatformViewForUser(user, nextView);
      toast.success(savedView === "modern" ? "Vista moderna activada" : "Vista tradicional activada");
      router.push(getStudentHomeRoute(savedView));
    } catch (error) {
      console.error("No se pudo cambiar la vista del alumno:", error);
      toast.error(error instanceof Error ? error.message : "No se pudo cambiar la vista");
    } finally {
      setSaving(false);
    }
  };

  if (variant === "aulaRail") {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={modernActive}
        aria-label={modernActive ? "Cambiar a vista tradicional" : "Cambiar a vista moderna"}
        title={modernActive ? "Vista moderna activa" : "Activar vista moderna"}
        onClick={handleToggle}
        disabled={!user || saving}
        className="mt-auto flex h-10 w-10 items-center justify-center rounded-lg text-[var(--aula-text-muted)] transition-colors hover:bg-white/5 hover:text-[var(--aula-text)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className={`relative h-5 w-9 rounded-full border transition-colors ${
            modernActive
              ? "border-[var(--aula-accent-soft)] bg-[var(--aula-accent)]"
              : "border-white/15 bg-white/10"
          }`}
        >
          <span
            className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform ${
              modernActive ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={modernActive}
      aria-label={modernActive ? "Cambiar a vista tradicional" : "Cambiar a vista moderna"}
      title={modernActive ? "Cambiar a vista tradicional" : "Cambiar a vista moderna"}
      onClick={handleToggle}
      disabled={!user || saving}
      className="inline-flex h-10 w-14 items-center justify-center rounded-full border border-white/15 bg-white/10 shadow-lg backdrop-blur transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={`relative h-5 w-10 rounded-full border transition-colors ${
          modernActive ? "border-emerald-300/40 bg-emerald-500" : "border-white/20 bg-white/10"
        }`}
      >
        <span
          className={`absolute left-0.5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform ${
            modernActive ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}
