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

export function manimStorageRootsOverlap(first: readonly string[], second: readonly string[]) {
  return first.some((left) => second.some((right) => contains(left, right) || contains(right, left)));
}
