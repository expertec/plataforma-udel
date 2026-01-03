"use client";
"use client";

import Image from "next/image";
import { useMemo, useState } from "react";

type Student = {
  id: string;
  name: string;
  email: string;
  className: string;
  gender: "Female" | "Male";
  avatar: string;
  role: string;
};

// Inicialmente sin datos; se poblará con la información real.
const students: Student[] = [];

export default function CreatorPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return students.filter(
      (student) =>
        student.name.toLowerCase().includes(q) ||
        student.email.toLowerCase().includes(q) ||
        student.id.includes(query),
    );
  }, [query]);

  const selected = filtered.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="space-y-6 text-slate-900">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
            Students / classes
          </p>
          <h1 className="text-2xl font-semibold text-[#0e2b7a]">
            Gestión de alumnos
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-[#0e71c7] shadow-sm transition hover:border-[#0e71c7] hover:bg-[#f0f6ff]">
            Export CSV
          </button>
          <button className="rounded-lg bg-[#2e8dff] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#1f7ae6]">
            Add Student
          </button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.8fr_1fr] lg:h-[calc(100vh-160px)]">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg shadow-slate-200/80 lg:h-full lg:max-h-full">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="rounded-full bg-slate-100 px-3 py-1">Add filter</span>
            </div>
            <div className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 sm:w-96">
              <span>🔍</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search for a student by name or email"
                className="w-full bg-transparent outline-none"
              />
            </div>
          </div>
          <div className="overflow-auto lg:h-full">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Student ID</th>
                  <th className="px-4 py-3">Email address</th>
                  <th className="px-4 py-3">Class</th>
                  <th className="px-4 py-3">Gender</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr className="bg-white">
                    <td
                      className="px-4 py-8 text-center text-sm text-slate-500"
                      colSpan={5}
                    >
                      Aún no hay estudiantes cargados. Agrega datos cuando estén listos.
                    </td>
                  </tr>
                ) : (
                  filtered.map((student, idx) => {
                    const active = student.id === selected?.id;
                    return (
                      <tr
                        key={student.id}
                        onClick={() => setSelectedId(student.id)}
                        className={`cursor-pointer transition ${
                          active ? "bg-[#e8f3ff]" : idx % 2 === 0 ? "bg-white" : "bg-slate-50"
                        } hover:bg-[#e8f3ff]`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <Image
                              src={student.avatar}
                              alt={student.name}
                              width={32}
                              height={32}
                              className="h-8 w-8 rounded-full object-cover"
                            />
                            <span className="font-medium text-slate-800">
                              {student.name}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{student.id}</td>
                        <td className="px-4 py-3 text-slate-600">{student.email}</td>
                        <td className="px-4 py-3 text-slate-600">{student.className}</td>
                        <td className="px-4 py-3 text-slate-600">{student.gender}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-200/80 lg:h-full lg:overflow-auto">
          {selected ? (
            <>
              <div className="flex flex-col items-center gap-2 text-center">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                  {selected.id}
                </p>
                <Image
                  src={selected.avatar}
                  alt={selected.name}
                  width={112}
                  height={112}
                  className="h-28 w-28 rounded-full object-cover shadow-inner"
                />
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">
                    {selected.name}
                  </h3>
                  <p className="text-sm text-slate-500">{selected.role}</p>
                </div>
                <div className="flex gap-3">
                  {["📞", "✉️", "💬"].map((icon) => (
                    <span
                      key={icon}
                      className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-lg"
                    >
                      {icon}
                    </span>
                  ))}
                </div>
              </div>

              <div className="space-y-2 rounded-xl border border-slate-100 bg-slate-50 p-4 text-sm text-slate-700">
                <p className="font-semibold text-slate-900">About</p>
                <p className="text-slate-500">
                  Añade la biografía y datos relevantes del estudiante aquí.
                </p>
                <div className="flex items-center gap-6 pt-2 text-sm">
                  <div>
                    <p className="text-xs uppercase text-slate-500">Age</p>
                    <p className="font-semibold text-slate-900">—</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-slate-500">Gender</p>
                    <p className="font-semibold text-slate-900">
                      {selected.gender || "—"}
                    </p>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500">Selecciona un alumno.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
