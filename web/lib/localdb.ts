import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * File-backed stand-in for the firebase-admin Firestore client. The app runs
 * locally with no Firebase project: every `adminDb` call lands here, and the
 * Python scraper reads/writes the SAME files through localdb.py. Keep the two
 * in sync on:
 *
 *   data/<col>/<id>.json             committed config (CONFIG_COLLECTIONS)
 *   data/<col>/<id>/<sub>/<id>.json
 *   local-data/...                   runs, findings, lessons, listings… (gitignored)
 *   local-data/_overlay/<path>.json  VOLATILE_FIELDS of config docs
 *
 * One JSON object per document, keys sorted, 2-space indent. Timestamps are
 * stored as {"__ts": "<ISO>"} and read back as Timestamp objects (toDate /
 * toMillis / _seconds), matching what firebase-admin returned. Doc ids are
 * percent-encoded outside [A-Za-z0-9._-]. Only '==' filters are supported —
 * the only operator the app uses.
 */

const REPO_ROOT = process.env.CASPIAN_REPO_ROOT ?? path.resolve(process.cwd(), "..");
const CONFIG_ROOT = path.join(REPO_ROOT, "data");
const LOCAL_ROOT = path.join(REPO_ROOT, "local-data");

/** Collection-name paths (doc ids elided) committed to the repo. */
const CONFIG_COLLECTIONS = new Set([
  "projects",
  "projects/sources",
  "resources",
  "comparison_sources",
  "car_sources",
  "generic_sources",
]);
/** Run-derived fields the scraper writes onto config docs. */
const VOLATILE_FIELDS = new Set(["last_run_at", "last_run_summary"]);

export type DocumentData = { [field: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---- Timestamp / FieldValue ----------------------------------------------

export class Timestamp {
  readonly _seconds: number;
  readonly _nanoseconds: number;

  constructor(seconds: number, nanoseconds: number) {
    this._seconds = seconds;
    this._nanoseconds = nanoseconds;
  }
  static fromMillis(ms: number): Timestamp {
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(seconds, Math.round((ms - seconds * 1000) * 1e6));
  }
  static fromDate(d: Date): Timestamp {
    return Timestamp.fromMillis(d.getTime());
  }
  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }
  get seconds(): number {
    return this._seconds;
  }
  get nanoseconds(): number {
    return this._nanoseconds;
  }
  toMillis(): number {
    return this._seconds * 1000 + Math.floor(this._nanoseconds / 1e6);
  }
  toDate(): Date {
    return new Date(this.toMillis());
  }
  isEqual(other: Timestamp): boolean {
    return this.toMillis() === other.toMillis();
  }
  valueOf(): string {
    return this.toDate().toISOString();
  }
}

class Sentinel {
  constructor(
    readonly kind: "serverTimestamp" | "arrayUnion" | "arrayRemove" | "increment" | "delete",
    readonly values: unknown[] = [],
    readonly by = 0
  ) {}
}

export const FieldValue = {
  serverTimestamp: () => new Sentinel("serverTimestamp"),
  arrayUnion: (...values: unknown[]) => new Sentinel("arrayUnion", values),
  arrayRemove: (...values: unknown[]) => new Sentinel("arrayRemove", values),
  increment: (n: number) => new Sentinel("increment", [], n),
  delete: () => new Sentinel("delete"),
};

// ---- value encoding --------------------------------------------------------

type Disk = unknown;

function toDisk(v: unknown): Disk {
  if (v instanceof Timestamp) return { __ts: v.toDate().toISOString() };
  if (v instanceof Date) return { __ts: v.toISOString() };
  if (Array.isArray(v)) return v.map(toDisk);
  if (v && typeof v === "object") {
    const out: Record<string, Disk> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toDisk(x);
    return out;
  }
  return v;
}

function isTs(v: unknown): v is { __ts: string } {
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(v).length === 1 && typeof (v as { __ts?: unknown }).__ts === "string";
}

function fromDisk(v: Disk): unknown {
  if (isTs(v)) return Timestamp.fromDate(new Date(v.__ts));
  if (Array.isArray(v)) return v.map(fromDisk);
  if (v && typeof v === "object") {
    const out: DocumentData = {};
    for (const [k, x] of Object.entries(v)) out[k] = fromDisk(x);
    return out;
  }
  return v;
}

const same = (a: Disk, b: Disk) => stableStringify(a) === stableStringify(b);

/** Resolve sentinels in `next` against `current` (both disk-form). */
function apply(current: Disk, next: unknown): Disk {
  if (next instanceof Sentinel) {
    switch (next.kind) {
      case "serverTimestamp":
        return { __ts: new Date().toISOString() };
      case "increment":
        return (typeof current === "number" ? current : 0) + next.by;
      case "arrayUnion": {
        const out = Array.isArray(current) ? [...current] : [];
        for (const x of next.values.map(toDisk)) if (!out.some((y) => same(x, y))) out.push(x);
        return out;
      }
      case "arrayRemove": {
        const drop = next.values.map(toDisk);
        return (Array.isArray(current) ? current : []).filter((x) => !drop.some((y) => same(x, y)));
      }
      case "delete":
        return undefined;
    }
  }
  if (next instanceof Timestamp || next instanceof Date) return toDisk(next);
  if (Array.isArray(next)) return next.map((x) => apply(undefined, x));
  if (next && typeof next === "object") {
    const cur = current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, Disk>) : {};
    const out: Record<string, Disk> = {};
    for (const [k, x] of Object.entries(next)) {
      if (x === undefined || (x instanceof Sentinel && x.kind === "delete")) continue;
      out[k] = apply(cur[k], x);
    }
    return out;
  }
  return next;
}

function deepMerge(current: Disk, next: Disk): Disk {
  if (
    current && typeof current === "object" && !Array.isArray(current) && !isTs(current) &&
    next && typeof next === "object" && !Array.isArray(next) && !isTs(next)
  ) {
    const out: Record<string, Disk> = { ...(current as Record<string, Disk>) };
    for (const [k, v] of Object.entries(next)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return next;
}

function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2);
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

// ---- disk I/O ---------------------------------------------------------------

function readJson(file: string): Record<string, Disk> | null {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      // The scraper may be mid-replace on Windows; retry briefly.
      if (attempt >= 4) throw e;
      sleepSync(50);
    }
  }
}

function writeJson(file: string, data: Disk): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, stableStringify(data) + "\n", "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 9) throw e;
      sleepSync(50);
    }
  }
}

function unlink(file: string): void {
  fs.rmSync(file, { force: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const SAFE_ID = /[A-Za-z0-9._-]/;
const encodeId = (id: string) =>
  Array.from(id).map((ch) =>
    SAFE_ID.test(ch) ? ch : Array.from(Buffer.from(ch, "utf8")).map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("")
  ).join("");
const decodeId = (name: string) => decodeURIComponent(name);

const AUTO_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function autoId(): string {
  const bytes = crypto.randomBytes(20);
  return Array.from(bytes, (b) => AUTO_ID[b % AUTO_ID.length]).join("");
}

// ---- snapshots ---------------------------------------------------------------

export class DocumentSnapshot {
  readonly id: string;
  constructor(readonly ref: DocumentReference, protected readonly raw: Record<string, Disk> | null) {
    this.id = ref.id;
  }
  get exists(): boolean {
    return this.raw !== null;
  }
  data(): DocumentData | undefined {
    return this.raw === null ? undefined : (fromDisk(this.raw) as DocumentData);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(field: string): any {
    return this.raw === null ? undefined : fromDisk(this.raw[field]);
  }
}

export class QueryDocumentSnapshot extends DocumentSnapshot {
  data(): DocumentData {
    return fromDisk(this.raw ?? {}) as DocumentData;
  }
}

export class QuerySnapshot {
  constructor(readonly docs: QueryDocumentSnapshot[]) {}
  get size(): number {
    return this.docs.length;
  }
  get empty(): boolean {
    return this.docs.length === 0;
  }
  forEach(cb: (d: QueryDocumentSnapshot) => void): void {
    this.docs.forEach(cb);
  }
}

// ---- references ----------------------------------------------------------------

export class DocumentReference {
  constructor(private readonly segments: string[]) {}

  get id(): string {
    return this.segments[this.segments.length - 1];
  }
  get path(): string {
    return this.segments.join("/");
  }
  get parent(): CollectionReference {
    return new CollectionReference(this.segments.slice(0, -1));
  }
  collection(name: string): CollectionReference {
    return new CollectionReference([...this.segments, name]);
  }

  private isConfig(): boolean {
    return CONFIG_COLLECTIONS.has(this.segments.filter((_, i) => i % 2 === 0).join("/"));
  }
  /** Relative path without extension, e.g. projects/hse/runs/abc */
  relBase(): string {
    return path.join(...this.segments.map((s, i) => (i % 2 === 0 ? s : encodeId(s))));
  }
  private basePath(): string {
    return path.join(this.isConfig() ? CONFIG_ROOT : LOCAL_ROOT, this.relBase() + ".json");
  }
  private overlayPath(): string | null {
    return this.isConfig() ? path.join(LOCAL_ROOT, "_overlay", this.relBase() + ".json") : null;
  }

  /** @internal */
  read(): Record<string, Disk> | null {
    const base = readJson(this.basePath());
    if (base === null) return null;
    const ov = this.overlayPath();
    return ov ? { ...base, ...(readJson(ov) ?? {}) } : base;
  }

  /** @internal */
  write(data: Record<string, Disk>): void {
    const ov = this.overlayPath();
    if (!ov) {
      writeJson(this.basePath(), data);
      return;
    }
    const stable: Record<string, Disk> = {};
    const volatile: Record<string, Disk> = {};
    for (const [k, v] of Object.entries(data)) (VOLATILE_FIELDS.has(k) ? volatile : stable)[k] = v;
    const curBase = readJson(this.basePath());
    if (curBase === null || !same(curBase, stable)) writeJson(this.basePath(), stable);
    if (Object.keys(volatile).length > 0) {
      const curOv = readJson(ov);
      if (curOv === null || !same(curOv, volatile)) writeJson(ov, volatile);
    } else {
      unlink(ov);
    }
  }

  async get(): Promise<DocumentSnapshot> {
    return new DocumentSnapshot(this, this.read());
  }
  async set(data: DocumentData, opts?: { merge?: boolean }): Promise<void> {
    setSync(this, data, opts);
  }
  async update(data: DocumentData): Promise<void> {
    updateSync(this, data);
  }
  async create(data: DocumentData): Promise<void> {
    createSync(this, data);
  }
  async delete(): Promise<void> {
    deleteSync(this);
  }
}

function setSync(ref: DocumentReference, data: DocumentData, opts?: { merge?: boolean }): void {
  if (!opts?.merge) {
    ref.write(apply({}, data) as Record<string, Disk>);
    return;
  }
  const current = ref.read() ?? {};
  const merged = deepMerge(current, apply(current, data)) as Record<string, Disk>;
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Sentinel && v.kind === "delete") delete merged[k];
  }
  ref.write(merged);
}

function updateSync(ref: DocumentReference, data: DocumentData): void {
  const current = ref.read();
  if (current === null) {
    throw Object.assign(new Error(`5 NOT_FOUND: No document to update: ${ref.path}`), { code: 5 });
  }
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v instanceof Sentinel && v.kind === "delete") delete current[k];
    else current[k] = apply(current[k], v);
  }
  ref.write(current);
}

function createSync(ref: DocumentReference, data: DocumentData): void {
  if (ref.read() !== null) {
    throw Object.assign(new Error(`6 ALREADY_EXISTS: Document already exists: ${ref.path}`), { code: 6 });
  }
  ref.write(apply({}, data) as Record<string, Disk>);
}

function deleteSync(ref: DocumentReference): void {
  const base = ref.relBase() + ".json";
  for (const root of [CONFIG_ROOT, LOCAL_ROOT, path.join(LOCAL_ROOT, "_overlay")]) {
    unlink(path.join(root, base));
  }
}

type Order = { field: string; desc: boolean };

function typeRank(v: Disk): [number, unknown] {
  if (v === null || v === undefined) return [0, 0];
  if (typeof v === "boolean") return [1, v ? 1 : 0];
  if (typeof v === "number") return [2, v];
  if (isTs(v)) return [3, v.__ts];
  if (typeof v === "string") return [4, v];
  return [Array.isArray(v) ? 5 : 6, stableStringify(v)];
}
function compare(a: Disk, b: Disk): number {
  const [ra, va] = typeRank(a);
  const [rb, vb] = typeRank(b);
  if (ra !== rb) return ra - rb;
  return (va as number | string) < (vb as number | string) ? -1 : (va as number | string) > (vb as number | string) ? 1 : 0;
}

export class Query {
  constructor(
    protected readonly segments: string[],
    private readonly filters: [string, Disk][] = [],
    private readonly orders: Order[] = [],
    private readonly max: number | null = null,
    private readonly fields: string[] | null = null
  ) {}

  where(field: string, op: string, value: unknown): Query {
    if (op !== "==") throw new Error(`localdb only supports '==' filters (got '${op}')`);
    return new Query(this.segments, [...this.filters, [field, toDisk(value)]], this.orders, this.max, this.fields);
  }
  orderBy(field: string, dir: "asc" | "desc" = "asc"): Query {
    return new Query(this.segments, this.filters, [...this.orders, { field, desc: dir === "desc" }], this.max, this.fields);
  }
  limit(n: number): Query {
    return new Query(this.segments, this.filters, this.orders, n, this.fields);
  }
  select(...fields: string[]): Query {
    return new Query(this.segments, this.filters, this.orders, this.max, fields);
  }
  count(): { get: () => Promise<{ data: () => { count: number } }> } {
    return {
      get: async () => {
        const n = (await this.get()).size;
        return { data: () => ({ count: n }) };
      },
    };
  }

  private all(): [DocumentReference, Record<string, Disk>][] {
    const col = new CollectionReference(this.segments);
    const dir = path.dirname(path.join(
      CONFIG_COLLECTIONS.has(this.segments.filter((_, i) => i % 2 === 0).join("/")) ? CONFIG_ROOT : LOCAL_ROOT,
      col.doc("x").relBase()
    ));
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: [DocumentReference, Record<string, Disk>][] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const ref = col.doc(decodeId(name.slice(0, -5)));
      const raw = ref.read();
      if (raw !== null) out.push([ref, raw]);
    }
    return out;
  }

  async get(): Promise<QuerySnapshot> {
    let rows = this.all().filter(([, raw]) => this.filters.every(([f, v]) => same(raw[f], v)));
    for (const { field, desc } of [...this.orders].reverse()) {
      rows = rows.filter(([, raw]) => field in raw);
      rows.sort(([, a], [, b]) => (desc ? -1 : 1) * compare(a[field], b[field]));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return new QuerySnapshot(
      rows.map(([ref, raw]) => {
        const picked = this.fields
          ? Object.fromEntries(Object.entries(raw).filter(([k]) => this.fields!.includes(k)))
          : raw;
        return new QueryDocumentSnapshot(ref, picked);
      })
    );
  }
}

export class CollectionReference extends Query {
  constructor(segments: string[]) {
    super(segments);
  }
  get id(): string {
    return this.segments[this.segments.length - 1];
  }
  get path(): string {
    return this.segments.join("/");
  }
  doc(id?: string): DocumentReference {
    return new DocumentReference([...this.segments, id ?? autoId()]);
  }
  async add(data: DocumentData): Promise<DocumentReference> {
    const ref = this.doc();
    createSync(ref, data);
    return ref;
  }
}

/** Ops apply in order on commit (not atomic across files — fine locally). */
export class WriteBatch {
  private ops: (() => void)[] = [];
  set(ref: DocumentReference, data: DocumentData, opts?: { merge?: boolean }): WriteBatch {
    this.ops.push(() => setSync(ref, data, opts));
    return this;
  }
  update(ref: DocumentReference, data: DocumentData): WriteBatch {
    this.ops.push(() => updateSync(ref, data));
    return this;
  }
  create(ref: DocumentReference, data: DocumentData): WriteBatch {
    this.ops.push(() => createSync(ref, data));
    return this;
  }
  delete(ref: DocumentReference): WriteBatch {
    this.ops.push(() => deleteSync(ref));
    return this;
  }
  async commit(): Promise<void> {
    for (const op of this.ops) op();
  }
}

export class Firestore {
  collection(name: string): CollectionReference {
    return new CollectionReference(name.split("/"));
  }
  doc(docPath: string): DocumentReference {
    return new DocumentReference(docPath.split("/"));
  }
  batch(): WriteBatch {
    return new WriteBatch();
  }
  async getAll(...refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
    return Promise.all(refs.map((r) => r.get()));
  }
  async recursiveDelete(ref: DocumentReference): Promise<void> {
    deleteSync(ref);
    for (const root of [CONFIG_ROOT, LOCAL_ROOT, path.join(LOCAL_ROOT, "_overlay")]) {
      fs.rmSync(path.join(root, ref.relBase()), { recursive: true, force: true });
    }
  }
}

export const localDb = new Firestore();
