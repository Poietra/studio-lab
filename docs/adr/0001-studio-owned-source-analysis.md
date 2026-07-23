# ADR 0001: Studio owns source analysis for editing

- Status: Accepted
- Date: 2026-07-23
- Decision owner: Poietra Studio

## Context

Studio must answer questions that a linter does not need to answer: which exact
`Scene` definition is open, whether an insertion point is executable, which source
identity corresponds to a rendered object, what is known at a time boundary, and
whether an edit can be lowered without changing its meaning. The current
conservative importer recognizes a deliberately small source subset, but several
facts are still discovered with regular expressions. That is not sufficient for
Python strings, multiline expressions, nested control flow, duplicate class names,
updaters, or runtime-generated geometry.

`manim-lint` remains a linter. It may report source diagnostics through a generic
interface in the future, but it must not acquire Studio markers, timeline state,
Runtime Trace collection, edit capabilities, or source-rewrite behavior merely to
support Studio.

## Decision

Studio owns a versioned `SourceAnalysis` boundary in this repository. Analysis is
split into three evidence layers with different trust and freshness rules:

```text
Python source + source hash
          |
          v
  lexical / AST facts  --------> diagnostics and safe source spans
          |                                  |
          |                                  v
          +------------------------> lowering capabilities
          |
          v
 explicit isolated Runtime Trace --> time-varying runtime evidence
```

No layer turns missing evidence into a default value. Consumers receive a known
value with provenance or an explicit unknown reason.

### 1. Lexical and AST facts

Static analysis parses source without executing it. Its contract includes:

- comments and string spans, so marker-looking text inside a string is inert;
- every `Scene` class occurrence with source path, class span, base expression,
  definition ordinal, and method spans;
- direct statements inside the selected `construct` body, including assignments,
  calls, literal arguments, and their exact source spans;
- the enclosing control-flow path for every candidate statement;
- validated, versioned Studio markers attached to the following eligible statement;
- conservative bindings and literal properties that can be proved from the AST;
- diagnostics and capability blockers for syntax or forms outside the supported
  subset.

Scene identity is based on a source occurrence, not only `sceneName`. A duplicate
class name is either selected by its exact occurrence identity or rejected as
ambiguous. It must never silently resolve to the first definition while Python
executes the last definition.

An editable insertion boundary must be in the selected `construct` body, outside
all strings, and structurally reachable under the supported subset. A marker in a
nested branch, loop, function, class, exception handler, or context manager is not
promoted to a safe boundary unless that construct has a separately implemented and
tested lowering policy. Unknown reachability fails closed.

The implementation may use a server-side helper backed by Python `tokenize`/`ast`,
or a conforming Python parser available to TypeScript. The provider is hidden
behind the same data contract. Frontend components never invoke Python or parse raw
source independently.

### 2. Runtime Trace evidence

Static analysis does not guess dynamic control flow, updater effects, object
geometry, transform identity, camera state, or event timing. Those facts may be
provided by a future Studio-owned Runtime Trace adapter with these constraints:

- collection is an explicit preview/render action; listing a workspace never runs
  project Python;
- project source is mounted read-only and execution uses the existing isolated,
  cancellable render boundary;
- trace records are bound to source hash, Scene occurrence, Manim/config version,
  and a trace schema version;
- trace identities map back to AST source occurrences where possible and otherwise
  remain runtime-only identities;
- a trace can prove observed runtime behavior for its captured configuration, but
  cannot by itself authorize an arbitrary source rewrite.

Static facts and Runtime Trace may disagree after a source/config change. A hash or
configuration mismatch invalidates the trace rather than merging stale evidence.

### 3. Studio markers

Markers are data owned by Studio, not Python facts and not lint directives.

- marker payloads use closed schemas and explicit versions;
- marker text inside strings is ignored;
- identity/property markers are authoritative only for the Studio-generated value
  they encode and retain source-span evidence;
- an anchor marker supplies an intended time but is eligible only when AST context
  also proves a supported insertion boundary;
- invalid, misplaced, duplicated, or newer-version markers remain inert and emit a
  diagnostic when useful;
- marker compatibility is fixture-tested before a schema version is retired.

### 4. Knowledge and capability contract

Analysis returns data equivalent to the following shape; the exact TypeScript
schema may evolve independently of this ADR:

```ts
type Evidence = {
  kind: "ast" | "studio-marker" | "runtime-trace";
  sourceHash: string;
  sourceSpan?: { start: number; end: number };
  detail: string;
};

type Knowledge<T> =
  | { status: "known"; value: T; evidence: Evidence[] }
  | {
      status: "unknown";
      reason:
        | "unsupported-syntax"
        | "dynamic-control-flow"
        | "runtime-only"
        | "ambiguous-source-identity"
        | "stale-evidence"
        | "invalid-marker";
      evidence: Evidence[];
    };
```

The analysis result also declares operation-level capabilities such as
`canInsertAt`, `canRewriteProperty`, and `canRebindTransform`. The UI, canonical
validator, exporter, and render pipeline consume that single declaration. A local
preview capability is not evidence that source lowering is supported.

### 5. Fail-closed behavior

| Source form | Static result | Editing consequence |
| --- | --- | --- |
| direct `construct` assignment/call with supported literals | known with AST spans | supported operation may be offered |
| valid versioned Studio marker in eligible context | known for encoded field | supported operation may round-trip |
| multiline or nested expression with supported AST shape | known when structurally proved | formatting does not change semantics |
| marker-looking text in a string | inert | never an anchor or identity |
| conditional, loop, exception, or context-manager body | dynamic control flow | no safe insertion until explicitly supported |
| duplicate Scene name without occurrence identity | ambiguous source identity | selection/edit is blocked |
| updater, `always_redraw`, dynamic factory, or arbitrary call result | runtime-only | property remains unknown without a fresh trace |
| syntax error or unsupported parser version | unavailable analysis | source editing is blocked; source remains exportable unchanged |

## Ownership boundaries

| Component | Owns | Does not own |
| --- | --- | --- |
| Studio source analysis | AST facts, marker decoding, occurrence identity, edit capabilities, trace correlation | style/lint policy for Manim projects |
| Studio lowering | closed canonical operations, span-safe rewrites, metadata shifts | arbitrary Python refactoring |
| Studio Runtime Trace | observed Scene/runtime evidence under an explicit render | static source truth outside the captured hash/config |
| `manim-lint` | independent lint diagnostics and linter rules | Studio timeline, markers, edit IR, preview, lowering, or trace lifecycle |
| AI suggestion layer | bounded candidate proposals | proving source facts or bypassing capability blockers |

An optional future diagnostic adapter may translate `manim-lint` findings into
Studio diagnostics. That adapter is one-way and cannot make `manim-lint` a required
runtime dependency for import, editing, or export.

## Migration plan

1. Add lexical masking now so strings and unsupported nested contexts cannot become
   safe anchors; cover confirmed regressions with fixtures.
2. Introduce the versioned `SourceAnalysis` provider and Scene occurrence identity
   without changing the workspace HTTP contract all at once.
3. Move Scene discovery, direct-statement facts, and marker attachment from regular
   expressions to AST spans. Preserve current supported fixtures and report
   unsupported forms as unknown.
4. Make importer, lowerer, canonical validation, and UI capability display consume
   the same analysis result. Remove duplicate source interpretation.
5. Add explicit Runtime Trace collection for facts that static analysis cannot
   prove. Cache only by the complete evidence key.
6. Delete superseded regex paths after parity fixtures and marker migration pass.

During migration, a legacy fact may remain readable, but it cannot authorize a
destructive rewrite unless the new provider can produce equivalent evidence.

## Test contract

Fixture coverage must include at least:

- single-, double-, and triple-quoted strings containing marker text;
- multiline calls, comments, escaped strings, and type annotations;
- nested `if`/`for`/`while`/`try`/`with`, nested functions, and nested classes;
- duplicate Scene names and multiple Scene classes in one file;
- invalid, misplaced, duplicated, and unknown-version Studio markers;
- dynamic expressions and updater-driven geometry remaining unknown;
- source-hash/config mismatch invalidating Runtime Trace evidence;
- lowering followed by reimport preserving identity, time metadata, and source
  occurrence.

Every regression fixture must fail on the faulty implementation. Parser snapshots
alone are insufficient when the bug is an unsafe edit; those cases require a
lowering/reimport assertion as well.

## Consequences

- Studio carries the cost of a source-analysis subsystem because the semantics are
  specific to editing and truthful preview.
- Browser UI remains independent of Python parsing details and receives only
  versioned, closed data.
- Unsupported Python remains usable as source but not silently editable.
- Runtime Trace can improve fidelity without weakening the static source-write
  boundary.
- `manim-lint` stays focused and can evolve without becoming part of Studio's edit
  runtime.

## Non-goals

- executing arbitrary Python during static analysis;
- turning Studio into a general Python IDE or formatter;
- accepting every valid Manim program as safely editable;
- moving Studio-specific marker or lowering behavior into `manim-lint`;
- treating a successful render as proof that the intended edit executed;
- providing a remotely exposed Python sandbox in this decision.
