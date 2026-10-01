// Timezone-aware day bucketing helpers. Salesforce's SOQL DAY_ONLY() groups
// by the running/integration user's own timezone (not the browser's
// selected one), and a plain "T00:00:00Z" boundary is always UTC — neither
// lines up with whatever zone is picked in the dashboard's dropdown. These
// helpers let the trend endpoints bucket by calendar day in that zone
// instead, so a case's day bucket always matches the day its converted
// timestamp is displayed under.

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Offset (in minutes) such that localWallClock = utcInstant + offset.
function tzOffsetMinutes(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +hour, +parts.minute, +parts.second);
  return (asUtc - date.getTime()) / 60000;
}

// The UTC instant of local midnight for `dateStr` ("YYYY-MM-DD") in `timeZone`.
export function zonedMidnightUtc(dateStr, timeZone) {
  const naiveUtc = new Date(`${dateStr}T00:00:00Z`);
  const offsetMin = tzOffsetMinutes(naiveUtc, timeZone);
  return new Date(naiveUtc.getTime() - offsetMin * 60000);
}

// The "YYYY-MM-DD" calendar day `date` falls on when viewed in `timeZone`.
export function dayKeyInZone(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
