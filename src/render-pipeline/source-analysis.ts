import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { parser as pythonParser } from "@lezer/python";

export const STUDIO_SOURCE_ANALYSIS_SCHEMA_V1 = "poietra.studio-source-analysis" as const;
export const STUDIO_SOURCE_ANALYSIS_VERSION_V1 = 1 as const;
export const STUDIO_CST_SOURCE_ANALYSIS_TOOL_V1 = "@lezer/python@1.1.19/studio-v1" as const;

// This provider never treats Lezer recovery nodes as source authority. The
// pinned grammar's known gaps (including bare `yield` and parenthesized
// multi-context `with`) therefore fail closed until its grammar supports them.
const strictPythonParser = pythonParser.configure({ strict: true });
type PythonNode = ReturnType<typeof strictPythonParser.parse>["topNode"];

export type SourceSpanV1 = Readonly<{
  endByte: number;
  endColumn: number;
  endLine: number;
  startByte: number;
  startColumn: number;
  startLine: number;
}>;

export type SourceInsertionBoundaryV1 = Readonly<{
  id: string;
  indentation: string;
  line: number;
  newline: "\n" | "\r\n";
  sourceHash: string;
  span: Readonly<{ endByte: number; startByte: number }>;
  statementId: string;
}>;

export type SourceOperationCapabilityV1 =
  | Readonly<{ status: "source-eligible" }>
  | Readonly<{
      reason: "ambiguous-binding" | "dynamic-control-flow" | "runtime-only" | "unsupported-binding-form";
      status: "unknown";
    }>;

export type SourceBindingFactV1 = Readonly<{
  ambiguous: boolean;
  capabilities: Readonly<{
    move: SourceOperationCapabilityV1;
    uniformResize: SourceOperationCapabilityV1;
  }>;
  constructorCall: Readonly<{ callId: string; path: readonly string[] }> | null;
  controlPath: readonly string[];
  id: string;
  kind: "assignment" | "class" | "function" | "parameter" | "update";
  name: string;
  ordinal: number | null;
  scopeId: string;
  shadowedBindingId: string | null;
  span: SourceSpanV1;
  statementId: string | null;
}>;

export type SourceCallFactV1 = Readonly<{
  id: string;
  path: readonly string[] | null;
  span: SourceSpanV1;
}>;

export type SourceStatementFactV1 = Readonly<{
  calls: readonly SourceCallFactV1[];
  deletionSpan: Readonly<{ endByte: number; startByte: number }> | null;
  id: string;
  indentation: string;
  insertionAfter: SourceInsertionBoundaryV1 | null;
  insertionBefore: SourceInsertionBoundaryV1 | null;
  kind: string;
  line: number;
  rawText: string;
  span: SourceSpanV1;
  text: string;
}>;

export type SourceScopeFactV1 = Readonly<{
  id: string;
  kind: "class" | "comprehension" | "function" | "lambda" | "module";
  name: string | null;
  parentId: string | null;
  span: SourceSpanV1;
}>;

export type StudioSourceAnalysisV1 = Readonly<{
  bindings: readonly SourceBindingFactV1[];
  id: string;
  identifierTokens: readonly Readonly<{ name: string; span: SourceSpanV1 }>[];
  scene: Readonly<{
    baseExpressions: readonly Readonly<{ span: SourceSpanV1; text: string }>[];
    bindingBlockers: readonly Readonly<{ kind: string; statementId: string | null }>[];
    classLine: number;
    classSpan: SourceSpanV1;
    construct: Readonly<{ scopeId: string; span: SourceSpanV1 }>;
    id: string;
    name: string;
    ordinal: number;
    statements: readonly SourceStatementFactV1[];
  }>;
  schema: typeof STUDIO_SOURCE_ANALYSIS_SCHEMA_V1;
  scopes: readonly SourceScopeFactV1[];
  sourceHash: string;
  sourcePath: string;
  toolVersion: typeof STUDIO_CST_SOURCE_ANALYSIS_TOOL_V1;
  version: typeof STUDIO_SOURCE_ANALYSIS_VERSION_V1;
}>;

export type StudioSourceAnalysisRequestV1 = Readonly<{
  expectedSourceHash: string;
  sceneName: string;
  sourcePath: string;
  sourceText: string;
}>;

export type StudioSourceAnalysisProviderV1 = Readonly<{
  analyze(request: StudioSourceAnalysisRequestV1): StudioSourceAnalysisV1;
  schema: typeof STUDIO_SOURCE_ANALYSIS_SCHEMA_V1;
  toolVersion: typeof STUDIO_CST_SOURCE_ANALYSIS_TOOL_V1;
  version: typeof STUDIO_SOURCE_ANALYSIS_VERSION_V1;
}>;

export class SourceAnalysisError extends Error {
  constructor(
    readonly code:
      | "ambiguous-construct"
      | "ambiguous-scene"
      | "malformed-evidence"
      | "scene-missing"
      | "stale-source"
      | "unsafe-boundary"
      | "unsupported-syntax",
    message: string,
  ) {
    super(message);
    this.name = "SourceAnalysisError";
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NESTED_SCOPE_NODES = new Set([
  "ArrayComprehensionExpression",
  "ClassDefinition",
  "ComprehensionExpression",
  "DictionaryComprehensionExpression",
  "FunctionDefinition",
  "LambdaExpression",
  "SetComprehensionExpression",
]);
const CONTROL_FLOW_NODES = new Set([
  "ForStatement",
  "IfStatement",
  "MatchStatement",
  "TryStatement",
  "WhileStatement",
  "WithStatement",
]);

function digest(...values: readonly string[]) {
  return createHash("sha256").update(values.join("\u0000"), "utf8").digest("hex");
}

function hashSource(source: string) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function children(node: PythonNode) {
  const result: PythonNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

function descendants(node: PythonNode, visit: (descendant: PythonNode) => void) {
  for (const child of children(node)) {
    visit(child);
    descendants(child, visit);
  }
}

function namedChild(node: PythonNode, name: string) {
  return children(node).find((child) => child.name === name) ?? null;
}

function definitionName(node: PythonNode) {
  return namedChild(node, "VariableName");
}

function definitionFromStatement(node: PythonNode, kind: "ClassDefinition" | "FunctionDefinition") {
  if (node.name === kind) return node;
  if (node.name !== "DecoratedStatement") return null;
  return children(node).find((child) => child.name === kind) ?? null;
}

function statementChildren(body: PythonNode) {
  return children(body).filter((child) => child.type.is("Statement"));
}

type SourceIndex = ReturnType<typeof createSourceIndex>;

function createSourceIndex(source: string) {
  const utf8Offsets = new Uint32Array(source.length + 1);
  const validBoundaries = new Uint8Array(source.length + 1);
  const lineStarts = [0];
  validBoundaries[0] = 1;
  let byteOffset = 0;
  for (let index = 0; index < source.length; ) {
    const first = source.charCodeAt(index);
    let units = 1;
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = source.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) {
        throw new SourceAnalysisError("unsupported-syntax", "Source contains an unpaired UTF-16 surrogate.");
      }
      units = 2;
      codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new SourceAnalysisError("unsupported-syntax", "Source contains an unpaired UTF-16 surrogate.");
    }
    utf8Offsets[index] = byteOffset;
    byteOffset += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    index += units;
    utf8Offsets[index] = byteOffset;
    validBoundaries[index] = 1;
    if (codePoint === 0x0a) lineStarts.push(index);
  }
  if (byteOffset > 0xffffffff) {
    throw new SourceAnalysisError("unsupported-syntax", "Source is too large for bounded UTF-8 spans.");
  }

  function lineIndexAt(offset: number) {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle;
    }
    return low;
  }

  function span(from: number, to: number): SourceSpanV1 {
    if (!validBoundaries[from] || !validBoundaries[to]) {
      throw new SourceAnalysisError("unsupported-syntax", "Parser span splits a UTF-16 surrogate pair.");
    }
    const startLineIndex = lineIndexAt(from);
    const endLineIndex = lineIndexAt(to);
    return {
      endByte: utf8Offsets[to]!,
      endColumn: utf8Offsets[to]! - utf8Offsets[lineStarts[endLineIndex]!]!,
      endLine: endLineIndex + 1,
      startByte: utf8Offsets[from]!,
      startColumn: utf8Offsets[from]! - utf8Offsets[lineStarts[startLineIndex]!]!,
      startLine: startLineIndex + 1,
    };
  }

  function lineStart(offset: number) {
    return lineStarts[lineIndexAt(offset)]!;
  }

  return { lineStart, source, span, utf8Offsets };
}

function normalizedNodeText(source: string, node: PythonNode) {
  return source
    .slice(node.from, node.to)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n+$/u, "");
}

function staticCallPath(node: PythonNode, source: string): readonly string[] | null {
  if (node.name === "VariableName") return [source.slice(node.from, node.to)];
  if (node.name !== "MemberExpression") return null;
  const parts = children(node);
  if (parts.some((part) => part.name === "subscript")) return null;
  const head = parts[0];
  const property = parts.findLast((part) => part.name === "PropertyName");
  if (!head || !property) return null;
  const prefix = staticCallPath(head, source);
  return prefix ? [...prefix, source.slice(property.from, property.to)] : null;
}

function callFact(node: PythonNode, source: string, index: SourceIndex, analysisId: string): SourceCallFactV1 {
  const callee = node.firstChild;
  const span = index.span(node.from, node.to);
  return {
    id: `source-call:${digest(analysisId, String(span.startByte), String(span.endByte))}`,
    path: callee ? staticCallPath(callee, source) : null,
    span,
  };
}

function baseConstructorCall(
  node: PythonNode,
  source: string,
  index: SourceIndex,
  analysisId: string,
): SourceCallFactV1 | null {
  if (node.name === "CallExpression") {
    const fact = callFact(node, source, index, analysisId);
    if (fact.path) return fact;
    const callee = node.firstChild;
    return callee ? baseConstructorCall(callee, source, index, analysisId) : null;
  }
  if (node.name === "MemberExpression") {
    const receiver = node.firstChild;
    return receiver ? baseConstructorCall(receiver, source, index, analysisId) : null;
  }
  if (node.name === "ParenthesizedExpression") {
    const expression = children(node).find((child) => child.type.is("Expression"));
    return expression ? baseConstructorCall(expression, source, index, analysisId) : null;
  }
  return null;
}

function unwrapParenthesizedExpression(node: PythonNode) {
  let current = node;
  while (current.name === "ParenthesizedExpression") {
    const expression = children(current).find((child) => child.type.is("Expression"));
    if (!expression) break;
    current = expression;
  }
  return current;
}

function physicalStatement(
  node: PythonNode,
  source: string,
  index: SourceIndex,
): Readonly<{
  endByte: number;
  indentation: string;
  newline: "\n" | "\r\n";
  rawText: string;
  startByte: number;
  startOffset: number;
}> | null {
  const startOffset = index.lineStart(node.from);
  const indentation = source.slice(startOffset, node.from);
  if (!/^[\t ]*$/.test(indentation)) return null;
  const newlineIndex = source.indexOf("\n", node.to);
  if (newlineIndex < 0) return null;
  const newline = source[newlineIndex - 1] === "\r" ? "\r\n" : "\n";
  const textEnd = newlineIndex - Number(newline === "\r\n");
  const endOffset = newlineIndex + 1;
  return {
    endByte: index.utf8Offsets[endOffset]!,
    indentation,
    newline,
    rawText: source.slice(startOffset, textEnd),
    startByte: index.utf8Offsets[startOffset]!,
    startOffset,
  };
}

function isDocstringStatement(node: PythonNode) {
  if (node.name !== "ExpressionStatement") return false;
  const expression = node.firstChild;
  return expression?.name === "String" || expression?.name === "ContinuedString";
}

function directStatementFact(
  node: PythonNode,
  position: number,
  source: string,
  sourceHash: string,
  index: SourceIndex,
  analysisId: string,
) {
  const span = index.span(node.from, node.to);
  const id = `source-statement:${digest(analysisId, String(span.startByte), String(span.endByte), node.name)}`;
  const physical = physicalStatement(node, source, index);
  const calls: SourceCallFactV1[] = [];
  if (node.name === "CallExpression") calls.push(callFact(node, source, index, analysisId));
  descendants(node, (descendant) => {
    if (descendant.name === "CallExpression") calls.push(callFact(descendant, source, index, analysisId));
  });
  const boundary = (placement: "after" | "before"): SourceInsertionBoundaryV1 | null => {
    if (!physical || (placement === "before" && position === 0 && isDocstringStatement(node))) return null;
    const offset = placement === "after" ? physical.endByte : physical.startByte;
    const newline =
      placement === "after"
        ? physical.newline
        : source[physical.startOffset - 2] === "\r" && source[physical.startOffset - 1] === "\n"
          ? "\r\n"
          : "\n";
    return {
      id: `source-boundary:${digest(id, sourceHash, placement, String(offset), newline)}`,
      indentation: physical.indentation,
      line: placement === "after" ? span.endLine : span.startLine,
      newline,
      sourceHash,
      span: { endByte: offset, startByte: offset },
      statementId: id,
    };
  };
  return {
    calls: calls.sort(
      (left, right) => left.span.startByte - right.span.startByte || left.span.endByte - right.span.endByte,
    ),
    deletionSpan: physical ? { endByte: physical.endByte, startByte: physical.startByte } : null,
    id,
    indentation: physical?.indentation ?? "",
    insertionAfter: boundary("after"),
    insertionBefore: boundary("before"),
    kind: node.name,
    line: span.startLine,
    rawText: physical?.rawText ?? source.slice(node.from, node.to),
    span,
    text: normalizedNodeText(source, node),
  } satisfies SourceStatementFactV1;
}

function moduleClassDefinitions(root: PythonNode) {
  const definitions: Array<Readonly<{ controlPath: readonly string[]; node: PythonNode }>> = [];
  const walk = (node: PythonNode, controlPath: readonly string[]) => {
    const classNode = definitionFromStatement(node, "ClassDefinition");
    if (classNode) {
      definitions.push({ controlPath, node: classNode });
      return;
    }
    if (node.name === "FunctionDefinition") return;
    const nextPath = CONTROL_FLOW_NODES.has(node.name) ? [...controlPath, node.name] : controlPath;
    for (const child of children(node)) walk(child, nextPath);
  };
  for (const statement of statementChildren(root)) walk(statement, []);
  return definitions;
}

function parameterNames(node: PythonNode) {
  const parameters = namedChild(node, "ParamList");
  if (!parameters) return [];
  const names: PythonNode[] = [];
  let expectsName = true;
  for (const child of children(parameters)) {
    if (child.name === "(" || child.name === "," || child.name === "*" || child.name === "**") {
      expectsName = true;
      continue;
    }
    if (expectsName && child.name === "VariableName") {
      names.push(child);
      expectsName = false;
    }
  }
  return names;
}

/**
 * Decorators, parameter defaults and annotations, return annotations, and class
 * bases and keywords are evaluated in the scope that *contains* the definition,
 * not inside the scope the definition introduces. A walrus in one of them
 * therefore rebinds an enclosing-scope name and must be inspected before the
 * nested body is handed to its own scope.
 */
function enclosingEvaluatedDefinitionNodes(statement: PythonNode, definition: PythonNode) {
  const decorators =
    statement.name === "DecoratedStatement" ? children(statement).filter((child) => child.name === "Decorator") : [];
  const signature = children(definition).filter(
    (child) => child.name === "ArgList" || child.name === "ParamList" || child.name === "TypeDef",
  );
  return [...decorators, ...signature];
}

type MutableBinding = Omit<SourceBindingFactV1, "ambiguous" | "capabilities" | "shadowedBindingId"> & {
  constructorCall: SourceBindingFactV1["constructorCall"];
};

function analyze(request: StudioSourceAnalysisRequestV1): StudioSourceAnalysisV1 {
  const sourceHash = hashSource(request.sourceText);
  if (!SHA256_PATTERN.test(request.expectedSourceHash) || request.expectedSourceHash !== sourceHash) {
    throw new SourceAnalysisError("stale-source", "Source analysis requires the exact current source hash.");
  }
  if (/\r(?!\n)/u.test(request.sourceText)) {
    throw new SourceAnalysisError("unsupported-syntax", "SourceAnalysis does not accept CR-only line endings.");
  }
  const index = createSourceIndex(request.sourceText);
  let root: PythonNode;
  try {
    root = strictPythonParser.parse(request.sourceText).topNode;
  } catch (cause) {
    throw new SourceAnalysisError(
      "unsupported-syntax",
      `Strict CST parsing rejected the current Python source${cause instanceof Error ? `: ${cause.message}` : "."}`,
    );
  }
  const classes = moduleClassDefinitions(root);
  const matching = classes.filter(({ node }) => {
    const name = definitionName(node);
    return name ? request.sourceText.slice(name.from, name.to) === request.sceneName : false;
  });
  if (matching.length === 0) {
    throw new SourceAnalysisError("scene-missing", `Scene ${request.sceneName} is unavailable in the current source.`);
  }
  if (matching.length !== 1) {
    throw new SourceAnalysisError(
      "ambiguous-scene",
      `Scene ${request.sceneName} has ${matching.length} source occurrences.`,
    );
  }
  const selected = matching[0]!;
  if (selected.controlPath.length > 0) {
    throw new SourceAnalysisError(
      "scene-missing",
      "The selected Scene is defined under unsupported module control flow.",
    );
  }
  const classBody = namedChild(selected.node, "Body");
  if (!classBody) throw new SourceAnalysisError("scene-missing", "The selected Scene has no class body.");
  const constructs = statementChildren(classBody)
    .map((statement) => definitionFromStatement(statement, "FunctionDefinition"))
    .filter((definition): definition is PythonNode => {
      const name = definition && definitionName(definition);
      return Boolean(name && request.sourceText.slice(name.from, name.to) === "construct");
    });
  if (constructs.length !== 1) {
    throw new SourceAnalysisError(
      "ambiguous-construct",
      `Scene ${request.sceneName} requires one construct definition; found ${constructs.length}.`,
    );
  }
  const construct = constructs[0]!;
  const constructBody = namedChild(construct, "Body");
  if (!constructBody) throw new SourceAnalysisError("scene-missing", "The selected construct has no body.");

  const analysisId = `source-analysis:${digest(
    STUDIO_SOURCE_ANALYSIS_SCHEMA_V1,
    String(STUDIO_SOURCE_ANALYSIS_VERSION_V1),
    STUDIO_CST_SOURCE_ANALYSIS_TOOL_V1,
    request.sourcePath,
    sourceHash,
  )}`;
  const classSpan = index.span(selected.node.from, selected.node.to);
  const occurrenceOrdinal = classes.indexOf(selected) + 1;
  const sceneId = `source-scene:${digest(
    analysisId,
    request.sceneName,
    String(occurrenceOrdinal),
    String(classSpan.startByte),
    String(classSpan.endByte),
  )}`;
  const directNodes = statementChildren(constructBody);
  const statements = directNodes.map((node, position) =>
    directStatementFact(node, position, request.sourceText, sourceHash, index, analysisId),
  );
  const statementByNode = new Map(directNodes.map((node, position) => [node, statements[position]!] as const));

  const scopes: SourceScopeFactV1[] = [];
  const mutableBindings: MutableBinding[] = [];
  const blockers: Array<Readonly<{ kind: string; statementId: string | null }>> = [];
  const blockerKeys = new Set<string>();
  const blockedBindingNames = new Set<string>();
  let blocksEveryBinding = false;
  const moduleScope = addScope("module", null, null, root);
  const classScope = addScope("class", request.sceneName, moduleScope.id, selected.node);
  const constructScope = addScope("function", "construct", classScope.id, construct);
  let runtimeOrdinal = 0;

  function addScope(kind: SourceScopeFactV1["kind"], name: string | null, parentId: string | null, node: PythonNode) {
    const span = index.span(node.from, node.to);
    const scope = {
      id: `source-scope:${digest(analysisId, kind, name ?? "", String(span.startByte), String(span.endByte))}`,
      kind,
      name,
      parentId,
      span,
    } satisfies SourceScopeFactV1;
    scopes.push(scope);
    return scope;
  }

  function addBinding(
    nameNode: PythonNode,
    scope: SourceScopeFactV1,
    kind: MutableBinding["kind"],
    controlPath: readonly string[],
    statementId: string | null,
    ordinal: number | null,
    constructor: SourceCallFactV1 | null = null,
  ) {
    const span = index.span(nameNode.from, nameNode.to);
    const name = request.sourceText.slice(nameNode.from, nameNode.to);
    mutableBindings.push({
      constructorCall: constructor?.path ? { callId: constructor.id, path: constructor.path } : null,
      controlPath,
      id: `source-binding-occurrence:${digest(
        analysisId,
        scope.id,
        name,
        String(span.startByte),
        String(span.endByte),
      )}`,
      kind,
      name,
      ordinal,
      scopeId: scope.id,
      span,
      statementId,
    });
  }

  for (const parameter of parameterNames(construct)) {
    addBinding(parameter, constructScope, "parameter", [], null, null);
  }

  function addBlocker(kind: string, statementId: string | null, affectedNodes?: readonly PythonNode[]) {
    const blockerKey = `${kind}\u0000${statementId ?? ""}`;
    if (!blockerKeys.has(blockerKey)) {
      blockerKeys.add(blockerKey);
      blockers.push({ kind, statementId });
    }
    if (!affectedNodes) {
      blocksEveryBinding = true;
      return;
    }
    for (const node of affectedNodes) {
      if (node.name === "VariableName") blockedBindingNames.add(request.sourceText.slice(node.from, node.to));
      descendants(node, (descendant) => {
        if (descendant.name === "VariableName") {
          blockedBindingNames.add(request.sourceText.slice(descendant.from, descendant.to));
        }
      });
    }
  }

  function targetsFollowingAs(node: PythonNode) {
    const parts = children(node);
    return parts.flatMap((part, index) => (part.name === "as" && parts[index + 1] ? [parts[index + 1]!] : []));
  }

  function namedDescendants(node: PythonNode, name: string) {
    const matches: PythonNode[] = [];
    if (node.name === name) matches.push(node);
    descendants(node, (descendant) => {
      if (descendant.name === name) matches.push(descendant);
    });
    return matches;
  }

  function walrusTargets(node: PythonNode) {
    const targets: PythonNode[] = [];
    const collect = (candidate: PythonNode) => {
      if (candidate.name === "NamedExpression") {
        if (candidate.firstChild) targets.push(candidate.firstChild);
        return;
      }
      // The pinned grammar flattens an argument-position `name := value` into
      // sibling tokens instead of a NamedExpression, so decorator, base, and
      // call arguments are matched on the `:=` operator itself.
      if (candidate.name !== "ArgList") return;
      const parts = children(candidate);
      for (const [position, part] of parts.entries()) {
        const target = parts[position - 1];
        if (
          part.name === "AssignOp" &&
          request.sourceText.slice(part.from, part.to) === ":=" &&
          target?.name === "VariableName"
        ) {
          targets.push(target);
        }
      }
    };
    collect(node);
    descendants(node, collect);
    return targets;
  }

  function inspectNode(
    node: PythonNode,
    scope: SourceScopeFactV1,
    controlPath: readonly string[],
    ownerStatementId: string | null,
    runtimeScope: boolean,
  ): void {
    const functionDefinition = definitionFromStatement(node, "FunctionDefinition");
    if (functionDefinition && functionDefinition !== construct) {
      const name = definitionName(functionDefinition);
      if (name) addBinding(name, scope, "function", controlPath, ownerStatementId, null);
      if (runtimeScope) addBlocker("function-definition-binding", ownerStatementId, name ? [name] : undefined);
      for (const evaluated of enclosingEvaluatedDefinitionNodes(node, functionDefinition)) {
        inspectNode(evaluated, scope, controlPath, ownerStatementId, runtimeScope);
      }
      const nestedName = name ? request.sourceText.slice(name.from, name.to) : null;
      const nestedScope = addScope("function", nestedName, scope.id, functionDefinition);
      for (const parameter of parameterNames(functionDefinition)) {
        addBinding(parameter, nestedScope, "parameter", [], ownerStatementId, null);
      }
      const body = namedChild(functionDefinition, "Body");
      if (body)
        for (const statement of statementChildren(body))
          inspectNode(statement, nestedScope, [], ownerStatementId, false);
      return;
    }
    const classDefinition = definitionFromStatement(node, "ClassDefinition");
    if (classDefinition && classDefinition !== selected.node) {
      const name = definitionName(classDefinition);
      if (name) addBinding(name, scope, "class", controlPath, ownerStatementId, null);
      if (runtimeScope) addBlocker("class-definition-binding", ownerStatementId, name ? [name] : undefined);
      for (const evaluated of enclosingEvaluatedDefinitionNodes(node, classDefinition)) {
        inspectNode(evaluated, scope, controlPath, ownerStatementId, runtimeScope);
      }
      const nestedName = name ? request.sourceText.slice(name.from, name.to) : null;
      addScope("class", nestedName, scope.id, classDefinition);
      return;
    }
    if (
      node.name === "LambdaExpression" ||
      node.name === "ComprehensionExpression" ||
      node.name === "ArrayComprehensionExpression" ||
      node.name === "DictionaryComprehensionExpression" ||
      node.name === "SetComprehensionExpression"
    ) {
      const kind = node.name === "LambdaExpression" ? "lambda" : "comprehension";
      const nestedScope = addScope(kind, null, scope.id, node);
      if (node.name === "LambdaExpression") {
        for (const parameter of parameterNames(node)) {
          addBinding(parameter, nestedScope, "parameter", [], ownerStatementId, null);
        }
      }
      return;
    }

    if (node.name === "AssignStatement") {
      const parts = children(node);
      const assignmentIndexes = parts.flatMap((part, position) => (part.name === "AssignOp" ? [position] : []));
      const firstAssignment = assignmentIndexes[0] ?? -1;
      const target = parts[0];
      const typeDefinition = parts.some((part) => part.name === "TypeDef");
      const simple =
        assignmentIndexes.length === 1 && firstAssignment === 1 && target?.name === "VariableName" && !typeDefinition;
      if (!simple) {
        const lastAssignment = assignmentIndexes.at(-1) ?? 0;
        addBlocker(
          typeDefinition
            ? "annotated-assignment"
            : target?.name === "MemberExpression"
              ? "attribute-assignment"
              : "unsupported-assignment-target",
          ownerStatementId,
          parts.slice(0, lastAssignment),
        );
      }
      if (simple && target) {
        if (runtimeScope) runtimeOrdinal += 1;
        const value = parts[firstAssignment + 1];
        const directValue = value ? unwrapParenthesizedExpression(value) : null;
        if (runtimeScope && directValue?.name === "VariableName") {
          // Runtime Trace V3 deliberately rejects both sides of a direct
          // alias: either source token could otherwise name the same root at
          // different points in construct execution.
          addBlocker("direct-alias-binding", ownerStatementId, [target, directValue]);
        }
        const constructor = value ? baseConstructorCall(value, request.sourceText, index, analysisId) : null;
        addBinding(
          target,
          scope,
          "assignment",
          controlPath,
          ownerStatementId,
          runtimeScope ? runtimeOrdinal : null,
          constructor,
        );
      }
    } else if (node.name === "UpdateStatement") {
      const target = node.firstChild;
      addBlocker("update-assignment", ownerStatementId, target ? [target] : undefined);
      if (target?.name === "VariableName") {
        if (runtimeScope) runtimeOrdinal += 1;
        addBinding(target, scope, "update", controlPath, ownerStatementId, runtimeScope ? runtimeOrdinal : null);
      }
    } else if (node.name === "DeleteStatement") {
      addBlocker("delete-binding", ownerStatementId, [node]);
    } else if (node.name === "ImportStatement") {
      addBlocker("import-binding", ownerStatementId, [node]);
    } else if (node.name === "ScopeStatement") {
      addBlocker("scope-declaration-binding", ownerStatementId, [node]);
    } else if (node.name === "TypeDefinition") {
      const alias = children(node).find((child) => child.name === "VariableName");
      addBlocker("type-alias-binding", ownerStatementId, alias ? [alias] : undefined);
    } else if (node.name === "MatchStatement") {
      const patternTargets = [
        ...namedDescendants(node, "CapturePattern"),
        ...namedDescendants(node, "AsPattern").flatMap(targetsFollowingAs),
      ];
      addBlocker("pattern-binding", ownerStatementId, patternTargets);
    }

    const nextControlPath = CONTROL_FLOW_NODES.has(node.name) ? [...controlPath, node.name] : controlPath;
    if (
      runtimeScope &&
      (node.name === "ForStatement" || node.name === "WithStatement" || node.name === "TryStatement")
    ) {
      // Their binders include destructuring, context aliases, and exception
      // targets in grammar-specific positions. V1 records the affected names
      // as blockers without poisoning unrelated construct-scope bindings.
      const affectedNodes = node.name === "ForStatement" ? children(node).slice(1, 2) : targetsFollowingAs(node);
      addBlocker(`${node.name}-target-binding`, ownerStatementId, affectedNodes);
    }
    if (runtimeScope) {
      const rebindings = walrusTargets(node);
      if (rebindings.length > 0) addBlocker("named-expression-binding", ownerStatementId, rebindings);
    }

    for (const child of children(node)) {
      if (NESTED_SCOPE_NODES.has(child.name)) {
        inspectNode(child, scope, nextControlPath, ownerStatementId, runtimeScope);
      } else if (child.name === "Body") {
        for (const statement of statementChildren(child)) {
          inspectNode(statement, scope, nextControlPath, ownerStatementId, runtimeScope);
        }
      }
    }
  }

  for (const node of directNodes) {
    const statementId = statementByNode.get(node)?.id ?? null;
    inspectNode(node, constructScope, [], statementId, true);
  }

  const identifierTokens: Array<Readonly<{ name: string; span: SourceSpanV1 }>> = [];
  if (root.name === "VariableName") {
    identifierTokens.push({ name: request.sourceText.slice(root.from, root.to), span: index.span(root.from, root.to) });
  }
  descendants(root, (node) => {
    if (node.name === "VariableName") {
      identifierTokens.push({
        name: request.sourceText.slice(node.from, node.to),
        span: index.span(node.from, node.to),
      });
    }
  });

  const scopeById = new Map(scopes.map((scope) => [scope.id, scope] as const));
  const bindingGroups = new Map<string, MutableBinding[]>();
  for (const binding of mutableBindings) {
    const key = `${binding.scopeId}\u0000${binding.name}`;
    const group = bindingGroups.get(key) ?? [];
    group.push(binding);
    bindingGroups.set(key, group);
  }
  const bindings = mutableBindings.map((binding): SourceBindingFactV1 => {
    const ambiguous = (bindingGroups.get(`${binding.scopeId}\u0000${binding.name}`)?.length ?? 0) > 1;
    let ancestor = scopeById.get(binding.scopeId)?.parentId ?? null;
    let shadowedBindingId: string | null = null;
    while (ancestor) {
      const candidate = bindingGroups.get(`${ancestor}\u0000${binding.name}`)?.[0];
      if (candidate) {
        shadowedBindingId = candidate.id;
        break;
      }
      ancestor = scopeById.get(ancestor)?.parentId ?? null;
    }
    const bindingHasBlocker = blocksEveryBinding || blockedBindingNames.has(binding.name);
    const reason: Extract<SourceOperationCapabilityV1, { status: "unknown" }>["reason"] | null = bindingHasBlocker
      ? "unsupported-binding-form"
      : ambiguous
        ? "ambiguous-binding"
        : binding.scopeId !== constructScope.id || binding.controlPath.length > 0
          ? "dynamic-control-flow"
          : !binding.constructorCall
            ? "runtime-only"
            : null;
    const capability: SourceOperationCapabilityV1 = reason
      ? { reason, status: "unknown" }
      : { status: "source-eligible" };
    return {
      ...binding,
      ambiguous,
      capabilities: { move: capability, uniformResize: capability },
      shadowedBindingId,
    };
  });

  const classArguments = namedChild(selected.node, "ArgList");
  const baseExpressions = classArguments
    ? children(classArguments)
        .filter((node) => node.type.is("Expression"))
        .map((node) => ({ span: index.span(node.from, node.to), text: request.sourceText.slice(node.from, node.to) }))
    : [];
  return {
    bindings,
    id: analysisId,
    identifierTokens,
    scene: {
      baseExpressions,
      bindingBlockers: blockers,
      classLine: classSpan.startLine,
      classSpan,
      construct: { scopeId: constructScope.id, span: index.span(construct.from, construct.to) },
      id: sceneId,
      name: request.sceneName,
      ordinal: occurrenceOrdinal,
      statements,
    },
    schema: STUDIO_SOURCE_ANALYSIS_SCHEMA_V1,
    scopes,
    sourceHash,
    sourcePath: request.sourcePath,
    toolVersion: STUDIO_CST_SOURCE_ANALYSIS_TOOL_V1,
    version: STUDIO_SOURCE_ANALYSIS_VERSION_V1,
  };
}

export const studioSourceAnalysisProviderV1: StudioSourceAnalysisProviderV1 = Object.freeze({
  analyze,
  schema: STUDIO_SOURCE_ANALYSIS_SCHEMA_V1,
  toolVersion: STUDIO_CST_SOURCE_ANALYSIS_TOOL_V1,
  version: STUDIO_SOURCE_ANALYSIS_VERSION_V1,
});

/**
 * Intersects source-side structural eligibility with the two independent
 * runtime identity views used by lowering. A source fact alone never chooses
 * an entity, and a runtime label alone never authorizes a rewrite.
 */
export function composeSourceRuntimeOperationCapabilityV1(
  analysis: StudioSourceAnalysisV1,
  bindingName: string,
  operation: "move" | "uniformResize",
  requestBindings: readonly Readonly<{ entityId: string; sourceVariable: string }>[],
  runtimeSourceVariables: Readonly<Record<string, string>>,
) {
  const candidates = analysis.bindings.filter(
    (binding) =>
      binding.scopeId === analysis.scene.construct.scopeId &&
      binding.kind === "assignment" &&
      binding.name === bindingName &&
      binding.capabilities[operation].status === "source-eligible",
  );
  const runtime = requestBindings.filter(
    ({ entityId, sourceVariable }) =>
      sourceVariable === bindingName && runtimeSourceVariables[entityId] === bindingName,
  );
  if (candidates.length !== 1 || runtime.length !== 1) return null;
  return { binding: candidates[0]!, entityId: runtime[0]!.entityId } as const;
}

function canonicalAnalysisForPatch(source: string, analysis: StudioSourceAnalysisV1) {
  if (hashSource(source) !== analysis.sourceHash) {
    throw new SourceAnalysisError("stale-source", "A stale source boundary cannot authorize a patch.");
  }
  const canonical = studioSourceAnalysisProviderV1.analyze({
    expectedSourceHash: analysis.sourceHash,
    sceneName: analysis.scene.name,
    sourcePath: analysis.sourcePath,
    sourceText: source,
  });
  if (!isDeepStrictEqual(canonical, analysis)) {
    throw new SourceAnalysisError("malformed-evidence", "Source analysis payload is not canonical for these bytes.");
  }
  return canonical;
}

export function insertAtSourceBoundaryV1(
  source: string,
  analysis: StudioSourceAnalysisV1,
  boundary: SourceInsertionBoundaryV1,
  insertedLines: readonly string[],
) {
  const canonicalAnalysis = canonicalAnalysisForPatch(source, analysis);
  const canonical = canonicalAnalysis.scene.statements
    .flatMap((statement) => [statement.insertionBefore, statement.insertionAfter])
    .find((candidate) => candidate?.id === boundary.id);
  if (!canonical || !isDeepStrictEqual(canonical, boundary)) {
    throw new SourceAnalysisError("unsafe-boundary", "The insertion boundary is not canonical provider evidence.");
  }
  if (
    insertedLines.length === 0 ||
    insertedLines.length > 128 ||
    insertedLines.some(
      (line) =>
        line.length === 0 || line.includes("\r") || line.includes("\n") || !line.startsWith(canonical.indentation),
    )
  ) {
    throw new SourceAnalysisError("unsafe-boundary", "Inserted source lines must preserve the proven indentation.");
  }
  const bytes = Buffer.from(source, "utf8");
  const prefix = bytes.subarray(0, canonical.span.startByte).toString("utf8");
  if (Buffer.byteLength(prefix, "utf8") !== canonical.span.startByte) {
    throw new SourceAnalysisError("unsafe-boundary", "The insertion boundary splits a UTF-8 code point.");
  }
  return `${prefix}${insertedLines.join(canonical.newline)}${canonical.newline}${bytes
    .subarray(canonical.span.startByte)
    .toString("utf8")}`;
}

export function removeDirectSourceStatementsV1(
  source: string,
  analysis: StudioSourceAnalysisV1,
  removals: readonly Readonly<{ expectedText: string; statementId: string }>[],
) {
  if (removals.length === 0 || removals.length > 128) {
    throw new SourceAnalysisError("unsafe-boundary", "Statement removal requires a bounded non-empty set.");
  }
  const canonical = canonicalAnalysisForPatch(source, analysis);
  const selected = removals.map(({ expectedText, statementId }) => {
    const statement = canonical.scene.statements.find((candidate) => candidate.id === statementId);
    if (
      !statement ||
      statement.text !== expectedText ||
      statement.text.includes("\n") ||
      !statement.deletionSpan ||
      statement.rawText !== `${statement.indentation}${expectedText}`
    ) {
      throw new SourceAnalysisError("unsafe-boundary", "Only an exact canonical direct statement may be removed.");
    }
    return statement.deletionSpan;
  });
  const unique = new Set(selected.map((span) => `${span.startByte}:${span.endByte}`));
  if (unique.size !== selected.length) {
    throw new SourceAnalysisError("unsafe-boundary", "Statement removal contains duplicate source spans.");
  }
  let bytes = Buffer.from(source, "utf8");
  for (const span of [...selected].sort((left, right) => right.startByte - left.startByte)) {
    bytes = Buffer.concat([bytes.subarray(0, span.startByte), bytes.subarray(span.endByte)]);
  }
  return bytes.toString("utf8");
}
