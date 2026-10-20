"use client";

type Props = {
  credits: string;
  cycle: string;
  onCreditsChange: (value: string) => void;
  onCycleChange: (value: string) => void;
  disabled?: boolean;
};

export function CourseAcademicFields({ credits, cycle, onCreditsChange, onCycleChange, disabled = false }: Props) {
  const inputClass = "mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50 disabled:opacity-70";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm font-medium text-slate-800">
        Créditos
        <input
          type="number"
          min={0}
          step="any"
          value={credits}
          onChange={(event) => onCreditsChange(event.target.value)}
          disabled={disabled}
          placeholder="Ej. 6.5"
          className={inputClass}
        />
      </label>
      <label className="text-sm font-medium text-slate-800">
        Ciclo
        <input
          type="text"
          maxLength={100}
          value={cycle}
          onChange={(event) => onCycleChange(event.target.value)}
          disabled={disabled}
          className={inputClass}
        />
      </label>
    </div>
  );
}
