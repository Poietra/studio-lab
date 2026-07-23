export type PythonSourceComment = Readonly<{
  column: number;
  text: string;
}>;

export type PythonSourceLine = Readonly<{
  bracketDepthAfter: number;
  bracketDepthBefore: number;
  code: string;
  comment: PythonSourceComment | null;
  continuesToNext: boolean;
  continuedFromPrevious: boolean;
  endsInString: boolean;
  hasSignificantToken: boolean;
  indentation: number;
  raw: string;
  startsInString: boolean;
}>;

export type PythonSourceAnalysis = Readonly<{
  lines: readonly PythonSourceLine[];
  valid: boolean;
}>;

type StringDelimiter = "\"" | "'" | "\"\"\"" | "'''";

const PYTHON_STRING_PREFIXES = new Set([
  "b",
  "br",
  "f",
  "fr",
  "r",
  "rb",
  "rf",
  "u",
]);

function indentationWidth(line: string) {
  let width = 0;
  for (const character of line) {
    if (character === " ") {
      width += 1;
      continue;
    }
    if (character === "\t") {
      width += 8 - (width % 8);
      continue;
    }
    if (character === "\f") {
      width = 0;
      continue;
    }
    break;
  }
  return width;
}

function isEscaped(line: string, index: number) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isSingleQuote(delimiter: StringDelimiter): delimiter is "\"" | "'" {
  return delimiter.length === 1;
}

function stringPrefixStart(line: string, quoteIndex: number) {
  for (const length of [2, 1]) {
    const start = quoteIndex - length;
    if (start < 0) continue;
    const prefix = line.slice(start, quoteIndex);
    if (!PYTHON_STRING_PREFIXES.has(prefix.toLowerCase())) continue;
    const preceding = line[start - 1];
    if (preceding === undefined || !/[A-Za-z0-9_]/.test(preceding)) return start;
  }
  return quoteIndex;
}

/**
 * A deliberately small, browser-safe Python lexical pass.
 *
 * This does not try to execute or fully parse user Python. It only separates
 * comments and structural code from string literals and bracket continuations,
 * which is enough for the conservative source importer to reject ambiguous
 * marker locations. Invalid or unfinished lexical structures fail closed.
 */
export function analyzePythonSource(source: string): PythonSourceAnalysis {
  const rawLines = source.split(/\r?\n/);
  const bracketStack: string[] = [];
  const lines: PythonSourceLine[] = [];
  let delimiter: StringDelimiter | null = null;
  let explicitContinuation = false;
  let valid = true;

  for (const raw of rawLines) {
    const code = Array<string>(raw.length).fill(" ");
    const bracketDepthBefore = bracketStack.length;
    const continuedFromPrevious = explicitContinuation;
    const startsInString = delimiter !== null;
    let comment: PythonSourceComment | null = null;
    let hasSignificantToken = false;
    let index = 0;

    while (index < raw.length) {
      if (delimiter) {
        hasSignificantToken = true;
        if (raw.startsWith(delimiter, index) && !isEscaped(raw, index)) {
          index += delimiter.length;
          delimiter = null;
          continue;
        }
        index += 1;
        continue;
      }

      const character = raw[index] ?? "";
      if (character === "#") {
        comment = { column: index, text: raw.slice(index) };
        break;
      }
      if (character === "\"" || character === "'") {
        const prefixStart = stringPrefixStart(raw, index);
        for (let cursor = prefixStart; cursor < index; cursor += 1) code[cursor] = " ";
        const triple = raw.slice(index, index + 3) === character.repeat(3);
        delimiter = triple ? character.repeat(3) as StringDelimiter : character;
        hasSignificantToken = true;
        index += delimiter.length;
        continue;
      }

      code[index] = character;
      if (!/\s/.test(character)) hasSignificantToken = true;
      if (character === "(" || character === "[" || character === "{") {
        bracketStack.push({ "(": ")", "[": "]", "{": "}" }[character] ?? "");
      } else if (character === ")" || character === "]" || character === "}") {
        if (bracketStack.at(-1) !== character) {
          valid = false;
        } else {
          bracketStack.pop();
        }
      }
      index += 1;
    }

    if (delimiter && isSingleQuote(delimiter)) {
      let trailingBackslashes = 0;
      for (let cursor = raw.length - 1; cursor >= 0 && raw[cursor] === "\\"; cursor -= 1) {
        trailingBackslashes += 1;
      }
      if (trailingBackslashes % 2 === 0) {
        valid = false;
        delimiter = null;
      }
    }

    const codeText = code.join("");
    explicitContinuation = delimiter === null
      && bracketStack.length === 0
      && /\\\s*$/.test(codeText);
    lines.push({
      bracketDepthAfter: bracketStack.length,
      bracketDepthBefore,
      code: codeText,
      comment,
      continuesToNext: explicitContinuation,
      continuedFromPrevious,
      endsInString: delimiter !== null,
      hasSignificantToken,
      indentation: indentationWidth(raw),
      raw,
      startsInString,
    });
  }

  if (delimiter || bracketStack.length > 0 || explicitContinuation) valid = false;
  return { lines, valid };
}

export function isPythonStatementStart(line: PythonSourceLine) {
  return line.bracketDepthBefore === 0
    && !line.continuedFromPrevious
    && !line.startsInString
    && line.hasSignificantToken;
}

export function isStandalonePythonComment(line: PythonSourceLine) {
  return line.comment !== null
    && line.bracketDepthBefore === 0
    && !line.continuedFromPrevious
    && !line.startsInString
    && !line.hasSignificantToken
    && line.code.trim().length === 0;
}
