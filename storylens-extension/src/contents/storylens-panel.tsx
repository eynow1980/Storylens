// src/contents/storylens-panel.tsx
import type { PlasmoCSConfig } from "plasmo"
import React from "react"

import {
  getBible,
  searchBible as bibleSearch,
  upsertEntity,
  upsertEntities,
  upsertThread,
  removeEntity,
  removeThread,
  getSnapshotForLLM
} from "../lib/bible"

/* =========================
   Plasmo content script cfg
   ========================= */
export const config: PlasmoCSConfig = {
  matches: ["https://docs.google.com/document/*"],
  run_at: "document_end",
  all_frames: false
}

/* =========================
   Types & constants
   ========================= */
type Source = "none" | "drive_export" | "docs_api" | "fallback"

type Issue = {
  type: string
  severity: "low" | "medium" | "high"
  description: string
  whereHint?: number
}

type Tab = "issues" | "structure" | "bible"

type EntityCard = {
  id: string
  type: "Character" | "Location" | "Rule" | "Object" | "Concept"
  attrs: Record<string, string | string[]>
  evidence?: { quote?: string; chapterId?: string }[]
}

type ThreadCard = {
  name: string
  status: "open" | "closed"
  notes?: string
  hooks?: number[]
  todos?: string[]
}

const STORAGE_KEY = "storylens-open"
const toggleKeyLabel = navigator.platform.toLowerCase().includes("mac")
  ? "Cmd+Shift+Y"
  : "Ctrl+Shift+Y"

const ANALYZE_URL = "http://localhost:3001/api/analyze"
const API_BASE = ANALYZE_URL.replace(/\/api\/.*$/, "") // -> http://localhost:3001

/* =========================
   Helpers
   ========================= */
const normalize = (v: string) => v.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()

function getDocId(): string | null {
  const m = location.pathname.match(/\/document\/d\/([^/]+)/)
  return m?.[1] ?? null
}

async function exportCanonical(): Promise<{ text: string; origin: Source } | null> {
  const id = getDocId()
  if (!id) return null
  try {
    const r = await chrome.runtime.sendMessage({
      type: "STORYLENS_EXPORT_REQUEST",
      fileId: id
    })
    if (r?.ok && r.text) {
      const origin = (r.origin as Source) ?? "drive_export"
      return { text: String(r.text), origin }
    }
  } catch {}
  return null
}

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) {
  let t: number | undefined
  return (...args: Parameters<T>) => {
    window.clearTimeout(t)
    t = window.setTimeout(() => fn(...args), ms)
  }
}

async function fetchJSON<T = any>(url: string, body: any): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
  if (!r.ok) throw new Error(`${url} ${r.status}`)
  return r.json()
}

// editor jump (best-effort)
function jumpToFraction(f: number) {
  const host = document.querySelector<HTMLElement>(".kix-appview-editor")
  if (!host) return
  const max = host.scrollHeight - host.clientHeight
  host.scrollTo({ top: Math.max(0, Math.min(max, f * max)), behavior: "smooth" })
}

async function copyToClipboard(s: string) {
  try {
    await navigator.clipboard.writeText(s)
    alert("Copied to clipboard")
  } catch {}
}

async function appendTextToDoc(md: string) {
  const id = getDocId()
  if (!id) return alert("No doc id")
  const r = await chrome.runtime.sendMessage({
    type: "STORYLENS_INSERT_TEXT_REQUEST",
    fileId: id,
    text: `\n\n${md}\n`
  })
  if (!r?.ok) alert(r?.error || "Could not append (connect Google?)")
}

/* =========================
   Live word count hook
   ========================= */
function useWordCount() {
  const [wc, setWc] = React.useState(0)
  const [src, setSrc] = React.useState<Source>("none")

  const runExport = React.useCallback(async () => {
    const res = await exportCanonical()
    if (res?.text != null) {
      const words = normalize(res.text).split(/\s+/).filter(Boolean)
      setWc(words.length)
      setSrc(res.origin)
    }
  }, [])

  const schedule = React.useMemo(() => debounce(runExport, 500), [runExport])

  React.useEffect(() => {
    window.addEventListener("keydown", schedule, true)
    window.addEventListener("input", schedule, true)

    const hookIframe = () => {
      const ifr = document.querySelector<HTMLIFrameElement>("iframe.docs-texteventtarget-iframe")
      if (ifr?.contentWindow) {
        ifr.contentWindow.addEventListener("keydown", schedule, true)
        ifr.contentWindow.addEventListener("input", schedule, true)
      }
    }
    hookIframe()
    const moHook = new MutationObserver(hookIframe)
    moHook.observe(document.body, { childList: true, subtree: true })

    const editor = document.querySelector<HTMLElement>(".kix-appview-editor") || document.body
    const mo = new MutationObserver(schedule)
    mo.observe(editor, { childList: true, characterData: true, subtree: true })

    const poll = window.setInterval(runExport, 4000)
    runExport()

    return () => {
      window.removeEventListener("keydown", schedule, true)
      window.removeEventListener("input", schedule, true)
      mo.disconnect()
      moHook.disconnect()
      window.clearInterval(poll)
    }
  }, [runExport, schedule])

  return { wc, src }
}

/* =========================
   Toolbar button injection
   ========================= */
const ensureToolbarButton = (toggle: () => void) => {
  let disposed = false
  const BTN_ID = "storylens-toolbar-btn"

  const inject = () => {
    if (disposed || document.getElementById(BTN_ID)) return

    const titlebar =
      document.querySelector<HTMLElement>("#docs-titlebar-container") ||
      document.querySelector<HTMLElement>(".docs-titlebar-container")
    if (!titlebar) return

    const row =
      titlebar.querySelector<HTMLElement>(".docs-titlebar-buttons") ||
      titlebar.querySelector<HTMLElement>(".docs-titlebar-right") ||
      titlebar

    const btn = document.createElement("button")
    btn.id = BTN_ID
    btn.type = "button"
    btn.textContent = "StoryLens"
    btn.title = `Toggle StoryLens (${toggleKeyLabel})`
    Object.assign(btn.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "0 14px",
      height: "32px",
      borderRadius: "16px",
      border: "1px solid #d1d5db",
      background: "#f8fafc",
      color: "#0f172a",
      fontWeight: "600",
      marginLeft: "12px",
      cursor: "pointer"
    } as CSSStyleDeclaration)
    btn.onclick = () => toggle()

    const share =
      row.querySelector('[aria-label*="Share"]') ||
      row.querySelector('[data-tooltip*="Share"]') ||
      row.querySelector('[guidedhelpid="share_button"]')

    if (share && share.parentElement === row) row.insertBefore(btn, share)
    else row.appendChild(btn)
  }

  inject()
  const mo = new MutationObserver(inject)
  mo.observe(document.body, { subtree: true, childList: true })
  const t = setInterval(inject, 800)
  setTimeout(() => clearInterval(t), 8000)

  return () => {
    disposed = true
    mo.disconnect()
    document.getElementById(BTN_ID)?.remove()
  }
}

/* =========================
   Structure types
   ========================= */
type ScaffoldRes = {
  outline: { h2: string; h3: string[] }[]
  openQuestions: string[]
  nextActions: string[]
  invented_facts: string[]
}
type ReverseRes = {
  structure: string
  beats: { name: string; evidence: string }[]
  arcs: { character: string; arc: string }[]
  themes: string[]
  gaps: { missing: string; suggestion: string; whereHint?: number }[]
  invented_facts: string[]
}

/* =========================
   Component
   ========================= */
export default function StoryLensPanel() {
  const [open, setOpen] = React.useState(false)
  const { wc, src } = useWordCount()
  const [tab, setTab] = React.useState<Tab>("issues")

  // OAuth connect button state
  const [authState, setAuthState] = React.useState<"idle" | "connecting" | "ok" | "err">("idle")
  const [authErr, setAuthErr] = React.useState<string | null>(null)

  // GPT analysis state
  const [issues, setIssues] = React.useState<Issue[]>([])
  const [analyzing, setAnalyzing] = React.useState(false)
  const [analysisErr, setAnalysisErr] = React.useState<string | null>(null)
  const [lastRun, setLastRun] = React.useState<number | null>(null)

  // Structure states
  const [notes, setNotes] = React.useState("")
  const [keepVoice, setKeepVoice] = React.useState(true)
  const [scaffold, setScaffold] = React.useState<ScaffoldRes | null>(null)

  const [framework, setFramework] =
    React.useState<"Three-Act" | "Story Circle" | "Save the Cat">("Three-Act")
  const [rev, setRev] = React.useState<ReverseRes | null>(null)
  const [structBusy, setStructBusy] = React.useState<"idle" | "scaffold" | "reverse">("idle")

  // Bible & chat states
  const [entities, setEntities] = React.useState<EntityCard[]>([])
  const [threads, setThreads] = React.useState<ThreadCard[]>([])
  const [bibleStatus, setBibleStatus] = React.useState<"local" | "connected">("local")
  const [q, setQ] = React.useState("")
  const [searching, setSearching] = React.useState(false)

  const [chatInput, setChatInput] = React.useState("")
  const [chatBusy, setChatBusy] = React.useState(false)
  const [chatHistory, setChatHistory] = React.useState<{ role: "user" | "assistant"; content: string }[]>([])

  // Ping service worker
  React.useEffect(() => {
    try {
      chrome.runtime.sendMessage({ type: "SL_PING" }, () => {})
    } catch {}
  }, [])

  React.useEffect(() => ensureToolbarButton(() => setOpen((v) => !v)), [])

  // FAB
  React.useEffect(() => {
    if (document.getElementById("storylens-fab")) return
    const fab = document.createElement("button")
    fab.id = "storylens-fab"
    fab.textContent = "SL"
    Object.assign(fab.style, {
      position: "fixed",
      right: "64px",
      bottom: "16px",
      zIndex: "2147483647",
      width: "40px",
      height: "40px",
      borderRadius: "20px",
      border: "1px solid #e5e7eb",
      background: "#fff",
      cursor: "pointer",
      boxShadow: "0 2px 10px rgba(0,0,0,.12)"
    } as CSSStyleDeclaration)
    fab.title = `Toggle StoryLens (${toggleKeyLabel})`
    fab.onclick = () => setOpen((v) => !v)
    document.body.appendChild(fab)
    return () => fab.remove()
  }, [])

  // keyboard + persisted state
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const wantsToggle = e.shiftKey && e.key.toLowerCase() === "y"
      const mod = toggleKeyLabel.startsWith("Cmd") ? e.metaKey : e.ctrlKey
      if (mod && wantsToggle) {
        setOpen((v) => !v)
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener("keydown", onKey, true)
    if (sessionStorage.getItem(STORAGE_KEY) === "1") setOpen(true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])
  React.useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, open ? "1" : "0")
  }, [open])

  // OAuth connect
  const onConnect = async () => {
    setAuthErr(null)
    setAuthState("connecting")
    try {
      const r = await chrome.runtime.sendMessage({ type: "STORYLENS_CONNECT_REQUEST" })
      if (r?.ok) setAuthState("ok")
      else {
        setAuthState("err")
        setAuthErr(r?.error || "Unknown error")
      }
    } catch (e) {
      setAuthState("err")
      setAuthErr(e instanceof Error ? e.message : String(e))
    }
  }

  // Analyze flow (Bible-aware)
  const analyzeStory = React.useCallback(async () => {
    setAnalysisErr(null)
    setAnalyzing(true)
    try {
      const res = await exportCanonical()
      const text = res?.text || ""
      if (!text || text.length < 50) {
        setIssues([])
        setLastRun(Date.now())
        setAnalyzing(false)
        return
      }

      const pid = getDocId()
      const bibleFacts = pid ? await getSnapshotForLLM(pid) : null

      const r = await fetch(ANALYZE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, bibleFacts })
      })
      const data = await r.json().catch(() => ({}))
      const arr = Array.isArray(data?.issues) ? data.issues : []
      setIssues(arr)
      setLastRun(Date.now())
    } catch (e) {
      setAnalysisErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAnalyzing(false)
    }
  }, [])

  // Structure actions
  async function runScaffold() {
    setStructBusy("scaffold")
    try {
      const res = await exportCanonical()
      const baseText = res?.text || ""
      const text = notes.trim() ? notes : baseText
      const payload = await fetchJSON<ScaffoldRes>(`${API_BASE}/api/scaffold`, {
        projectId: getDocId(),
        text,
        keepVoice,
        context: {}
      })
      setScaffold(payload)
    } catch (e) {
      alert("Scaffold failed")
    } finally {
      setStructBusy("idle")
    }
  }
  async function runReverse() {
    setStructBusy("reverse")
    try {
      const res = await exportCanonical()
      const payload = await fetchJSON<ReverseRes>(`${API_BASE}/api/reverse`, {
        projectId: getDocId(),
        chapterText: res?.text || "",
        framework
      })
      setRev(payload)
    } catch (e) {
      alert("Reverse outline failed")
    } finally {
      setStructBusy("idle")
    }
  }
  function outlineToMD(o: ScaffoldRes["outline"]) {
    return o
      .map((sec) => {
        const h2 = `## ${sec.h2}`
        const beats = (sec.h3 || []).map((b) => `- ${b}`).join("\n")
        return beats ? `${h2}\n${beats}` : h2
      })
      .join("\n\n")
  }
  async function insertHeadings() {
    if (!scaffold?.outline?.length) return
    const md = outlineToMD(scaffold.outline)
    await appendTextToDoc(md)
  }
  async function copyHeadings() {
    if (!scaffold?.outline?.length) return
    const md = outlineToMD(scaffold.outline)
    await copyToClipboard(md)
  }
  async function insertTodosFromGaps() {
    if (!rev?.gaps?.length) return
    const md = [
      "## Structure TODOs — open",
      ...rev.gaps.map(
        (g) =>
          `- ${g.missing}: ${g.suggestion}${
            typeof g.whereHint === "number" ? ` @~${Math.round((g.whereHint || 0) * 100)}%` : ""
          }`
      )
    ].join("\n")
    await appendTextToDoc(`\n${md}\n`)
  }
  function jumpNear(where?: number) {
    if (typeof where === "number") jumpToFraction(where)
  }

  /* =========================
     Issues feedback
     ========================= */
  async function sendFeedback(i: number, action: "accepted" | "modified" | "rejected", override?: string) {
    try {
      const it = issues[i]
      await fetch(`${API_BASE}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: getDocId(),
          issueId: i,
          action,
          userText: override || undefined,
          context: { issue: it, genre: "unknown" }
        })
      })
    } catch {}
  }

  /* =========================
     Bible + Chat
     ========================= */
  async function refreshBible() {
    const pid = getDocId()
    if (!pid) return
    const b = await getBible(pid)
    const ent = Object.values(b.entities)
      .sort((a, z) => (z.evidence?.length || 0) - (a.evidence?.length || 0))
      .slice(0, 400)
      .map((e) => ({
        id: e.id,
        type: e.type,
        attrs: e.attrs,
        evidence: (e.evidence || []).slice(-3)
      }))
    setEntities(ent as EntityCard[])
    setThreads(b.threads.slice(-200) as ThreadCard[])
    setBibleStatus("connected")
  }
  React.useEffect(() => {
    if (open) refreshBible()
  }, [open])

  const debouncedSearch = React.useMemo(
    () =>
      debounce(async (qq: string) => {
        const pid = getDocId()
        if (!pid) return
        setSearching(true)
        try {
          const { entities: ent, threads: thr } = await bibleSearch(pid, qq)
          setEntities(
            ent.map((e: any) => ({
              id: e.id,
              type: e.type,
              attrs: e.attrs,
              evidence: (e.evidence || []).slice(-3)
            }))
          )
          setThreads(thr)
        } finally {
          setSearching(false)
        }
      }, 280),
    []
  )

  function onSearchChange(v: string) {
    setQ(v)
    debouncedSearch(v)
  }

  async function addSelectionToBible() {
    const s = window.getSelection()?.toString()?.trim()
    if (!s) return alert("Select text in the doc first")
    const name = prompt("Entity name:", s.slice(0, 60)) || s.slice(0, 60)
    const type = (prompt("Type? Character/Location/Rule/Object/Concept", "Character") || "Character") as
      | "Character"
      | "Location"
      | "Rule"
      | "Object"
      | "Concept"
    const note = prompt("Optional note:", "") || undefined
    const pid = getDocId()
    if (!pid) return
    await upsertEntity(pid, {
      id: `${type}:${name}`,
      type,
      attrs: note ? { notes: note } : {},
      evidence: [{ quote: s }]
    })
    await refreshBible()
  }

  async function sendChat() {
    if (!chatInput.trim() || chatBusy) return
    const pid = getDocId()
    if (!pid) return alert("No project/document id")
    setChatBusy(true)
    try {
      const userMsg = chatInput.trim()
      setChatInput("")
      setChatHistory((h) => [...h, { role: "user", content: userMsg }])

      const snapshot = await getSnapshotForLLM(pid)

      const reply = await fetchJSON<{ reply: string }>(`${API_BASE}/api/chat`, {
        projectId: pid,
        message: userMsg,
        context: snapshot
      })
      const assistantReply = (reply?.reply || "").trim()
      if (assistantReply) setChatHistory((h) => [...h, { role: "assistant", content: assistantReply }])

      const extracted = await fetchJSON<{ entities?: any[]; threads?: any[] }>(`${API_BASE}/api/chat-extract`, {
        projectId: pid,
        userMessage: userMsg,
        assistantReply,
        bibleFacts: snapshot
      })

      if (Array.isArray(extracted?.entities) && extracted.entities.length) {
        await upsertEntities(
          pid,
          extracted.entities.map((e: any) => ({
            id: e.id,
            type: e.type,
            attrs: e.attrs || {},
            evidence: Array.isArray(e.evidence) ? e.evidence : []
          }))
        )
      }
      if (Array.isArray(extracted?.threads)) {
        for (const t of extracted.threads) {
          await upsertThread(pid, {
            name: t.name,
            status: (t.status === "closed" ? "closed" : "open") as "open" | "closed",
            notes: t.notes,
            hooks: Array.isArray(t.hooks) ? t.hooks : [],
            todos: Array.isArray(t.todos) ? t.todos : []
          })
        }
      }

      await refreshBible()
    } catch {
      alert("Chat failed. Is the server running?")
    } finally {
      setChatBusy(false)
    }
  }

  // ---- Entity edit/delete ----
  async function handleEditEntity(e: EntityCard) {
    try {
      const text = prompt("Edit attributes (JSON):", JSON.stringify(e.attrs, null, 2))
      if (!text) return
      const parsed = JSON.parse(text)
      await upsertEntity(getDocId()!, { id: e.id, type: e.type as any, attrs: parsed, evidence: e.evidence || [] })
      await refreshBible()
    } catch {
      alert("Invalid JSON for attributes.")
    }
  }
  async function handleDeleteEntity(e: EntityCard) {
    if (!confirm(`Delete ${e.id}?`)) return
    await removeEntity(getDocId()!, e.id)
    await refreshBible()
  }

  // ---- Thread edit/delete ----
  async function handleEditThread(t: ThreadCard) {
    const name = prompt("Thread name:", t.name) || t.name
    const status = (prompt('Status ("open" or "closed"):', t.status) || t.status) as "open" | "closed"
    const notes = prompt("Notes:", t.notes || "") || undefined
    const todosCsv = prompt("Todos (comma-separated):", (t.todos || []).join(", ")) || ""
    const todos = todosCsv.split(",").map((s) => s.trim()).filter(Boolean)
    await upsertThread(getDocId()!, { ...t, name, status, notes, todos })
    await refreshBible()
  }
  async function handleDeleteThread(t: ThreadCard) {
    if (!confirm(`Delete thread "${t.name}"?`)) return
    await removeThread(getDocId()!, t.name)
    await refreshBible()
  }

  if (!open) return null

  return (
    <div
      id="storylens-panel"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        height: "100vh",
        width: "360px",
        background: "#fff",
        color: "#111827",
        borderLeft: "1px solid #e5e7eb",
        zIndex: 2147483647,
        boxShadow: "0 0 20px rgba(0,0,0,.2)",
        pointerEvents: "auto",
        fontFamily: "Inter, system-ui, sans-serif",
        display: "flex",
        flexDirection: "column"
      }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: "1px solid #e5e7eb"
        }}>
        <div style={{ fontWeight: 600 }}>StoryLens</div>
        <button
          onClick={() => setOpen(false)}
          title={`Close (${toggleKeyLabel})`}
          style={{
            padding: "4px 8px",
            fontSize: "12px",
            borderRadius: "6px",
            border: "1px solid #e5e7eb",
            background: "#fff",
            cursor: "pointer"
          }}>
          ×
        </button>
      </div>

      {/* Info + connect */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb" }}>
        <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 6 }}>
          Source: <b>{src}</b>
        </div>
        <div style={{ fontSize: 18, marginBottom: 10 }}>
          <span style={{ fontWeight: 600 }}>Word count: </span>
          {wc.toLocaleString()}
        </div>
        <button
          onClick={onConnect}
          disabled={authState === "connecting"}
          style={{
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid #e5e7eb",
            background: "#f8fafc",
            cursor: "pointer"
          }}>
          {authState === "connecting" ? "Connecting…" : "Connect Google (accurate export)"}
        </button>
        {authState === "ok" && <div style={{ color: "#059669", fontSize: 12, marginTop: 6 }}>Connected</div>}
        {authState === "err" && <div style={{ color: "#b91c1c", fontSize: 12, marginTop: 6 }}>{authErr}</div>}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderBottom: "1px solid #e5e7eb" }}>
        {(["issues", "structure", "bible"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              background: tab === t ? "#e5edff" : "#fff",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: 12
            }}>
            {t === "issues" ? "Issues" : t === "structure" ? "Structure" : "Bible"}
          </button>
        ))}
      </div>

      {/* Body */}
      <div style={{ padding: 12, overflow: "auto", flex: 1 }}>
        {/* ISSUES */}
        {tab === "issues" && (
          <div>
            <button
              onClick={analyzeStory}
              disabled={analyzing}
              style={{
                width: "100%",
                padding: 10,
                background: analyzing ? "#e5e7eb" : "#3b82f6",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontWeight: 600,
                cursor: analyzing ? "wait" : "pointer"
              }}>
              {analyzing ? "Analyzing…" : "Analyze Story"}
            </button>

            {analysisErr && <div style={{ color: "#b91c1c", fontSize: 12, marginTop: 8 }}>{analysisErr}</div>}

            {lastRun && (
              <div style={{ color: "#6b7280", fontSize: 11, marginTop: 6 }}>
                Last run: {new Date(lastRun).toLocaleTimeString()}
              </div>
            )}

            {issues.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
                  Issues Found ({issues.length})
                </div>
                {issues.map((it, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 10,
                      marginBottom: 8,
                      background: "#f9fafb",
                      borderRadius: 8,
                      borderLeft: `4px solid ${
                        it.severity === "high" ? "#ef4444" : it.severity === "medium" ? "#f59e0b" : "#10b981"
                      }`
                    }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{it.type}</span>
                      <span style={{ fontSize: 11, color: "#6b7280" }}>{it.severity}</span>
                      {typeof it.whereHint === "number" && (
                        <button
                          onClick={() => jumpNear(it.whereHint!)}
                          style={{
                            marginLeft: "auto",
                            fontSize: 11,
                            border: "1px solid #d1d5db",
                            borderRadius: 6,
                            padding: "2px 6px",
                            cursor: "pointer",
                            background: "#fff"
                          }}>
                          Jump
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>{it.description}</div>

                    {/* Feedback buttons */}
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button
                        onClick={() => sendFeedback(i, "accepted")}
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          border: "1px solid #10b981",
                          borderRadius: 6,
                          background: "#fff",
                          cursor: "pointer"
                        }}>
                        ✓ Accept
                      </button>
                      <button
                        onClick={() => {
                          const modified = prompt("How did you change it?", "") || ""
                          sendFeedback(i, "modified", modified)
                        }}
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          border: "1px solid #f59e0b",
                          borderRadius: 6,
                          background: "#fff",
                          cursor: "pointer"
                        }}>
                        ✎ Modified
                      </button>
                      <button
                        onClick={() => sendFeedback(i, "rejected")}
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          border: "1px solid #ef4444",
                          borderRadius: 6,
                          background: "#fff",
                          cursor: "pointer"
                        }}>
                        ✗ Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* STRUCTURE */}
        {tab === "structure" && (
          <div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Brain-Dump → Scaffold</div>
            <textarea
              placeholder="Paste messy notes (or leave empty to use the whole doc)…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              style={{
                width: "100%",
                minHeight: 90,
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                padding: 8,
                marginBottom: 8
              }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 8 }}>
              <input type="checkbox" checked={keepVoice} onChange={(e) => setKeepVoice(e.target.checked)} />
              Keep my voice (don’t rewrite tone)
            </label>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button
                onClick={runScaffold}
                disabled={structBusy !== "idle"}
                style={{
                  flex: 1,
                  padding: 10,
                  background: "#10b981",
                  color: "#fff",
                  borderRadius: 8,
                  border: "none",
                  fontWeight: 700,
                  cursor: structBusy !== "idle" ? "wait" : "pointer"
                }}>
                {structBusy === "scaffold" ? "Structuring…" : "Structure It"}
              </button>
              <button
                onClick={copyHeadings}
                disabled={!scaffold}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: "#fff",
                  fontWeight: 600,
                  cursor: scaffold ? "pointer" : "not-allowed"
                }}>
                Copy Headings
              </button>
              <button
                onClick={insertHeadings}
                disabled={!scaffold}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: "#fff",
                  fontWeight: 600,
                  cursor: scaffold ? "pointer" : "not-allowed"
                }}>
                Append Headings
              </button>
            </div>

            {scaffold && (
              <div
                style={{
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 14
                }}>
                {scaffold.outline.map((sec, i) => (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 700 }}>{sec.h2}</div>
                    <ul style={{ margin: "6px 0 0 16px" }}>
                      {(sec.h3 || []).map((b, j) => (
                        <li key={j} style={{ fontSize: 13 }}>
                          {b}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {scaffold.openQuestions?.length > 0 && (
                  <>
                    <div style={{ fontWeight: 700, marginTop: 8 }}>Open Questions</div>
                    <ul style={{ margin: "6px 0 0 16px" }}>
                      {scaffold.openQuestions.map((q, i) => (
                        <li key={i} style={{ fontSize: 13 }}>
                          {q}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, marginBottom: 6 }}>
              <select
                value={framework}
                onChange={(e) => setFramework(e.target.value as any)}
                style={{ flex: 1, padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 8 }}>
                <option>Three-Act</option>
                <option>Story Circle</option>
                <option>Save the Cat</option>
              </select>
              <button
                onClick={runReverse}
                disabled={structBusy !== "idle"}
                style={{
                  padding: "8px 10px",
                  background: "#3b82f6",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  fontWeight: 700,
                  cursor: structBusy !== "idle" ? "wait" : "pointer"
                }}>
                {structBusy === "reverse" ? "Analyzing…" : "Analyze Chapter"}
              </button>
            </div>

            {rev && (
              <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>{rev.structure}</div>
                {rev.beats.map((b, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <div style={{ fontWeight: 600 }}>{b.name}</div>
                    <div style={{ fontSize: 12, color: "#4b5563" }}>— “{b.evidence}”</div>
                  </div>
                ))}
                {rev.gaps.length > 0 && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                      <div style={{ fontWeight: 700 }}>Structure TODOs</div>
                      <button
                        onClick={insertTodosFromGaps}
                        style={{
                          padding: "6px 10px",
                          border: "1px solid #d1d5db",
                          borderRadius: 8,
                          background: "#fff",
                          fontWeight: 600,
                          cursor: "pointer"
                        }}>
                        Insert TODOs
                      </button>
                    </div>
                    <ul style={{ margin: "6px 0 0 16px" }}>
                      {rev.gaps.map((g, i) => (
                        <li key={i} style={{ marginBottom: 6 }}>
                          <span style={{ fontSize: 13 }}>
                            {g.missing}: {g.suggestion}
                            {typeof g.whereHint === "number" && ` @~${Math.round((g.whereHint || 0) * 100)}%`}
                          </span>
                          {typeof g.whereHint === "number" && (
                            <button
                              onClick={() => jumpNear(g.whereHint)}
                              style={{
                                marginLeft: 8,
                                fontSize: 11,
                                border: "1px solid #d1d5db",
                                borderRadius: 6,
                                padding: "1px 6px",
                                background: "#fff",
                                cursor: "pointer"
                              }}>
                              Jump
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* BIBLE (with chat) */}
        {tab === "bible" && (
          <div>
            {/* Search & quick actions */}
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                value={q}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={searching ? "Searching…" : "Search Bible…"}
                style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px" }}
              />
              <button
                onClick={addSelectionToBible}
                style={{
                  padding: "8px 10px",
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  background: "#fff",
                  fontWeight: 700,
                  cursor: "pointer"
                }}>
                + Selection
              </button>
            </div>

            <div style={{ color: bibleStatus === "connected" ? "#059669" : "#6b7280", fontSize: 12, marginBottom: 8 }}>
              {bibleStatus === "connected" ? "Project memory active" : "Local memory active"}
            </div>

            {/* Chat */}
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Chat</div>
              <div
                style={{
                  maxHeight: 180,
                  overflow: "auto",
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 8,
                  marginBottom: 8
                }}>
                {chatHistory.length === 0 && (
                  <div style={{ color: "#6b7280", fontSize: 12 }}>
                    Try: “Tell me about the main character’s motivation”
                  </div>
                )}
                {chatHistory.map((m, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, color: "#6b7280" }}>{m.role === "user" ? "You" : "StoryLens"}</div>
                    <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{m.content}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      sendChat()
                    }
                  }}
                  placeholder="Ask about your world, characters, threads…"
                  style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px" }}
                />
                <button
                  onClick={sendChat}
                  disabled={chatBusy || !chatInput.trim()}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    background: chatBusy ? "#e5e7eb" : "#3b82f6",
                    color: "#fff",
                    fontWeight: 700,
                    border: "none",
                    cursor: chatBusy ? "wait" : "pointer"
                  }}>
                  {chatBusy ? "…" : "Send"}
                </button>
              </div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
                New facts & threads are auto-saved to your Bible.
              </div>
            </div>

            {/* Entities */}
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Entities</div>
            {entities.length === 0 && <div style={{ color: "#6b7280", fontSize: 12 }}>No entries yet.</div>}
            {entities.map((e) => (
              <div key={e.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{e.id.split(":")[1] || e.id}</div>
                    <div style={{ fontSize: 12, color: "#6b7280" }}>{e.type}</div>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      onClick={() => handleEditEntity(e)}
                      style={{ fontSize: 11, padding: "2px 6px", border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", cursor: "pointer" }}>
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeleteEntity(e)}
                      style={{ fontSize: 11, padding: "2px 6px", border: "1px solid #ef4444", borderRadius: 6, background: "#fff", cursor: "pointer", color: "#ef4444" }}>
                      ×
                    </button>
                  </div>
                </div>
                <div style={{ marginTop: 6 }}>
                  {Object.entries(e.attrs || {}).map(([k, v]) => (
                    <div key={k} style={{ fontSize: 12 }}>
                      <b>{k}:</b> {Array.isArray(v) ? (v as string[]).join(", ") : String(v)}
                    </div>
                  ))}
                </div>
                {e.evidence && e.evidence.length > 0 && (
                  <div style={{ marginTop: 6, fontSize: 12, color: "#4b5563" }}>
                    <div style={{ fontWeight: 600 }}>Evidence</div>
                    {e.evidence.map((ev, i) => (
                      <div key={i}>“{(ev.quote || "").slice(0, 120)}”{ev.chapterId ? ` — ${ev.chapterId}` : ""}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Threads */}
            <div style={{ fontWeight: 700, margin: "10px 0 6px" }}>Threads</div>
            {threads.length === 0 && <div style={{ color: "#6b7280", fontSize: 12 }}>No threads yet.</div>}
            {threads.map((t, i) => (
              <div key={`${t.name}-${i}`} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, marginBottom: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{t.name}</div>
                    <div
                      style={{
                        fontSize: 11,
                        padding: "0px 6px",
                        borderRadius: 999,
                        border: "1px solid #d1d5db",
                        background: t.status === "open" ? "#ecfeff" : "#f3f4f6",
                        display: "inline-block",
                        marginTop: 2
                      }}>
                      {t.status}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      onClick={() => handleEditThread(t)}
                      style={{ fontSize: 11, padding: "2px 6px", border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", cursor: "pointer" }}>
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeleteThread(t)}
                      style={{ fontSize: 11, padding: "2px 6px", border: "1px solid #ef4444", borderRadius: 6, background: "#fff", cursor: "pointer", color: "#ef4444" }}>
                      ×
                    </button>
                  </div>
                </div>
                {t.notes && <div style={{ fontSize: 13, marginTop: 4 }}>{t.notes}</div>}
                {Array.isArray(t.todos) && t.todos.length > 0 && (
                  <ul style={{ margin: "6px 0 0 16px" }}>
                    {t.todos.map((x, j) => (
                      <li key={j} style={{ fontSize: 13 }}>{x}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
