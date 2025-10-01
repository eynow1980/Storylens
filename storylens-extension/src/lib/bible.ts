// src/bible.ts
// Local-first project memory using chrome.storage.local (with safe merges)

/* =========================
   Types
   ========================= */
export type BibleEntityType = "Character" | "Location" | "Rule" | "Object" | "Concept"
export type Evidence = { span?: [number, number]; quote?: string; chapterId?: string }

export type Entity = {
  id: string                 // e.g. "Character:Mercy"
  type: BibleEntityType
  attrs: Record<string, string | string[]>
  evidence: Evidence[]
}

export type Thread = {
  name: string
  status: "open" | "closed"
  notes?: string
  hooks?: number[]           // fractional positions 0..1
  todos?: string[]
  updatedAt?: number
  createdAt?: number
}

export type Bible = {
  projectId: string
  updatedAt: number
  schemaVersion: number
  entities: Record<string, Entity>   // keyed by id
  threads: Thread[]
  style: { dialogueRatioTarget?: number; pacingHint?: string; voiceTells?: string[] }
}

/* =========================
   Storage & constants
   ========================= */
const SCHEMA_VERSION = 1
const KEY = "sl_bible_v1" // global bucket with per-project entries

// Quotas (tune as needed — soft clamps)
const MAX_ENTITIES = 2000
const MAX_EVIDENCE_PER_ENTITY = 20
const MAX_THREADS = 500
const MAX_TODOS_PER_THREAD = 40

// Chrome storage shim (falls back to localStorage if needed)
const storage = (() => {
  const hasChrome =
    typeof globalThis !== "undefined" &&
    // @ts-ignore
    !!globalThis.chrome && !!chrome.storage && !!chrome.storage.local

  if (hasChrome) {
    return {
      async get(k: string): Promise<Record<string, any>> {
        return await new Promise((resolve) => {
          // @ts-ignore
          chrome.storage.local.get(k, (r: any) => resolve(r || {}))
        })
      },
      async set(obj: Record<string, any>): Promise<void> {
        await new Promise<void>((resolve) => {
          // @ts-ignore
          chrome.storage.local.set(obj, () => resolve())
        })
      }
    }
  }

  // Dev/test fallback
  return {
    async get(k: string): Promise<Record<string, any>> {
      const raw = localStorage.getItem(k)
      return raw ? { [k]: JSON.parse(raw) } : {}
    },
    async set(obj: Record<string, any>): Promise<void> {
      for (const [k, v] of Object.entries(obj)) {
        localStorage.setItem(k, JSON.stringify(v))
      }
    }
  }
})()

/* =========================
   Internal helpers
   ========================= */
function now() { return Date.now() }

function normalizeType(t: string): BibleEntityType {
  const T = (t || "").trim()
  if (T === "Character" || T === "Location" || T === "Rule" || T === "Object" || T === "Concept") return T
  // try to coerce from id prefix like "Character:Name"
  if (/^character:/i.test(T)) return "Character"
  if (/^location:/i.test(T)) return "Location"
  if (/^rule:/i.test(T)) return "Rule"
  if (/^object:/i.test(T)) return "Object"
  return "Concept"
}
function ensureIdPrefix(id: string, type: BibleEntityType): string {
  const hasPrefix = /^[A-Za-z]+:/.test(id)
  return hasPrefix ? id : `${type}:${id}`
}
function uniq<T>(arr: T[]): T[] { return Array.from(new Set(arr)) }

function mergeAttrs(a: Record<string, any> = {}, b: Record<string, any> = {}) {
  const out: Record<string, string | string[]> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const av = out[k]
    if (Array.isArray(av) || Array.isArray(v)) {
      const aa = Array.isArray(av) ? av : (av != null ? [String(av)] : [])
      const bb = Array.isArray(v)  ? v  : (v != null  ? [String(v)]  : [])
      out[k] = uniq([...aa.map(String), ...bb.map(String)]).slice(0, 50)
    } else if (typeof v === "string") {
      // prefer non-empty new value; if both present and different, keep both as array
      if (typeof av === "string" && av && av !== v) out[k] = uniq([av, v])
      else out[k] = v
    } else if (v != null) {
      out[k] = String(v)
    }
  }
  return out
}

function dedupeEvidence(list: Evidence[]): Evidence[] {
  const key = (e: Evidence) =>
    `${e.chapterId || ""}|${(e.span || []).join(",")}|${(e.quote || "").slice(0, 80)}`
  const seen = new Set<string>()
  const out: Evidence[] = []
  for (const e of list) {
    const k = key(e)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(e)
      if (out.length >= MAX_EVIDENCE_PER_ENTITY) break
    }
  }
  return out
}

function pruneBible(b: Bible): Bible {
  // clamp entities
  const entries = Object.entries(b.entities)
  if (entries.length > MAX_ENTITIES) {
    // simple LRU-ish pruning by earliest evidence time (or random if none)
    const keep = new Map(entries.slice(0, MAX_ENTITIES))
    b.entities = Object.fromEntries(keep)
  }
  // clamp evidence per entity
  for (const e of Object.values(b.entities)) {
    e.evidence = dedupeEvidence(e.evidence || [])
  }
  // clamp threads
  if (b.threads.length > MAX_THREADS) {
    b.threads = b.threads.slice(-MAX_THREADS)
  }
  for (const t of b.threads) {
    t.todos = (t.todos || []).slice(0, MAX_TODOS_PER_THREAD)
    t.hooks = (t.hooks || []).map(Number).filter(n => isFinite(n) && n >= 0 && n <= 1)
  }
  return b
}

function migrate(b: Bible | undefined, projectId: string): Bible {
  if (!b) {
    return { projectId, updatedAt: now(), schemaVersion: SCHEMA_VERSION, entities: {}, threads: [], style: {} }
  }
  if (typeof b === "object" && b !== null && !("schemaVersion" in b)) {
    (b as Bible).schemaVersion = 1
  }
  // future migrations by version here
  b.projectId = projectId
  return pruneBible(b)
}

/* =========================
   Persistence
   ========================= */
async function getAll(): Promise<Record<string, Bible>> {
  const r = await storage.get(KEY)
  return (r[KEY] as Record<string, Bible>) || {}
}
async function saveAll(all: Record<string, Bible>) {
  await storage.set({ [KEY]: all })
}

/* =========================
   Public API
   ========================= */

/** Fetch project Bible (creates empty if missing) */
export async function getBible(projectId: string): Promise<Bible> {
  const all = await getAll()
  const migrated = migrate(all[projectId], projectId)
  if (!all[projectId]) {
    all[projectId] = migrated
    await saveAll(all)
  } else if (all[projectId] !== migrated) {
    all[projectId] = migrated
    await saveAll(all)
  }
  return migrated
}

/** Replace entire Bible */
export async function putBible(b: Bible) {
  const all = await getAll()
  all[b.projectId] = pruneBible({ ...b, updatedAt: now(), schemaVersion: SCHEMA_VERSION })
  await saveAll(all)
}

/** Insert or merge an entity */
export async function upsertEntity(projectId: string, e: Entity) {
  const b = await getBible(projectId)
  const type = normalizeType(e.type || (e.id.split(":")[0] as any))
  const id = ensureIdPrefix(e.id || "", type)
  const prev = b.entities[id]

  const merged: Entity = {
    id,
    type,
    attrs: mergeAttrs(prev?.attrs, e.attrs || {}),
    evidence: dedupeEvidence([...(prev?.evidence || []), ...(e.evidence || [])])
  }

  b.entities[id] = merged
  b.updatedAt = now()
  await putBible(b)
}

/** Add one piece of evidence to an entity */
export async function addEvidence(projectId: string, id: string, ev: Evidence) {
  const b = await getBible(projectId)
  const cur = b.entities[id]
  if (!cur) return
  cur.evidence = dedupeEvidence([...(cur.evidence || []), ev])
  b.updatedAt = now()
  await putBible(b)
}

/** Batch upsert entities (faster than many single writes) */
export async function upsertEntities(projectId: string, entities: Entity[]) {
  if (!Array.isArray(entities) || entities.length === 0) return
  const b = await getBible(projectId)
  for (const e of entities) {
    const type = normalizeType(e.type || (e.id.split(":")[0] as any))
    const id = ensureIdPrefix(e.id || "", type)
    const prev = b.entities[id]
    const merged: Entity = {
      id,
      type,
      attrs: mergeAttrs(prev?.attrs, e.attrs || {}),
      evidence: dedupeEvidence([...(prev?.evidence || []), ...(e.evidence || [])])
    }
    b.entities[id] = merged
  }
  b.updatedAt = now()
  await putBible(b)
}

/** Insert or merge a thread by name */
export async function upsertThread(projectId: string, t: Thread) {
  const b = await getBible(projectId)
  const name = (t.name || "").trim()
  if (!name) return
  const i = b.threads.findIndex((x) => x.name === name)
  const base: Thread = i >= 0 ? b.threads[i] : { name, status: "open", createdAt: now() }

  const merged: Thread = {
    ...base,
    ...t,
    status: t.status || base.status || "open",
    hooks: uniq([...(base.hooks || []), ...(t.hooks || [])]).filter(n => isFinite(Number(n))).map(Number).filter(n => n >= 0 && n <= 1),
    todos: uniq([...(base.todos || []), ...((t.todos || []) as string[])]).slice(0, MAX_TODOS_PER_THREAD),
    updatedAt: now()
  }

  if (i >= 0) b.threads[i] = merged
  else b.threads.push(merged)

  b.updatedAt = now()
  await putBible(b)
}

/** Close a thread (helper) */
export async function closeThread(projectId: string, name: string) {
  const b = await getBible(projectId)
  const i = b.threads.findIndex((x) => x.name === name)
  if (i >= 0) {
    b.threads[i].status = "closed"
    b.threads[i].updatedAt = now()
    await putBible(b)
  }
}

/** Remove an entity */
export async function removeEntity(projectId: string, id: string) {
  const b = await getBible(projectId)
  if (b.entities[id]) {
    delete b.entities[id]
    b.updatedAt = now()
    await putBible(b)
  }
}
export async function removeThread(projectId: string, name: string) {
  const b = await getBible(projectId)
  const i = b.threads.findIndex((t) => t.name === name)
  if (i === -1) return
  b.threads.splice(i, 1)
  b.updatedAt = Date.now()
  await putBible(b)
}




/** Free-text search across entities & threads */
export async function searchBible(projectId: string, q: string) {
  const b = await getBible(projectId)
  const qq = (q || "").toLowerCase().trim()

  const entities = Object.values(b.entities).filter((e) => {
    if (!qq) return true
    const blob = (e.id + " " + e.type + " " + JSON.stringify(e.attrs)).toLowerCase()
    return blob.includes(qq)
  })

  const threads = b.threads.filter((t) => {
    if (!qq) return true
    const blob = (t.name + " " + (t.notes || "") + " " + (t.todos || []).join(" ")).toLowerCase()
    return blob.includes(qq)
  })

  return { entities, threads, style: b.style }
}

/** Export one project's Bible as plain JSON (for backup / debug) */
export async function exportBible(projectId: string): Promise<Bible> {
  const b = await getBible(projectId)
  // Return a deep copy to avoid accidental mutations outside
  return JSON.parse(JSON.stringify(b))
}

/** Import/merge a Bible JSON dump */
export async function importBible(projectId: string, incoming: Partial<Bible>) {
  const b = await getBible(projectId)

  // merge entities
  if (incoming.entities && typeof incoming.entities === "object") {
    const entList: Entity[] = []
    for (const [id, e] of Object.entries(incoming.entities)) {
      entList.push({
        id,
        type: normalizeType(e?.type || id.split(":")[0]),
        attrs: e?.attrs || {},
        evidence: Array.isArray(e?.evidence) ? e!.evidence : []
      })
    }
    await upsertEntities(projectId, entList)
  }

  // merge threads
  if (Array.isArray(incoming.threads)) {
    for (const t of incoming.threads) {
      await upsertThread(projectId, {
        name: t?.name || "",
        status: (t?.status === "closed" ? "closed" : "open"),
        notes: t?.notes,
        hooks: Array.isArray(t?.hooks) ? t!.hooks : [],
        todos: Array.isArray(t?.todos) ? t!.todos : []
      })
    }
  }

  // merge style
  const cur = await getBible(projectId)
  cur.style = { ...(cur.style || {}), ...(incoming.style || {}) }
  await putBible(cur)
}

/** List all projectIds currently stored (for debug/tools) */
export async function listProjectIds(): Promise<string[]> {
  const all = await getAll()
  return Object.keys(all)
}

/** Clear a project Bible (dangerous) */
export async function clearBible(projectId: string) {
  const all = await getAll()
  delete all[projectId]
  await saveAll(all)
}

/** Compact snapshot for LLM grounding (keeps size sane) */
export async function getSnapshotForLLM(
  projectId: string,
  opts: { maxEntities?: number; maxAttrsPerEntity?: number } = {}
) {
  const { maxEntities = 60, maxAttrsPerEntity = 6 } = opts
  const b = await getBible(projectId)

  // crude prioritization: entities with the most evidence first
  const ents = Object.values(b.entities)
    .sort((a, z) => (z.evidence?.length || 0) - (a.evidence?.length || 0))
    .slice(0, maxEntities)
    .map((e) => {
      const picked: Record<string, string | string[]> = {}
      const keys = Object.keys(e.attrs || {}).slice(0, maxAttrsPerEntity)
      for (const k of keys) picked[k] = e.attrs[k]
      return {
        id: e.id,
        type: e.type,
        attrs: picked
      }
    })

  const threads = b.threads.slice(-20).map((t) => ({
    name: t.name,
    status: t.status,
    notes: t.notes,
    hooks: (t.hooks || []).slice(0, 6)
  }))

  return { entities: ents, threads, style: b.style, updatedAt: b.updatedAt }
}
