'use strict';

/**
 * Parse "HH:MM" or "H:MM" into { hour, minute }.
 * Returns null when invalid.
 */
function parseTimeOfDay(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Extract hour/minute from a standard 5-field daily cron expression.
 * Supports patterns like "0 0 * * *" (minute hour day month weekday).
 * Returns null when the expression is not a simple daily slot.
 */
function parseDailyCronExpression(cronExpr) {
  if (cronExpr == null || String(cronExpr).trim() === '') return null;
  const parts = String(cronExpr).trim().split(/\s+/);
  if (parts.length < 5) return null;

  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = parts;
  if (dayRaw !== '*' || monthRaw !== '*' || weekdayRaw !== '*') {
    return null;
  }

  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;

  return { hour, minute };
}

function formatScheduleLabel({ hour, minute }, timeZone) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${hh}:${mm} ${timeZone}`;
}

module.exports = {
  parseTimeOfDay,
  parseDailyCronExpression,
  formatScheduleLabel,
};
