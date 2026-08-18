const NS_PER_MS = 1_000_000n;
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const shanghaiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset"
});

export function formatNanoseconds(nanoseconds: bigint): string {
  if (nanoseconds < 0n) {
    throw new RangeError("Timestamp cannot be negative");
  }
  const milliseconds = nanoseconds / NS_PER_MS;
  const millisecondsNumber = Number(milliseconds);
  if (!Number.isSafeInteger(millisecondsNumber)) {
    throw new RangeError("Timestamp is outside the supported Date range");
  }
  const date = new Date(millisecondsNumber);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("Timestamp is outside the supported Date range");
  }
  const parts = Object.fromEntries(
    shanghaiFormatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  const fraction = String(millisecondsNumber % 1000).padStart(3, "0");
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : (parts.timeZoneName ?? "GMT+08:00").replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${fraction}${offset}`;
}

export function parseTimestampMilliseconds(text: string): number | undefined {
  const match = TIMESTAMP_PATTERN.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const components = match[1]!.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!components) {
    return undefined;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = components;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  if (match[3] !== "Z") {
    const [offsetHour, offsetMinute] = match[3]!.slice(1).split(":").map(Number);
    if (offsetHour! > 23 || offsetMinute! > 59) {
      return undefined;
    }
  }
  let fraction = match[2] ?? "000";
  fraction = fraction.slice(0, 3).padEnd(3, "0");
  const normalized = `${match[1]}.${fraction}${match[3]}`;
  const value = Date.parse(normalized);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

export function parseTimestampNanoseconds(text: string): bigint | undefined {
  const milliseconds = parseTimestampMilliseconds(text);
  return milliseconds === undefined ? undefined : BigInt(milliseconds) * NS_PER_MS;
}

export function clampMillisecondsBoundary(nanoseconds: bigint): bigint {
  return (nanoseconds / NS_PER_MS) * NS_PER_MS;
}
