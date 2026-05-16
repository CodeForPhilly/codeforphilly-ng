/**
 * Minimal streaming mysqldump parser.
 *
 * Why a custom parser: laddr's dump is large (tens of MB+) and we want
 * lazy per-table iteration. The grammar we need to handle is narrow —
 * just `CREATE TABLE` (for column order) and `INSERT INTO ... VALUES (...)`.
 * Pulling in a full SQL parser (sql-parser, node-sql-parser) brings PEG.js
 * runtime overhead and grammar surface we don't need.
 *
 * Supports:
 *   - CREATE TABLE with backtick identifiers; column names captured in order
 *   - INSERT INTO `table` VALUES (...),(...); — single or multi-row
 *   - String literals with single quotes, escaped via `\'`, `\\`, `\n`, etc.
 *   - Backslash-N (`\N`) → null
 *   - NULL keyword → null
 *   - Numeric literals (int and float)
 *
 * Does NOT support:
 *   - INSERT with explicit column lists (laddr dumps don't use them)
 *   - REPLACE INTO, UPDATE, etc. (out of scope for a dump-reading importer)
 *   - Binary/hex literals (0x...; not present in laddr text columns)
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type SqlValue = string | number | null;

/** A row keyed by column name. */
export type Row = Record<string, SqlValue>;

/**
 * Iterate rows from one table in a mysqldump file.
 *
 * Yields rows lazily — the file is streamed line-by-line. Only the target
 * table's INSERT statements are parsed; everything else is skipped.
 *
 * The dump must include the `CREATE TABLE` for the requested table before
 * its INSERTs (standard mysqldump output), so we know the column order.
 */
export async function* streamRows(
  filePath: string,
  tableName: string,
): AsyncGenerator<Row, void, void> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let columns: string[] | null = null;
  let inCreate = false;
  let inInsertBuffer: string | null = null;

  for await (const line of rl) {
    if (!inCreate && !inInsertBuffer) {
      const createMatch = line.match(/^CREATE TABLE `([^`]+)`/);
      if (createMatch && createMatch[1] === tableName) {
        inCreate = true;
        columns = [];
        continue;
      }

      if (line.startsWith(`INSERT INTO \`${tableName}\``)) {
        if (columns === null) {
          throw new Error(
            `[mysqldump-parser] INSERT for table "${tableName}" before its CREATE TABLE`,
          );
        }
        // INSERT can span multiple lines; buffer until the trailing ;
        inInsertBuffer = line;
        if (line.trimEnd().endsWith(';')) {
          for (const row of parseInsertStatement(inInsertBuffer, columns)) yield row;
          inInsertBuffer = null;
        }
        continue;
      }
      continue;
    }

    if (inCreate) {
      const colMatch = line.match(/^\s*`([^`]+)`\s+/);
      if (colMatch && columns) {
        columns.push(colMatch[1]!);
        continue;
      }
      if (/^\s*(PRIMARY KEY|UNIQUE KEY|KEY|CONSTRAINT|FULLTEXT|FOREIGN KEY)/.test(line)) {
        continue;
      }
      if (line.startsWith(')')) {
        inCreate = false;
      }
      continue;
    }

    if (inInsertBuffer) {
      inInsertBuffer += '\n' + line;
      if (line.trimEnd().endsWith(';')) {
        if (!columns) {
          throw new Error(`[mysqldump-parser] no columns available for ${tableName}`);
        }
        for (const row of parseInsertStatement(inInsertBuffer, columns)) yield row;
        inInsertBuffer = null;
      }
    }
  }
}

/**
 * Parse one buffered `INSERT INTO ... VALUES (...),(...);` statement
 * into an array of rows. Public for unit testing.
 */
export function parseInsertStatement(
  statement: string,
  columns: readonly string[],
): Row[] {
  const valuesIdx = statement.indexOf('VALUES');
  if (valuesIdx === -1) return [];
  const tail = statement.slice(valuesIdx + 'VALUES'.length);

  const rows: Row[] = [];
  let i = 0;
  while (i < tail.length) {
    while (i < tail.length && /[\s,]/.test(tail[i]!)) i++;
    if (i >= tail.length || tail[i] === ';') break;
    if (tail[i] !== '(') {
      i++;
      continue;
    }
    const { values, end } = parseTuple(tail, i);
    if (values.length !== columns.length) {
      throw new Error(
        `[mysqldump-parser] column count mismatch: expected ${columns.length}, got ${values.length}`,
      );
    }
    const row: Row = {};
    for (let c = 0; c < columns.length; c++) {
      row[columns[c]!] = values[c]!;
    }
    rows.push(row);
    i = end;
  }
  return rows;
}

/**
 * Parse one parenthesized tuple starting at `tail[start]` (which must be '(').
 * Returns the parsed values and the index just past the closing ')'.
 */
function parseTuple(tail: string, start: number): { values: SqlValue[]; end: number } {
  if (tail[start] !== '(') {
    throw new Error(`[mysqldump-parser] expected '(' at ${start}`);
  }
  let i = start + 1;
  const values: SqlValue[] = [];

  while (i < tail.length) {
    while (i < tail.length && /\s/.test(tail[i]!)) i++;
    if (tail[i] === ')') {
      return { values, end: i + 1 };
    }
    if (tail[i] === ',') {
      i++;
      continue;
    }
    const { value, next } = parseValue(tail, i);
    values.push(value);
    i = next;
  }

  throw new Error('[mysqldump-parser] unterminated tuple');
}

function parseValue(tail: string, start: number): { value: SqlValue; next: number } {
  const c = tail[start];
  if (c === "'") return parseQuotedString(tail, start);
  // NULL literal or \N (MySQL's "tab-separated NULL" leaks into some dump variants)
  if ((c === 'N' || c === 'n') && /^null/i.test(tail.slice(start, start + 4))) {
    return { value: null, next: start + 4 };
  }
  if (c === '\\' && tail[start + 1] === 'N') {
    return { value: null, next: start + 2 };
  }
  return parseNumber(tail, start);
}

function parseQuotedString(tail: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let result = '';
  while (i < tail.length) {
    const ch = tail[i]!;
    if (ch === '\\') {
      const next = tail[i + 1];
      switch (next) {
        case 'n': result += '\n'; break;
        case 'r': result += '\r'; break;
        case 't': result += '\t'; break;
        case '0': result += '\0'; break;
        case 'b': result += '\b'; break;
        case 'Z': result += '\x1A'; break;
        case '\\': result += '\\'; break;
        case "'": result += "'"; break;
        case '"': result += '"'; break;
        default: result += next ?? ''; break;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      // MySQL also allows doubled-up '' inside single-quoted strings
      if (tail[i + 1] === "'") {
        result += "'";
        i += 2;
        continue;
      }
      return { value: result, next: i + 1 };
    }
    result += ch;
    i++;
  }
  throw new Error('[mysqldump-parser] unterminated string literal');
}

function parseNumber(tail: string, start: number): { value: number; next: number } {
  let i = start;
  while (i < tail.length && /[\d.\-+eE]/.test(tail[i]!)) i++;
  const raw = tail.slice(start, i);
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw new Error(`[mysqldump-parser] invalid numeric literal "${raw}" at ${start}`);
  }
  return { value: n, next: i };
}
