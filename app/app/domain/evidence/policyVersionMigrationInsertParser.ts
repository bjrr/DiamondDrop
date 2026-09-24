/**
 * Extracts `INSERT INTO "policy_version" (...) VALUES (...)` statements from
 * a migration's raw SQL text — the parsing half of the migration-vs-registry
 * drift fence (`requiredPolicyVersionsMigrationFence.test.ts`). PURE: takes
 * SQL text as a string, no filesystem access, no database.
 *
 * WHY A REAL (IF NARROWLY SCOPED) TOKENIZER RATHER THAN A SIMPLE REGEX.
 * Migration `20260924020000_luxury_steals_policy_version`'s `text` value is
 * a Postgres extended string literal (`E'...'`) containing a literal `\n\n`
 * escape sequence and, for other policy texts, could plausibly contain a
 * comma, a parenthesis, or an embedded single quote (`''` or `\'`) — any of
 * which would break a naive "split on commas between the parens" regex. This
 * module walks the VALUES(...) list character by character, treating a
 * quoted literal (plain `'...'` or extended `E'...'`) as one indivisible
 * unit, so punctuation inside a literal is never mistaken for SQL structure.
 *
 * NOT A GENERAL SQL PARSER. It targets exactly the shape this codebase's
 * `policy_version`-provisioning migrations use: a single `INSERT INTO
 * "policy_version" (<column list>) VALUES (<value list>) ON CONFLICT ...`
 * statement (see the real migration for the reference shape). Columns are
 * matched BY NAME (read from the `INSERT INTO ... (...)` column list), not
 * by position, so a future migration that orders or omits columns
 * differently is still parsed correctly as long as `slug`, `version`,
 * `text` and `content_hash` are present by name.
 */

export interface ParsedPolicyVersionInsert {
  readonly slug: string;
  readonly version: number;
  readonly text: string;
  readonly contentHash: string;
}

/** Strips the SQL quoting/escaping from one VALUES(...) token that is a string literal (`'...'` or Postgres extended `E'...'`). Throws if the token is not a quoted literal — callers only call this on columns known to be string-typed. */
function unescapeSqlStringLiteral(rawToken: string): string {
  let s = rawToken.trim();
  const isExtended = s.startsWith("E'") || s.startsWith("e'");
  if (isExtended) s = s.slice(1);
  if (!s.startsWith("'") || !s.endsWith("'") || s.length < 2) {
    throw new Error(`expected a quoted SQL string literal, got: ${rawToken}`);
  }
  const inner = s.slice(1, -1);

  let out = "";
  let i = 0;
  while (i < inner.length) {
    if (isExtended && inner[i] === "\\" && i + 1 < inner.length) {
      // Bounds already checked above, so this index is always defined.
      const next: string = inner[i + 1]!;
      const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'" };
      out += escapes[next] ?? next;
      i += 2;
      continue;
    }
    if (inner[i] === "'" && inner[i + 1] === "'") {
      // Doubled single quote is how BOTH plain and extended Postgres string
      // literals escape an embedded quote.
      out += "'";
      i += 2;
      continue;
    }
    out += inner[i];
    i += 1;
  }
  return out;
}

/**
 * Scans a SQL value list starting right after its opening `(`, splitting on
 * top-level commas (depth tracked so a comma or parenthesis INSIDE a quoted
 * literal or a nested function call like `gen_random_uuid()` is never
 * mistaken for a delimiter or the list's closing paren). Returns the raw
 * (still-quoted) tokens and the index just past the list's closing `)`.
 */
function scanValuesList(sql: string, startIndex: number): { tokens: string[]; endIndex: number } {
  let i = startIndex;
  let depth = 1; // the '(' that startIndex is already past
  let current = "";
  const tokens: string[] = [];

  while (i < sql.length && depth > 0) {
    const ch = sql[i];

    if (ch === "'" || ((ch === "E" || ch === "e") && sql[i + 1] === "'")) {
      // Consume an entire quoted literal as one unit so nothing inside it
      // (comma, paren, backslash) is parsed as SQL structure.
      const literalStart = i;
      if (ch === "E" || ch === "e") i += 1;
      i += 1; // past the opening quote
      while (i < sql.length) {
        if (sql[i] === "\\" && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      current += sql.slice(literalStart, i);
      continue;
    }

    if (ch === "(") {
      depth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "," && depth === 1) {
      tokens.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }

  if (current.trim().length > 0) tokens.push(current.trim());
  return { tokens, endIndex: i };
}

/** Splits a parenthesised, comma-separated SQL identifier list (e.g. `("id", "slug", "version")`) into bare names, in order. */
function parseColumnList(columnListSql: string): string[] {
  return columnListSql
    .split(",")
    .map((c) => c.trim().replace(/^"|"$/g, ""))
    .filter((c) => c.length > 0);
}

const INSERT_STATEMENT_PATTERN = /INSERT INTO "policy_version"\s*\(([^)]*)\)\s*VALUES\s*\(/gi;

/**
 * Every `policy_version` INSERT this migration file's SQL contains, parsed
 * into `{ slug, version, text, contentHash }`. Zero-length for a migration
 * file that provisions no policy_version row — not an error, most migration
 * files fall in that category.
 */
export function extractPolicyVersionInserts(sql: string): ParsedPolicyVersionInsert[] {
  const results: ParsedPolicyVersionInsert[] = [];
  const pattern = new RegExp(INSERT_STATEMENT_PATTERN);
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(sql)) !== null) {
    const columns = parseColumnList(match[1] ?? "");
    const valuesStart = match.index + match[0].length;
    const { tokens, endIndex } = scanValuesList(sql, valuesStart);
    pattern.lastIndex = endIndex;

    if (tokens.length !== columns.length) {
      throw new Error(
        `policy_version INSERT has ${columns.length} column(s) but ${tokens.length} value(s) — ` +
          `cannot map values to columns by name. Columns: ${columns.join(", ")}`
      );
    }

    const byColumn = new Map(columns.map((name, idx) => [name, tokens[idx]!]));
    const slugToken = byColumn.get("slug");
    const versionToken = byColumn.get("version");
    const textToken = byColumn.get("text");
    const contentHashToken = byColumn.get("content_hash");

    if (!slugToken || !versionToken || !textToken || !contentHashToken) {
      throw new Error(
        `policy_version INSERT is missing one of the required columns (slug, version, text, content_hash) — ` +
          `found: ${columns.join(", ")}`
      );
    }

    results.push({
      slug: unescapeSqlStringLiteral(slugToken),
      version: Number(versionToken.trim()),
      text: unescapeSqlStringLiteral(textToken),
      contentHash: unescapeSqlStringLiteral(contentHashToken),
    });
  }

  return results;
}
