// server.js
require("dotenv").config()
const express = require("express")
const cors = require("cors")
const OpenAI = require("openai")
const fs = require("fs")
const path = require("path")

/* =============================================================================
   Boot
============================================================================= */
const app = express()

// allow large-ish payloads from your doc
app.use(express.json({ limit: "1mb" }))
// default cors() => Access-Control-Allow-Origin: *
app.use(cors())


app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "StoryLens",
    uptime: process.uptime(),
    version: process.env.npm_package_version || "0.0.0"
  })
})



const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const PORT = process.env.PORT || 3001

/* =============================================================================
   Shared helpers
============================================================================= */

function sliceByChars(text, max = 8000) {
  if (!text) return ""
  if (text.length <= max) return text
  // try to cut on a paragraph boundary
  const cut = text.lastIndexOf("\n\n", max)
  return text.slice(0, (cut > 2000 ? cut : max))
}

// robust JSON catcher: grabs the first {...} or [...] block if model adds prose
function bestEffortParseJSON(raw) {
  if (!raw || typeof raw !== "string") return null
  try {
    return JSON.parse(raw)
  } catch (_) {
    const m = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (m) {
      try { return JSON.parse(m[1]) } catch {}
    }
  }
  return null
}

// unified OpenAI call with rigid “JSON ONLY” instruction
async function askJSON({ system, user, model = "gpt-4o-mini", max_tokens = 900, temperature = 0.2 }) {
  const completion = await openai.chat.completions.create({
    model,
    temperature,
    max_tokens,
    response_format: { type: "json_object" }, // nudge for JSON-only
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user }
    ]
  })
  const raw = completion?.choices?.[0]?.message?.content?.trim() || ""
  return bestEffortParseJSON(raw)
}

/* simple healthcheck */
app.get("/", (_req, res) => res.json({ ok: true, service: "StoryLens", ts: Date.now() }))

/* =============================================================================
   1) /api/analyze  — plot/character/pacing issues
   Response: { issues: [{ type, severity, description, whereHint? }] }
============================================================================= */
app.post("/api/analyze", async (req, res) => {
  try {
    const text = String(req.body?.text || "")
    const bibleFacts = req.body?.bibleFacts || null

    if (text.length < 50) return res.json({ issues: [] })
    const excerpt = sliceByChars(text, 8000)

    // Build a compact “Writer’s Bible” string for the model
    let bibleContext = ""
    if (bibleFacts) {
      try {
        const ents = (bibleFacts.entities || [])
          .slice(0, 30)
          .map((e) => {
            const attrs = JSON.stringify(e.attrs || {}).slice(0, 200)
            return `${e.id}: ${attrs}`
          })
          .join("\n")

        const threads = (bibleFacts.threads || [])
          .slice(0, 12)
          .map((t) =>
            `• "${t.name}" (${t.status}) ${t.notes ? "- " + String(t.notes).slice(0, 160) : ""}`
          )
          .join("\n")

        const style = bibleFacts.style ? JSON.stringify(bibleFacts.style).slice(0, 400) : ""

        bibleContext =
          `ENTITIES:\n${ents || "(none)"}\n\nTHREADS:\n${threads || "(none)"}\n\nSTYLE:\n${style || "(none)"}`
      } catch {}
    }

    const payload = await askJSON({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 800,
      system: "You are StoryLens, a story-aware AI that remembers the writer's world. Reference the Bible naturally, like a beta reader who knows this story intimately. Be specific, not generic.",
      user:
`${bibleContext ? `WRITER'S BIBLE (use these exact names/details; don't contradict):\n${bibleContext}\n\n` : ""}Analyze this story excerpt and return JSON ONLY with:
{
  "issues": [
    { 
      "type": "character|plot|pacing|continuity", 
      "severity": "low|medium|high", 
      "description": "specific, actionable, and—when relevant—explicitly reference Bible entities by name", 
      "whereHint": 0.0
    }
  ]
}

 When analyzing:
- Reference Bible entities by name (e.g., "Mercy's shrinechild powers" not "the character's abilities")
- Flag continuity issues when the text contradicts Bible facts
- Suggest specific fixes that fit THIS story's world, not generic advice
- Sound like a beta reader who's been following this story, not a writing textbook

Text:
${excerpt}`
    })

    if (!payload || !Array.isArray(payload.issues)) {
      return res.json({ issues: [] })
    }

    const safe = {
      issues: payload.issues.slice(0, 100).map((x) => ({
        type: String(x.type || "analysis"),
        severity: ["low", "medium", "high"].includes(String(x.severity || "").toLowerCase())
          ? String(x.severity).toLowerCase()
          : "low",
        description: String(x.description || "").slice(0, 600),
        whereHint: Number.isFinite(x?.whereHint)
          ? Math.max(0, Math.min(1, Number(x.whereHint)))
          : undefined
      }))
    }

    res.json(safe)
  } catch (e) {
    console.error("[StoryLens backend] /api/analyze error:", e)
    res.json({ issues: [] })
  }
})


/* =============================================================================
   2) /api/scaffold  — Brain-Dump → Scaffold (+ Insert Headings)
   Request:  { projectId, text, keepVoice, context?: { keyphrases?: string, bibleFacts?: any } }
   Response: {
     outline: [{ h2: string, h3?: string[] }],
     openQuestions: string[],
     nextActions: string[],
     invented_facts: string[]
   }
============================================================================= */
app.post("/api/scaffold", async (req, res) => {
  try {
    const { projectId, text, keepVoice, context } = req.body || {}
    const src = sliceByChars(String(text || ""), 8000)
    if (!src) return res.json({ outline: [], openQuestions: [], nextActions: [], invented_facts: [] })

    const keyphrases = context?.keyphrases ? String(context.keyphrases) : ""
    const bibleBrief = context?.bibleFacts ? JSON.stringify(context.bibleFacts).slice(0, 1200) : ""

    const payload = await askJSON({
      model: "gpt-4o-mini",
      temperature: keepVoice ? 0.2 : 0.4,
      max_tokens: 1000,
      system:
`You are StoryLens, structuring messy creative notes into a clean scaffold.
Return ONLY JSON. Do not write prose. Do not add creative content.
If you must infer structure, clearly list possible invented facts in "invented_facts".`,
      user:
`PROJECT: ${projectId || "unknown"}

INPUT_NOTES (messy, unordered):
"""${src}"""

HINTS:
- keyphrases (approx.): ${keyphrases || "(none)"}
- bible snapshot (for grounding, do not modify): ${bibleBrief || "(none)"}

TASK:
1) Organize the notes into a practical outline (no rewriting tone). Use 2 levels only:
   outline: [ { "h2": "Chapter/Section title", "h3": ["beat", "beat", ...] }, ... ]
2) List openQuestions: points that need decisions or missing info.
3) List nextActions: small, concrete steps for the writer (e.g., "Draft scene: rooftop escape").
4) If you inferred anything that isn't supported by INPUT_NOTES or bible, add to invented_facts.

Return JSON EXACTLY as:
{
  "outline": [{ "h2": string, "h3": string[] }],
  "openQuestions": string[],
  "nextActions": string[],
  "invented_facts": string[]
}`
    })

    const safe = {
      outline: Array.isArray(payload?.outline) ? payload.outline.slice(0, 40).map(sec => ({
        h2: String(sec?.h2 || "").slice(0, 140),
        h3: Array.isArray(sec?.h3) ? sec.h3.slice(0, 20).map(s => String(s).slice(0, 140)) : []
      })) : [],
      openQuestions: Array.isArray(payload?.openQuestions) ? payload.openQuestions.slice(0, 30).map(s => String(s).slice(0, 200)) : [],
      nextActions: Array.isArray(payload?.nextActions) ? payload.nextActions.slice(0, 30).map(s => String(s).slice(0, 140)) : [],
      invented_facts: Array.isArray(payload?.invented_facts) ? payload.invented_facts.slice(0, 20).map(s => String(s).slice(0, 200)) : []
    }

    res.json(safe)
  } catch (e) {
    console.error("[StoryLens backend] /api/scaffold error:", e)
    res.json({ outline: [], openQuestions: [], nextActions: [], invented_facts: [] })
  }
})

/* =============================================================================
   3) /api/reverse — Reverse Outline (+ Insert TODOs)
   Request:  { projectId, chapterText, framework, sceneBreaks?: number[], bibleFacts?: any }
   Response: {
     structure: "Three-Act"|"Story Circle"|"Save the Cat"|string,
     beats: [{ name: string, evidence: string }],
     arcs: [{ character: string, arc: string }],
     themes: string[],
     gaps: [{ missing: string, suggestion: string, whereHint?: number }],
     invented_facts: string[]
   }
============================================================================= */
app.post("/api/reverse", async (req, res) => {
  try {
    const { projectId, chapterText, framework, sceneBreaks, bibleFacts } = req.body || {}
    const chapter = sliceByChars(String(chapterText || ""), 8000)
    if (!chapter) {
      return res.json({
        structure: String(framework || "Three-Act"),
        beats: [], arcs: [], themes: [],
        gaps: [], invented_facts: []
      })
    }

    const frameworkName =
      framework === "stc" ? "Save the Cat" :
      framework === "circle" ? "Story Circle" :
      "Three-Act"

    const breaks = Array.isArray(sceneBreaks) ? sceneBreaks.slice(0, 100) : []
    const bibleBrief = bibleFacts ? JSON.stringify(bibleFacts).slice(0, 1400) : ""

    const payload = await askJSON({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 1200,
      system:
`You are StoryLens. Reverse-engineer structure strictly from provided text.
Return ONLY JSON. If you must guess beyond evidence, note those guesses in "invented_facts".`,
      user:
`PROJECT: ${projectId || "unknown"}

FRAMEWORK: ${frameworkName}

CHAPTER_TEXT:
"""${chapter}"""

SCENE_BREAK_INDICES (0-based char offsets, approximate):
${JSON.stringify(breaks)}

BIBLE SNAPSHOT (for grounding; don't contradict):
${bibleBrief || "(none)"}

TASK:
1) Detect structure using the chosen framework. Use exact string for "structure".
2) Extract beats with direct quotes/phrases as "evidence" (short snippets).
3) Summarize character arcs found in this chapter only.
4) Extract themes present in this chapter only.
5) Propose concrete gaps as TODOs:
   { "missing": "what's missing", "suggestion": "what to add", "whereHint": 0..1 }
   whereHint is a fraction through the chapter to jump near.
6) Anything not supported by chapter text → put in "invented_facts".

Return JSON EXACTLY as:
{
  "structure": string,
  "beats": [{ "name": string, "evidence": string }],
  "arcs": [{ "character": string, "arc": string }],
  "themes": string[],
  "gaps": [{ "missing": string, "suggestion": string, "whereHint": number }],
  "invented_facts": string[]
}`
    })

    // sanitize + clamp
    const safe = {
      structure: String(payload?.structure || frameworkName).slice(0, 60),
      beats: Array.isArray(payload?.beats) ? payload.beats.slice(0, 40).map(b => ({
        name: String(b?.name || "").slice(0, 120),
        evidence: String(b?.evidence || "").slice(0, 240)
      })) : [],
      arcs: Array.isArray(payload?.arcs) ? payload.arcs.slice(0, 30).map(a => ({
        character: String(a?.character || "").slice(0, 80),
        arc: String(a?.arc || "").slice(0, 200)
      })) : [],
      themes: Array.isArray(payload?.themes) ? payload.themes.slice(0, 20).map(s => String(s).slice(0, 80)) : [],
      gaps: Array.isArray(payload?.gaps) ? payload.gaps.slice(0, 30).map(g => ({
        missing: String(g?.missing || "").slice(0, 140),
        suggestion: String(g?.suggestion || "").slice(0, 220),
        whereHint: Number.isFinite(g?.whereHint) ? Math.max(0, Math.min(1, Number(g.whereHint))) : 0.5
      })) : [],
      invented_facts: Array.isArray(payload?.invented_facts) ? payload.invented_facts.slice(0, 20).map(s => String(s).slice(0, 200)) : []
    }

    res.json(safe)
  } catch (e) {
    console.error("[StoryLens backend] /api/reverse error:", e)
    res.json({
      structure: String(req.body?.framework || "Three-Act"),
      beats: [], arcs: [], themes: [],
      gaps: [], invented_facts: []
    })
  }
})

/* =============================================================================
   4) /api/chat — lightweight chat grounded by Bible snapshot
   Body: { projectId, message, history?: [{role, content}], bibleFacts?: any }
   Returns: { reply }
============================================================================= */
app.post("/api/chat", async (req, res) => {
  try {
    const { projectId, message, history = [], bibleFacts } = req.body || {}
    if (!message || String(message).trim().length === 0) {
      return res.json({ reply: "" })
    }

    const bibleBrief = bibleFacts ? JSON.stringify(bibleFacts).slice(0, 2500) : ""
    const messages = [
      {
        role: "system",
        content:
          "You are StoryLens, a collaborative story organizer. Be concise, ask clarifying questions, never overwrite the author's style."
      },
      ...(Array.isArray(history) ? history.slice(-8) : []),
      {
        role: "user",
        content:
          `PROJECT: ${projectId || "unknown"}\n\n` +
          (bibleBrief ? `BIBLE SNAPSHOT (for grounding): ${bibleBrief}\n\n` : "") +
          `MESSAGE:\n${String(message)}`
      }
    ]

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 400,
      messages
    })

    const reply = completion?.choices?.[0]?.message?.content?.trim() || ""
    res.json({ reply })
  } catch (e) {
    console.error("[StoryLens backend] /api/chat error:", e)
    res.json({ reply: "" })
  }
})

/* =============================================================================
   5) /api/chat-extract — extract entities/threads from a single exchange
   Body: { projectId, userMessage, assistantReply, bibleFacts }
   Returns: { entities: [...], threads: [...] }
============================================================================= */
app.post("/api/chat-extract", async (req, res) => {
  try {
    const { projectId, userMessage = "", assistantReply = "", bibleFacts } = req.body || {}

    const payload = await askJSON({
      model: "gpt-4o-mini",
      temperature: 0.1,
      max_tokens: 900,
      system:
        "Extract entities and threads from this conversation. Return ONLY JSON with fields exactly as specified. Do not repeat existing Bible entries.",
      user:
`PROJECT: ${projectId || "unknown"}

CONVERSATION:
User: ${String(userMessage)}
Assistant: ${String(assistantReply)}

EXISTING_BIBLE:
${JSON.stringify(bibleFacts || {}).slice(0, 2400)}

CRITICAL RULES:
1. Only extract what the USER stated as fact about their story
2. Ignore questions, clarifications, or requests from the assistant
3. If the user ANSWERED a question with new info, extract that answer
4. If assistant just asked questions and user hasn't answered yet, extract NOTHING

BAD examples (don't extract):
- Assistant asks: "What motivates Mercy?" → Extract nothing (it's a question)
- Thread: "Clarification requested" → Extract nothing (meta-conversation)

GOOD examples (do extract):
- User says: "Mercy is motivated by guilt" → Extract attr "motivation": "guilt"
- User says: "The Sacred is a mountain ascent metaphor" → Extract Concept:Sacred

If the conversation is just setup/questions with no new story facts established, return empty arrays.

Return JSON:
{
  "entities": [{ "id": "...", "type": "...", "attrs": {...}, "evidence": [...] }],
  "threads": [{ "name": "...", "status": "open", "notes": "..." }]
}`
    })

    const safe = {
      entities: Array.isArray(payload?.entities)
        ? payload.entities.slice(0, 40).map(e => ({
            id: String(e?.id || "").slice(0, 120),
            type: ["Character","Location","Object","Rule","Concept"].includes(e?.type) ? e.type : "Concept",
            attrs: typeof e?.attrs === "object" && e?.attrs ? e.attrs : {},
            evidence: Array.isArray(e?.evidence)
              ? e.evidence.slice(0, 6).map(ev => ({ quote: String(ev?.quote || "").slice(0, 240) }))
              : []
          }))
        : [],
      threads: Array.isArray(payload?.threads)
        ? payload.threads.slice(0, 30).map(t => ({
            name: String(t?.name || "").slice(0, 140),
            status: (t?.status === "closed" ? "closed" : "open"),
            notes: String(t?.notes || "").slice(0, 400)
          }))
        : []
    }

    res.json(safe)
  } catch (e) {
    console.error("[StoryLens backend] /api/chat-extract error:", e)
    res.json({ entities: [], threads: [] })
  }
})

/* =============================================================================
   6) /api/feedback — capture user decisions for issues (console + JSONL file)
   Body: { projectId, issueId, action, userText?, context? }
   Returns: { ok: true }
============================================================================= */
const FEEDBACK_DIR = path.join(process.cwd(), "data")
const FEEDBACK_LOG = path.join(FEEDBACK_DIR, "feedback.jsonl")

function appendJSONL(file, obj) {
  try {
    if (!fs.existsSync(FEEDBACK_DIR)) fs.mkdirSync(FEEDBACK_DIR, { recursive: true })
    fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8")
  } catch (e) {
    console.warn("FEEDBACK write failed:", e?.message || e)
  }
}

app.post("/api/feedback", async (req, res) => {
  try {
    const { projectId, issueId, action, userText, context } = req.body || {}
    const payload = {
      ts: Date.now(),
      projectId: String(projectId || ""),
      issueId,
      action, // "accepted" | "modified" | "rejected"
      userText: typeof userText === "string" ? userText.slice(0, 1000) : undefined,
      context: context || {}
    }
    console.log("[FEEDBACK]", payload)
    appendJSONL(FEEDBACK_LOG, payload)
    res.json({ ok: true })
  } catch (e) {
    console.error("[StoryLens backend] /api/feedback error:", e)
    res.json({ ok: false })
  }
})

/* =============================================================================
   Listen
============================================================================= */
app.listen(PORT, () => {
  console.log(`StoryLens backend running on :${PORT}`)
})
