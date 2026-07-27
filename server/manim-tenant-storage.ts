import { isAbsolute, relative, resolve, sep } from "node:path";

function contains(parent: string, candidate: string) {
  const fromParent = relative(parent, candidate);
  return fromParent === "" || (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}

export function normalizeManimStorageRoots(roots: readonly string[]) {
  const normalized = [...new Set(roots.map((root) => resolve(root)))].sort();
  return Object.freeze(
    normalized.filter((candidate) => !normalized.some((root) => root !== candidate && contains(root, candidate))),
  );
}

export function validateManimStorageRoots(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 128 ||
    value.some(
      (root) =>
        typeof root !== "string" ||
        root.length === 0 ||
        root.length > 4_096 ||
        root.includes("\0") ||
        !isAbsolute(root) ||
        resolve(root) !== root,
    )
  ) {
    throw new TypeError("Tenant APIs require bounded absolute storage roots.");
  }
  return value;
}

export function manimStorageRootsOverlap(first: readonly string[], second: readonly string[]) {
  return first.some((left) => second.some((right) => contains(left, right) || contains(right, left)));
}
