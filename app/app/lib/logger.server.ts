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

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redact(value as LogFields);
    } else {
      out[key] = value;
    }
  }
  return out;
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
