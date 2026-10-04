export type LogLevel = "info" | "warn" | "error";
export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue | undefined>>;
export type Logger = (level: LogLevel, event: string, fields?: LogFields) => void;
export type LogSink = (line: string, level: LogLevel) => void;

const SERVICE = "mingocell-api";
const RESERVED_FIELDS = new Set(["timestamp", "service", "level", "event"]);
const SENSITIVE_FIELD_PARTS = [
  "authorization",
  "body",
  "cookie",
  "csrf",
  "email",
  "filename",
  "image",
  "note",
  "password",
  "secret",
  "token",
];
const SAFE_ERROR_TYPES = new Set([
  "AggregateError",
  "Error",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

export function createLogger(
  sink: LogSink = writeLine,
  clock: () => Date = () => new Date(),
): Logger {
  return (level, event, fields = {}) => {
    sink(serializeLog(level, event, fields, clock()), level);
  };
}

export function serializeLog(level: LogLevel, event: string, fields: LogFields = {}, now = new Date()) {
  const entry: Record<string, LogValue> = {
    timestamp: now.toISOString(),
    service: SERVICE,
    level,
    event,
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || RESERVED_FIELDS.has(key) || isSensitiveField(key)) continue;
    entry[key] = value;
  }

  return JSON.stringify(entry);
}

export function safeErrorType(error: unknown) {
  if (!(error instanceof Error)) return "NonError";
  return SAFE_ERROR_TYPES.has(error.name) ? error.name : "Error";
}

function isSensitiveField(key: string) {
  const normalized = key.toLowerCase();
  return SENSITIVE_FIELD_PARTS.some((part) => normalized.includes(part));
}

function writeLine(line: string, level: LogLevel) {
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export const logger = createLogger();
