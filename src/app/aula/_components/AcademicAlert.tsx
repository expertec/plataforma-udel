"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { getAcademicAlert } from "@/lib/students/academic-alert";
import { useAulaData } from "../_lib/AulaDataContext";

export function AcademicAlert() {
  const { courseClosures, courseTitles, examAssignments } = useAulaData();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const { notice, hasActiveExam } = getAcademicAlert(courseClosures, courseTitles, examAssignments, nowMs);

  if (!notice) return null;

  return (
    <div role="status" className="border-b border-yellow-600 bg-yellow-400 text-black shadow-lg">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-center gap-3 px-4">
        <TriangleAlert aria-hidden="true" className="h-5 w-5 shrink-0" />
        <p title={notice} className="m-0 min-w-0 overflow-x-auto whitespace-nowrap text-sm font-semibold">{notice}</p>
        {hasActiveExam ? (
          <Link href="/aula/examenes-globales" className="shrink-0 rounded-md bg-black px-3 py-1.5 text-sm font-bold text-yellow-300 transition hover:bg-neutral-800">
            Ver exámenes
          </Link>
        ) : null}
      </div>
    </div>
  );
}
