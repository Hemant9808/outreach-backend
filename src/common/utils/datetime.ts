export function skipWeekend(date: Date): Date {
  const next = new Date(date.getTime());
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

export function nextRecurrenceAt(from: Date, intervalDays: number): Date {
  const next = new Date(from.getTime());
  next.setDate(next.getDate() + intervalDays);
  return skipWeekend(next);
}

export function firstRunAt(
  sendMode: 'IMMEDIATE' | 'SCHEDULED' | 'RECURRING',
  scheduledAt: Date | null,
): Date {
  if (sendMode === 'IMMEDIATE') return skipWeekend(new Date());
  if (sendMode === 'RECURRING') return skipWeekend(scheduledAt ?? nextTenAm(new Date(), true));
  return scheduledAt ?? nextTenAm(new Date());
}

/** 10:00 today if that time has not passed, otherwise 10:00 tomorrow. */
export function nextTenAm(from = new Date(), weekdaysOnly = false): Date {
  const todayTen = new Date(from);
  todayTen.setHours(10, 0, 0, 0);
  const next = from.getTime() < todayTen.getTime() ? todayTen : new Date(todayTen.getTime() + 86_400_000);
  next.setHours(10, 0, 0, 0);
  if (weekdaysOnly) {
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1);
      next.setHours(10, 0, 0, 0);
    }
  }
  return next;
}
