/**
 * Structured logging: business events + references only.
 *
 * Never pass secrets, payment data, or admin-only cost/margin data as log
 * fields — that discipline is the primary control (see CLAUDE.md Security
 * and privacy). The key-name redaction below is a defense-in-depth backstop
 * for accidental inclusion, not a substitute for it.
 */
type LogFields = Record<string, unknown>;

const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN =
  /secret|password|token|hmac|signature|card|cvv|api[_-]?key|authorization|cost|margin/i;

/**
 * Recurses into both plain objects and arrays so a sensitive key nested
 * inside an array (e.g. `{ items: [{ apiKey: "secret" }] }`) is redacted
 * just like one nested inside a plain object — arrays are not a safe
 * hiding place for accidental sensitive fields (fixed 2026-09-14).
 */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === "object") {
    const out: LogFields = {};
    for (const [key, val] of Object.entries(value as LogFields)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(val);
    }
    return out;
  }
  return value;
}

function redact(fields: LogFields): LogFields {
  return redactValue(fields) as LogFields;
}

function write(level: "info" | "warn" | "error", event: string, fields: LogFields = {}) {
  const entry = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...redact(fields),
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export const logger = {
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
};
