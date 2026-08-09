const FIELD_LIMITS = [
  { name: "minute", minimum: 0, maximum: 59 },
  { name: "hour", minimum: 0, maximum: 23 },
  { name: "day of month", minimum: 1, maximum: 31 },
  { name: "month", minimum: 1, maximum: 12 },
  { name: "day of week", minimum: 0, maximum: 6 },
] as const;

interface CronField {
  any: boolean;
  values: ReadonlySet<number>;
}

function parseField(value: string, index: number): CronField {
  const limit = FIELD_LIMITS[index]!;
  if (value === "*") return { any: true, values: new Set() };
  const values = value.split(",").map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new Error(
        `Unsupported ${limit.name} cron field "${value}"; use * or comma-separated integers.`,
      );
    }
    const parsed = Number(part);
    if (parsed < limit.minimum || parsed > limit.maximum) {
      throw new Error(
        `${limit.name} cron value ${parsed} is outside ${limit.minimum}-${limit.maximum}.`,
      );
    }
    return parsed;
  });
  return { any: false, values: new Set(values) };
}

function dayMatches(dayOfMonth: CronField, dayOfWeek: CronField, date: Date): boolean {
  if (dayOfMonth.any && dayOfWeek.any) return true;
  const monthDayMatches = dayOfMonth.values.has(date.getUTCDate());
  const weekDayMatches = dayOfWeek.values.has(date.getUTCDay());
  if (dayOfMonth.any) return weekDayMatches;
  if (dayOfWeek.any) return monthDayMatches;
  // POSIX cron treats restricted day-of-month and day-of-week fields as OR.
  return monthDayMatches || weekDayMatches;
}

/**
 * Resolve the next UTC GitHub Actions-compatible occurrence for the bounded
 * five-field expressions stored in config/loops.yaml. Unsupported cron syntax
 * fails closed instead of producing a misleading review date.
 */
export function nextCronOccurrence(expression: string, after: Date): string {
  if (Number.isNaN(after.getTime())) throw new Error("Cannot schedule from an invalid date.");
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Unsupported cron expression "${expression}"; expected five fields.`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map(parseField) as [
    CronField,
    CronField,
    CronField,
    CronField,
    CronField,
  ];
  const candidate = new Date(after);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const maximum = candidate.getTime() + 366 * 2 * 24 * 60 * 60 * 1_000;

  while (candidate.getTime() <= maximum) {
    if (
      (month.any || month.values.has(candidate.getUTCMonth() + 1)) &&
      (hour.any || hour.values.has(candidate.getUTCHours())) &&
      (minute.any || minute.values.has(candidate.getUTCMinutes())) &&
      dayMatches(dayOfMonth, dayOfWeek, candidate)
    ) {
      return candidate.toISOString();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error(`Cron expression "${expression}" has no occurrence within two years.`);
}
