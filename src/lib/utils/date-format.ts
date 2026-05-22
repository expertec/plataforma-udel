type DateInput = Date | string | number;

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const DATETIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function toValidDate(value: DateInput): Date | null {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function getUsableTimeZone(value?: string | null): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized });
    return normalized;
  } catch {
    return null;
  }
}

function getLocalDateTimeParts(date: Date): DateTimeParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  };
}

function getDateTimePartsInTimeZone(date: Date, timeZone: string): DateTimeParts | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(date);
    const lookup = new Map(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const year = lookup.get("year");
    const month = lookup.get("month");
    const day = lookup.get("day");
    const hour = lookup.get("hour");
    const minute = lookup.get("minute");
    const second = lookup.get("second");

    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day) ||
      !Number.isFinite(hour) ||
      !Number.isFinite(minute) ||
      !Number.isFinite(second)
    ) {
      return null;
    }

    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
    } as DateTimeParts;
  } catch {
    return null;
  }
}

function buildDateTimeLocalValue(parts: DateTimeParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number | null {
  const zonedParts = getDateTimePartsInTimeZone(date, timeZone);
  if (!zonedParts) return null;
  const zonedUtcMs = Date.UTC(
    zonedParts.year,
    zonedParts.month - 1,
    zonedParts.day,
    zonedParts.hour,
    zonedParts.minute,
    zonedParts.second,
  );
  const baseUtcMs = date.getTime() - date.getMilliseconds();
  return zonedUtcMs - baseUtcMs;
}

export function toDateTimeLocalInputValue(
  value: DateInput,
  options?: { timeZone?: string | null },
): string {
  const parsed = toValidDate(value);
  if (!parsed) return "";

  const normalizedTimeZone = getUsableTimeZone(options?.timeZone);
  if (normalizedTimeZone) {
    const zonedParts = getDateTimePartsInTimeZone(parsed, normalizedTimeZone);
    if (zonedParts) return buildDateTimeLocalValue(zonedParts);
  }

  return buildDateTimeLocalValue(getLocalDateTimeParts(parsed));
}

export function parseDateTimeLocalToIso(
  value: string,
  options?: { timeZone?: string | null },
): string | null {
  const normalized = value.trim();
  if (!normalized) return null;

  const match = DATETIME_LOCAL_RE.exec(normalized);
  if (!match) {
    const parsed = toValidDate(normalized);
    return parsed ? parsed.toISOString() : null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");

  const normalizedTimeZone = getUsableTimeZone(options?.timeZone);
  if (normalizedTimeZone) {
    const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const firstOffsetMs = getTimeZoneOffsetMs(new Date(naiveUtcMs), normalizedTimeZone);
    if (firstOffsetMs !== null) {
      let resolvedUtcMs = naiveUtcMs - firstOffsetMs;
      const adjustedOffsetMs = getTimeZoneOffsetMs(new Date(resolvedUtcMs), normalizedTimeZone);
      if (adjustedOffsetMs !== null && adjustedOffsetMs !== firstOffsetMs) {
        resolvedUtcMs = naiveUtcMs - adjustedOffsetMs;
      }
      return new Date(resolvedUtcMs).toISOString();
    }
  }

  const parsed = new Date(year, month - 1, day, hour, minute, second);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hour ||
    parsed.getMinutes() !== minute ||
    parsed.getSeconds() !== second
  ) {
    return null;
  }

  return parsed.toISOString();
}

export function formatEsMxDateTime(
  value: DateInput,
  options?: { timeZone?: string | null },
): string {
  const parsed = toValidDate(value);
  if (!parsed) return "";

  const normalizedTimeZone = getUsableTimeZone(options?.timeZone);

  try {
    return parsed.toLocaleString("es-MX", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(normalizedTimeZone ? { timeZone: normalizedTimeZone } : {}),
    });
  } catch {
    // Fallback for browsers that don't support dateStyle/timeStyle.
    return new Intl.DateTimeFormat("es-MX", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...(normalizedTimeZone ? { timeZone: normalizedTimeZone } : {}),
    }).format(parsed);
  }
}
