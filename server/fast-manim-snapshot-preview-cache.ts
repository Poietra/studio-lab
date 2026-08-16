import type {
  ExpectedFastManimSnapshotCorrelationV1,
  VerifiedCompiledFastManimSnapshotResultV1,
  VerifiedSourceRuntimeIdentityMapV1,
} from "./fast-manim-snapshot-contract";

/**
 * Process-wide preview-cache accounting and admission control for the
 * fast-manim snapshot pipeline. These are the process-global limits that hold
 * regardless of how many project runners are configured; the runner
 * orchestration and the per-Scene snapshot verification live in
 * fast-manim-snapshot-runner.ts.
 *
 * Per ADR 0005 this process-local store is a cache, not a Publication: it
 * grants no durable addressability, and its monotonic counter is a cache
 * sequence, not an Editor revision or an aggregate generation. The durable
 * snapshot Publication path lives in storage/snapshot-publication-repository
 * and durable-fast-manim-snapshot-service.
 */

export type CachedPreviewSnapshot = Readonly<{
  cachedAt: string;
  cachedAtEpochMs: number;
  /**
   * Position in the cache-global monotonic insertion sequence. Serialized on
   * the wire as the frozen `revision` run-view field (ADR 0005 compatibility);
   * it is neither an Editor revision nor a durable publication generation.
   */
  cacheSequence: number;
  encodedBytes: number;
  expected: ExpectedFastManimSnapshotCorrelationV1;
  result: VerifiedCompiledFastManimSnapshotResultV1;
  sourceRuntimeIdentity: VerifiedSourceRuntimeIdentityMapV1 | null;
}>;

const DEFAULT_GLOBAL_MAX_CACHED_SNAPSHOTS = 64;
const DEFAULT_GLOBAL_MAX_CACHED_BYTES = 64 * 1024 * 1024;
const DEFAULT_GLOBAL_MAX_CONCURRENT_PRODUCERS = 4;

/**
 * Process-wide preview-cache accounting shared by every snapshot runner. A
 * registry can host up to 64 projects, so per-runner budgets alone would
 * multiply into gigabytes; this cache enforces a conservative global encoded
 * byte and entry ceiling across all projects and tenants. Entries are
 * namespaced per registered owner (no cross-tenant reads: an owner can only
 * address its own keys), cache sequences come from a single cache-global
 * monotonic sequence that is never reused — across owners, evictions, and TTL
 * expiry — and eviction is deterministic least-recently-used over the shared
 * insertion order, touching only keys and byte counts, never foreign payloads.
 */
export class FastManimSnapshotPreviewCache {
  private readonly entries = new Map<string, CachedPreviewSnapshot>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private nextOwnerId = 1;
  private cacheSequenceCounter = 0;
  private totalBytes = 0;

  constructor(options: Readonly<{ maxBytes?: number; maxEntries?: number }> = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_GLOBAL_MAX_CACHED_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError("The global cached snapshot byte ceiling must be a positive integer.");
    }
    const maxEntries = options.maxEntries ?? DEFAULT_GLOBAL_MAX_CACHED_SNAPSHOTS;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError("The global cached snapshot entry ceiling must be a positive integer.");
    }
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  registerOwner() {
    const ownerId = this.nextOwnerId;
    this.nextOwnerId += 1;
    return ownerId;
  }

  private ownerKey(ownerId: number, key: string) {
    return `${ownerId} ${key}`;
  }

  /** Cache-global monotonic insertion sequence; values are never reused. */
  nextCacheSequence() {
    this.cacheSequenceCounter += 1;
    return this.cacheSequenceCounter;
  }

  fitsSingleEntry(encodedBytes: number) {
    return encodedBytes <= this.maxBytes;
  }

  get(ownerId: number, key: string) {
    const namespaced = this.ownerKey(ownerId, key);
    const entry = this.entries.get(namespaced);
    if (!entry) return undefined;
    // Refresh recency so actively read Scenes survive the shared caps.
    this.entries.delete(namespaced);
    this.entries.set(namespaced, entry);
    return entry;
  }

  /** Reads the current entry without touching recency: race checks only. */
  peek(ownerId: number, key: string) {
    return this.entries.get(this.ownerKey(ownerId, key));
  }

  delete(ownerId: number, key: string) {
    const namespaced = this.ownerKey(ownerId, key);
    const entry = this.entries.get(namespaced);
    if (!entry) return;
    this.entries.delete(namespaced);
    this.totalBytes -= entry.encodedBytes;
  }

  entriesOf(ownerId: number): ReadonlyArray<readonly [string, CachedPreviewSnapshot]> {
    const prefix = `${ownerId} `;
    const owned: Array<readonly [string, CachedPreviewSnapshot]> = [];
    for (const [namespaced, entry] of this.entries) {
      if (namespaced.startsWith(prefix)) owned.push([namespaced.slice(prefix.length), entry]);
    }
    return owned;
  }

  /**
   * Inserts the entry, trims the owner to its own ceilings, then trims the
   * cache to the global ceilings; returns how many entries were evicted. The
   * just-inserted entry always survives.
   */
  insert(
    ownerId: number,
    key: string,
    entry: CachedPreviewSnapshot,
    ownerLimits: Readonly<{ maxBytes: number; maxEntries: number }>,
  ) {
    const namespaced = this.ownerKey(ownerId, key);
    this.delete(ownerId, key);
    this.entries.set(namespaced, entry);
    this.totalBytes += entry.encodedBytes;
    let evicted = 0;
    let owned = this.entriesOf(ownerId);
    let ownedBytes = owned.reduce((total, [, ownedEntry]) => total + ownedEntry.encodedBytes, 0);
    while (owned.length > ownerLimits.maxEntries || ownedBytes > ownerLimits.maxBytes) {
      const oldest = owned[0];
      if (!oldest || oldest[0] === key) break;
      this.delete(ownerId, oldest[0]);
      ownedBytes -= oldest[1].encodedBytes;
      owned = owned.slice(1);
      evicted += 1;
    }
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || oldest === namespaced) break;
      const oldestEntry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (oldestEntry) this.totalBytes -= oldestEntry.encodedBytes;
      evicted += 1;
    }
    return evicted;
  }

  /** Releases every entry an owner holds so close/unregister returns its accounting. */
  releaseOwner(ownerId: number) {
    for (const [key] of this.entriesOf(ownerId)) this.delete(ownerId, key);
  }
}

/** Default process-wide cache: all managers and runners share one budget. */
export const processSnapshotCache = new FastManimSnapshotPreviewCache();

/**
 * Process-wide producer admission control. A registry can host 64 runners at
 * maxConcurrentRuns each, so per-runner caps alone would admit over a hundred
 * concurrent workspace Python processes; every runner acquires a slot from
 * one shared controller (default cap 4) immediately before spawning, and the
 * returned release is idempotent so success, failure, abort, and close paths
 * can all call it exactly once in effect. Production deployments behind #80
 * remain stricter than this cap.
 */
export class FastManimSnapshotAdmissionController {
  private active = 0;
  private readonly maxConcurrent: number;

  constructor(options: Readonly<{ maxConcurrent?: number }> = {}) {
    const maxConcurrent = options.maxConcurrent ?? DEFAULT_GLOBAL_MAX_CONCURRENT_PRODUCERS;
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new TypeError("The global producer concurrency cap must be a positive integer.");
    }
    this.maxConcurrent = maxConcurrent;
  }

  get activeCount() {
    return this.active;
  }

  /** Returns an idempotent release, or null when the server-wide cap is reached. */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.maxConcurrent) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

/** Default process-wide controller: all managers and runners share one cap. */
export const processAdmissionController = new FastManimSnapshotAdmissionController();
