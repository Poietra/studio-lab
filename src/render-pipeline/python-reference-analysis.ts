import {
  analyzePythonSource,
  isPythonStatementStart,
  type PythonSourceLine,
} from "./python-source-analysis";

type PythonStatement = Readonly<{
  code: string;
  raw: string;
}>;

export class PythonReferenceAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonReferenceAnalysisError";
  }
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function referencePattern(reference: string, global = false) {
  return new RegExp(
    `\\b${reference.split(".").map(escapePattern).join("\\s*\\.\\s*")}\\b`,
    global ? "g" : undefined,
  );
}

function staticGlobalsReference(
  statement: PythonStatement,
  references: ReadonlySet<string>,
) {
  const pattern = /\bglobals\s*\(\s*\)\s*\[\s*(?:(?:[fF][rR]?|[rR][fFbB]?|[bB][rR]?|[uU]))?(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g;
  for (const match of statement.raw.matchAll(pattern)) {
    if (match.index === undefined || statement.code.slice(match.index, match.index + 7) !== "globals") continue;
    if (references.has(match[2] ?? "")) return match[2] ?? null;
  }
  return null;
}

export function referencedPythonReference(
  line: Pick<PythonSourceLine, "code" | "raw">,
  references: ReadonlySet<string>,
) {
  for (const reference of references) {
    if (referencePattern(reference).test(line.code)) return reference;
  }
  return staticGlobalsReference(line, references);
}

const SAFE_REFERENCE_ARGUMENT_CALLS = new Set([
  "AnimationGroup",
  "ApplyMethod",
  "Arrow",
  "Circumscribe",
  "Create",
  "FadeIn",
  "FadeOut",
  "Flash",
  "GrowFromCenter",
  "Indicate",
  "LaggedStart",
  "Line",
  "MoveAlongPath",
  "ReplacementTransform",
  "Succession",
  "SurroundingRectangle",
  "Transform",
  "TransformMatchingShapes",
  "TransformMatchingTex",
  "Uncreate",
  "Unwrite",
  "Wiggle",
  "Write",
  "align_to",
  "arrange",
  "move_to",
  "next_to",
  "to_corner",
  "to_edge",
]);

const SAFE_REFERENCE_RECEIVER_CALLS = new Set([
  "align_to",
  "arrange",
  "copy",
  "get_bottom",
  "get_center",
  "get_corner",
  "get_critical_point",
  "get_end",
  "get_left",
  "get_right",
  "get_start",
  "get_top",
  "move_to",
  "next_to",
  "rotate",
  "scale",
  "set_height",
  "set_width",
  "shift",
  "stretch",
  "to_corner",
  "to_edge",
]);

const RETAINING_REFERENCE_CALLS = new Set([
  "Group",
  "VGroup",
  "__setitem__",
  "add",
  "append",
  "dict",
  "extend",
  "insert",
  "list",
  "nullcontext",
  "set",
  "setdefault",
  "tuple",
  "update",
]);

const PYTHON_GROUPING_KEYWORDS = new Set([
  "assert",
  "case",
  "elif",
  "for",
  "if",
  "match",
  "return",
  "while",
  "with",
]);

function referenceMatches(statement: PythonStatement, references: ReadonlySet<string>) {
  return [...references].flatMap((reference) => (
    [...statement.code.matchAll(referencePattern(reference, true))].map((match) => ({
      end: (match.index ?? 0) + match[0].length,
      reference,
      start: match.index ?? 0,
    }))
  ));
}

function callBeforeOpening(code: string, opening: number) {
  const prefix = code.slice(0, opening).trimEnd();
  return prefix.match(/([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)$/)?.[1]
    ?.replace(/\s/g, "") ?? null;
}

function enclosingCall(code: string, position: number) {
  const stack: Array<{ character: string; index: number }> = [];
  for (let index = 0; index < position; index += 1) {
    const character = code[index] ?? "";
    if (character === "(" || character === "[" || character === "{") {
      stack.push({ character, index });
    } else if (character === ")" || character === "]" || character === "}") {
      stack.pop();
    }
  }
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const opening = stack[index];
    if (opening?.character !== "(") continue;
    const call = callBeforeOpening(code, opening.index);
    if (call && !PYTHON_GROUPING_KEYWORDS.has(call)) return call;
  }
  return null;
}

function referenceRetention(
  statement: PythonStatement,
  references: ReadonlySet<string>,
) {
  let retains = staticGlobalsReference(statement, references) !== null;
  for (const match of referenceMatches(statement, references)) {
    const suffix = statement.code.slice(match.end);
    if (/^\s*\(/.test(suffix)) continue;
    if (/^\s*\.\s*animate\b/.test(suffix)) continue;
    const receiverCall = suffix.match(/^\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1];
    if (receiverCall && SAFE_REFERENCE_RECEIVER_CALLS.has(receiverCall)) continue;

    const call = enclosingCall(statement.code, match.start);
    if (!call) {
      retains = true;
      continue;
    }
    if (call === "self.add" || call === "self.play" || call === "self.remove") continue;
    const callName = call.split(".").at(-1) ?? call;
    if (SAFE_REFERENCE_ARGUMENT_CALLS.has(callName)) continue;
    if (RETAINING_REFERENCE_CALLS.has(callName)) {
      retains = true;
      continue;
    }
    throw new PythonReferenceAnalysisError(
      `Studio cannot prove whether ${call} retains source reference ${match.reference}.`,
    );
  }
  return retains;
}

function splitAtTopLevel(statement: PythonStatement, separator: string) {
  const parts: PythonStatement[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let index = 0; index < statement.code.length; index += 1) {
    const character = statement.code[index] ?? "";
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character === ")" || character === "]" || character === "}") stack.pop();
    else if (character === separator && stack.length === 0) {
      parts.push({ code: statement.code.slice(start, index), raw: statement.raw.slice(start, index) });
      start = index + 1;
    }
  }
  parts.push({ code: statement.code.slice(start), raw: statement.raw.slice(start) });
  return parts;
}

function logicalStatements(
  source: string,
  startLine: number,
  endLine: number,
) {
  const analysis = analyzePythonSource(source);
  if (!analysis.valid) {
    throw new PythonReferenceAnalysisError("Python source has an invalid or unfinished lexical structure.");
  }
  const statements: PythonStatement[] = [];
  let code = "";
  let raw = "";
  for (let index = startLine; index < endLine; index += 1) {
    const line = analysis.lines[index];
    if (!line) continue;
    code += `${code ? "\n" : ""}${line.code}`;
    raw += `${raw ? "\n" : ""}${line.raw}`;
    if (line.bracketDepthAfter > 0 || line.continuesToNext || line.endsInString) continue;
    statements.push(...splitAtTopLevel({ code, raw }, ";"));
    code = "";
    raw = "";
  }
  if (code.trim().length > 0) {
    throw new PythonReferenceAnalysisError("The source anchor splits an unfinished Python statement.");
  }
  return statements;
}

function definitionBindings(
  source: string,
  startLine: number,
  endLine: number,
) {
  const analysis = analyzePythonSource(source);
  if (!analysis.valid) {
    throw new PythonReferenceAnalysisError("Python source has an invalid or unfinished lexical structure.");
  }
  const definitions: Array<{ target: PythonStatement; value: PythonStatement }> = [];
  for (let index = startLine; index < endLine; index += 1) {
    const line = analysis.lines[index];
    if (!line || !isPythonStatementStart(line)) continue;
    const name = line.code.trimStart().match(
      /^(?:(?:async\s+)?def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
    )?.[1];
    if (!name) continue;

    let definitionStart = index;
    for (let cursor = index - 1; cursor >= startLine;) {
      const previous = analysis.lines[cursor];
      if (!previous || !isPythonStatementStart(previous)) {
        cursor -= 1;
        continue;
      }
      if (previous.indentation !== line.indentation || !previous.code.trimStart().startsWith("@")) break;
      definitionStart = cursor;
      cursor -= 1;
    }

    let definitionEnd = endLine;
    for (let cursor = index + 1; cursor < endLine; cursor += 1) {
      const candidate = analysis.lines[cursor];
      if (
        candidate
        && isPythonStatementStart(candidate)
        && candidate.indentation <= line.indentation
      ) {
        definitionEnd = cursor;
        break;
      }
    }
    definitions.push({
      target: { code: name, raw: name },
      value: {
        code: analysis.lines.slice(definitionStart, definitionEnd).map((entry) => entry.code).join("\n"),
        raw: analysis.lines.slice(definitionStart, definitionEnd).map((entry) => entry.raw).join("\n"),
      },
    });
  }
  return definitions;
}

function topLevelAssignmentIndexes(code: string) {
  const indexes: number[] = [];
  const stack: string[] = [];
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index] ?? "";
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character === ")" || character === "]" || character === "}") stack.pop();
    else if (
      character === "="
      && stack.length === 0
      && code[index + 1] !== "="
      && !/[=!<>:]/.test(code[index - 1] ?? "")
    ) indexes.push(index);
  }
  return indexes;
}

function outerPairCovers(code: string, opening: string, closing: string) {
  if (!code.startsWith(opening) || !code.endsWith(closing)) return false;
  let depth = 0;
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === opening) depth += 1;
    else if (code[index] === closing) depth -= 1;
    if (depth === 0 && index < code.length - 1) return false;
  }
  return depth === 0;
}

function targetReferences(target: PythonStatement): readonly string[] | null {
  let code = target.code.trim();
  let raw = target.raw.trim();
  code = code.replace(/(?:\/\/|<<|>>|[+\-*/%@&|^])\s*$/, "").trim();
  raw = raw.replace(/(?:\/\/|<<|>>|[+\-*/%@&|^])\s*$/, "").trim();
  const suite = code.match(/^(?:async\s+)?(?:if|elif|else|for|while|try|except|finally|with|match|case)\b[\s\S]*:\s*([\s\S]+)$/);
  if (suite) {
    const offset = code.lastIndexOf(suite[1] ?? "");
    code = suite[1]?.trim() ?? "";
    raw = raw.slice(offset).trim();
  }
  while (
    (outerPairCovers(code, "(", ")") || outerPairCovers(code, "[", "]"))
    && code.length >= 2
  ) {
    code = code.slice(1, -1).trim();
    raw = raw.slice(1, -1).trim();
  }
  const tupleParts = splitAtTopLevel({ code, raw }, ",").filter((part) => part.code.trim().length > 0);
  if (tupleParts.length > 1) {
    const nested = tupleParts.map(targetReferences);
    return nested.some((part) => part === null) ? null : nested.flatMap((part) => part ?? []);
  }
  const annotation = splitAtTopLevel({ code, raw }, ":");
  if (annotation.length > 1) {
    code = annotation[0]?.code.trim() ?? "";
    raw = annotation[0]?.raw.trim() ?? "";
  }
  code = code.replace(/^\*+\s*/, "");
  raw = raw.replace(/^\*+\s*/, "");
  const compact = code.replace(/\s/g, "");
  if (/^globals\(\)\[\]$/.test(compact)) {
    const key = raw.match(
      /^globals\s*\(\s*\)\s*\[\s*(?:(?:[fF][rR]?|[rR][fFbB]?|[bB][rR]?|[uU]))?(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]$/,
    )?.[2];
    return key ? ["globals", key] : ["globals"];
  }
  if (/^globals\(\)\[/.test(compact)) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(compact)) return [compact];
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(compact)) return [compact];
  const container = compact.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\[/)?.[1];
  if (container) return [container];
  return null;
}

function assignmentParts(statement: PythonStatement) {
  const indexes = topLevelAssignmentIndexes(statement.code);
  if (indexes.length === 0) return null;
  const targets: PythonStatement[] = [{
    code: statement.code.slice(0, indexes[0]),
    raw: statement.raw.slice(0, indexes[0]),
  }];
  let rhsStart = (indexes[0] ?? 0) + 1;
  for (let index = 1; index < indexes.length; index += 1) {
    const start = (indexes[index - 1] ?? 0) + 1;
    const end = indexes[index] ?? start;
    const candidate = { code: statement.code.slice(start, end), raw: statement.raw.slice(start, end) };
    if (targetReferences(candidate) === null) break;
    targets.push(candidate);
    rhsStart = end + 1;
  }
  return {
    rhs: { code: statement.code.slice(rhsStart), raw: statement.raw.slice(rhsStart) },
    targets,
  };
}

function addReferences(targets: readonly PythonStatement[], references: Set<string>) {
  let changed = false;
  for (const target of targets) {
    const additions = targetReferences(target);
    if (additions === null) {
      throw new PythonReferenceAnalysisError(
        "Studio cannot track an alias/container assignment target that may retain the removed object.",
      );
    }
    for (const addition of additions) {
      if (references.has(addition)) continue;
      references.add(addition);
      changed = true;
    }
  }
  return changed;
}

function statementSlice(statement: PythonStatement, code: string, start = 0): PythonStatement {
  const index = statement.code.indexOf(code, start);
  return {
    code,
    raw: index < 0 ? code : statement.raw.slice(index, index + code.length),
  };
}

function bindingParts(statement: PythonStatement) {
  const loop = statement.code.match(/^\s*(?:async\s+)?for\s+([\s\S]+?)\s+in\s+([\s\S]+?)\s*:/);
  if (loop?.[1] && loop[2]) {
    const target = statementSlice(statement, loop[1]);
    const value = statementSlice(statement, loop[2], statement.code.indexOf(loop[1]) + loop[1].length);
    return [{ targets: [target], value }];
  }
  const withStatement = statement.code.match(/^\s*(?:async\s+)?with\s+([\s\S]+?)\s*:/)?.[1];
  if (!withStatement) return [];
  const withItems = splitAtTopLevel(statementSlice(statement, withStatement), ",");
  return withItems.flatMap((item) => {
    const match = item.code.match(/^([\s\S]+)\s+as\s+([\s\S]+)$/);
    if (!match?.[1] || !match[2]) return [];
    return [{
      targets: [statementSlice(item, match[2], item.code.lastIndexOf(match[2]))],
      value: statementSlice(item, match[1]),
    }];
  });
}

function mutationTargets(statement: PythonStatement): readonly string[] | null | undefined {
  const match = statement.code.match(
    /^\s*([\s\S]+?)\s*\.\s*(?:add|append|extend|insert|setdefault|update|__setitem__)\s*\(/,
  );
  if (!match?.[1]) return undefined;
  return targetReferences(statementSlice(statement, match[1]));
}

/**
 * Builds a conservative syntactic closure for aliases and containers created
 * before a source anchor. Rebindings are intentionally retained: a false
 * positive is safer than allowing deleted source objects to be revived later.
 */
export function pythonReferenceClosure(
  source: string,
  startLine: number,
  endLine: number,
  initialReferences: ReadonlySet<string>,
) {
  const statements = logicalStatements(source, startLine, endLine);
  const definitions = definitionBindings(source, startLine, endLine);
  const references = new Set(initialReferences);
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of definitions) {
      if (referencedPythonReference(definition.value, references)) {
        changed = addReferences([definition.target], references) || changed;
      }
    }
    for (const statement of statements) {
      const assignment = assignmentParts(statement);
      if (assignment && referencedPythonReference(assignment.rhs, references)) {
        if (referenceRetention(assignment.rhs, references)) {
          changed = addReferences(assignment.targets, references) || changed;
        }
      }
      for (const binding of bindingParts(statement)) {
        if (
          referencedPythonReference(binding.value, references)
          && referenceRetention(binding.value, references)
        ) {
          changed = addReferences(binding.targets, references) || changed;
        }
      }
      if (referencedPythonReference(statement, references)) {
        const definition = statement.code.trimStart();
        if (!assignment && !/^(?:@|(?:(?:async\s+)?def|class)\b)/.test(definition)) {
          referenceRetention(statement, references);
        }
        const walrusTargets = [...statement.code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:=/g)]
          .map((match) => ({ code: match[1] ?? "", raw: match[1] ?? "" }));
        changed = addReferences(walrusTargets, references) || changed;
        const mutation = mutationTargets(statement);
        if (mutation === null) {
          throw new PythonReferenceAnalysisError(
            "Studio cannot track a container mutation target that may retain the removed object.",
          );
        }
        for (const receiver of mutation ?? []) {
          if (receiver === "self" || references.has(receiver)) continue;
          references.add(receiver);
          changed = true;
        }
      }
    }
  }
  return references;
}
