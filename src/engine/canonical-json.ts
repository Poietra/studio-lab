export function canonicalJsonV1(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonV1(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON received a non-JSON value.");
}

export type CanonicalJsonSinkV1 = Readonly<{ update: (chunk: string) => void }>;

/** Writes the exact characters `canonicalJsonV1` would return without materializing the whole document. */
export function writeCanonicalJsonV1(value: unknown, sink: CanonicalJsonSinkV1): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    sink.update(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers.");
    sink.update(JSON.stringify(Object.is(value, -0) ? 0 : value));
    return;
  }
  if (Array.isArray(value)) {
    sink.update("[");
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      if (index > 0) sink.update(",");
      if (index in value) writeCanonicalJsonV1(value[index], sink);
    }
    sink.update("]");
    return;
  }
  if (typeof value === "object") {
    sink.update("{");
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    for (const [index, [key, entry]] of entries.entries()) {
      if (index > 0) sink.update(",");
      sink.update(`${JSON.stringify(key)}:`);
      writeCanonicalJsonV1(entry, sink);
    }
    sink.update("}");
    return;
  }
  throw new TypeError("Canonical JSON received a non-JSON value.");
}
