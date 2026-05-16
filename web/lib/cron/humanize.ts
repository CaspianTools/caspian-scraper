// Convert a cron expression to a short human-readable description.
// Designed for the constrained subset the platform accepts: fixed minute
// in the first field (≥1hr granularity). Falls back to the raw expression
// for patterns it doesn't recognise — so the user always sees something.

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTHS = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

function formatTime(hourStr: string, minute: number): string | null {
  if (/^\d{1,2}$/.test(hourStr)) {
    const hour = parseInt(hourStr, 10);
    if (hour >= 0 && hour <= 23) return `${pad(hour)}:${pad(minute)} UTC`;
  }
  return null;
}

export function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [m, h, dom, mo, dow] = parts;

  const minute = parseInt(m, 10);
  if (Number.isNaN(minute) || minute < 0 || minute > 59) return cron;

  // Pattern: minute hour * * *  →  Every day at HH:MM UTC
  if (dom === "*" && mo === "*" && dow === "*") {
    const t = formatTime(h, minute);
    if (t) return `Every day at ${t}.`;

    // Every N hours (e.g. */6)
    const stepMatch = h.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const n = parseInt(stepMatch[1], 10);
      return `Every ${n} hour${n === 1 ? "" : "s"}, on minute ${minute}.`;
    }
  }

  // Pattern: minute hour * * <day>  →  Every Monday at HH:MM
  if (dom === "*" && mo === "*" && /^\d$/.test(dow)) {
    const dayIdx = parseInt(dow, 10);
    if (dayIdx >= 0 && dayIdx <= 6) {
      const t = formatTime(h, minute);
      if (t) return `Every ${DAYS[dayIdx]} at ${t}.`;
    }
  }

  // Pattern: minute hour * * 1-5  →  Every weekday at HH:MM
  if (dom === "*" && mo === "*" && dow === "1-5") {
    const t = formatTime(h, minute);
    if (t) return `Every weekday at ${t}.`;
  }

  // Pattern: minute hour * * 0,6  →  Every weekend at HH:MM
  if (dom === "*" && mo === "*" && (dow === "0,6" || dow === "6,0")) {
    const t = formatTime(h, minute);
    if (t) return `Every Saturday and Sunday at ${t}.`;
  }

  // Pattern: minute hour <N> * *  →  Monthly on the Nth at HH:MM
  if (mo === "*" && dow === "*" && /^\d{1,2}$/.test(dom)) {
    const day = parseInt(dom, 10);
    if (day >= 1 && day <= 31) {
      const t = formatTime(h, minute);
      if (t) return `On the ${ordinal(day)} of every month at ${t}.`;
    }
  }

  // Pattern: minute hour <N> <month> *  →  On Month Nth at HH:MM
  if (
    dow === "*" &&
    /^\d{1,2}$/.test(dom) &&
    /^\d{1,2}$/.test(mo)
  ) {
    const day = parseInt(dom, 10);
    const month = parseInt(mo, 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const t = formatTime(h, minute);
      if (t) return `Every ${MONTHS[month]} ${ordinal(day)} at ${t}.`;
    }
  }

  return cron;
}
