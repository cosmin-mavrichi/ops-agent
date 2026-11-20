/**
 * Replaces literals in live SQL text with `?` and drops comments.
 * pg_stat_activity shows queries verbatim, so literals can hold user data or secrets, and comments
 * are free text that could carry instructions aimed at the model. Unterminated strings and comments
 * (e.g. from truncated query text) are consumed to the end, so nothing after an open quote leaks.
 * Assumes standard_conforming_strings = on (the default since 9.1): backslashes only escape in E'…'.
 */
export function stripLiterals(sql: string): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql.charAt(i);
    const next = sql.charAt(i + 1);

    if (ch === "-" && next === "-") {
      i = skipLineComment(sql, i);
    } else if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i);
    } else if (ch === "'") {
      const escapes = isEscapeStringPrefix(sql, i);
      if (escapes) out = out.slice(0, -1);
      i = skipQuoted(sql, i, escapes);
      out += "?";
    } else if (ch === '"') {
      const end = skipQuoted(sql, i, false);
      out += sql.slice(i, end);
      i = end;
    } else if (ch === "$" && dollarTag(sql, i) !== undefined) {
      i = skipDollarQuoted(sql, i, dollarTag(sql, i) as string);
      out += "?";
    } else if (isDigit(ch) && !isIdentifierChar(sql.charAt(i - 1))) {
      i = skipNumber(sql, i);
      out += "?";
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function skipLineComment(sql: string, start: number): number {
  const end = sql.indexOf("\n", start);
  return end === -1 ? sql.length : end;
}

/** Postgres block comments nest. */
function skipBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql.startsWith("/*", i)) {
      depth++;
      i += 2;
    } else if (sql.startsWith("*/", i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return sql.length;
}

/** Skips '…' or "…" starting at the opening quote; a doubled quote is an escaped quote. */
function skipQuoted(sql: string, start: number, backslashEscapes: boolean): number {
  const quote = sql.charAt(start);
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (backslashEscapes && ch === "\\") {
      i += 2;
    } else if (ch === quote && sql.charAt(i + 1) === quote) {
      i += 2;
    } else if (ch === quote) {
      return i + 1;
    } else {
      i++;
    }
  }
  return sql.length;
}

/** E'…' strings allow backslash escapes. */
function isEscapeStringPrefix(sql: string, quoteAt: number): boolean {
  const prefix = sql.charAt(quoteAt - 1);
  return (prefix === "E" || prefix === "e") && !isIdentifierChar(sql.charAt(quoteAt - 2));
}

/** Returns the tag of a dollar quote opening at `start` ($$ or $tag$), or undefined for $1 params. */
function dollarTag(sql: string, start: number): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(start, start + 64));
  return match ? match[0] : undefined;
}

function skipDollarQuoted(sql: string, start: number, tag: string): number {
  const end = sql.indexOf(tag, start + tag.length);
  return end === -1 ? sql.length : end + tag.length;
}

function skipNumber(sql: string, start: number): number {
  let i = start;
  while (i < sql.length && (isDigit(sql.charAt(i)) || sql.charAt(i) === ".")) i++;
  return i;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}
