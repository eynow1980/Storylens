// src/background.ts
// ---------------------------------------------------------
// StoryLens MV3 service worker: OAuth + export + append text
// ---------------------------------------------------------

// message types
const EXPORT_REQUEST = "STORYLENS_EXPORT_REQUEST" as const
const CONNECT_REQUEST = "STORYLENS_CONNECT_REQUEST" as const
const TOGGLE_REQUEST  = "STORYLENS_TOGGLE_REQUEST" as const
const TOGGLE_PANEL    = "STORYLENS_TOGGLE" as const
const PING            = "SL_PING" as const
const INSERT_TEXT_REQUEST = "STORYLENS_INSERT_TEXT_REQUEST" as const

// logging helpers
const log  = (...a: any[]) => console.log("[SL/bg]", ...a)
const warn = (...a: any[]) => console.warn("[SL/bg]", ...a)
const err  = (...a: any[]) => console.error("[SL/bg]", ...a)

chrome.runtime.onInstalled.addListener(() => log("background installed"))

/* --------------------- OAuth helpers --------------------- */
async function getAuthToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError || new Error("No OAuth token"))
      } else { resolve(token) }
    })
  })
}
async function removeToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve())
  })
}

/* ---------------------- Fetch helpers -------------------- */
function driveExportURL(fileId: string) {
  const u = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}/export`)
  u.searchParams.set("mimeType", "text/plain")
  u.searchParams.set("alt", "media")
  u.searchParams.set("ts", String(Date.now()))
  return u.toString()
}
async function driveExportText(fileId: string, token: string): Promise<string> {
  const r = await fetch(driveExportURL(fileId), {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
      Accept: "text/plain"
    }
  })
  if (!r.ok) {
    const body = await r.text().catch(() => "")
    throw new Error(`drive export ${r.status}: ${body || r.statusText}`)
  }
  return r.text()
}

// Docs API flatten
type DocsParagraphElement = { textRun?: { content?: string | null } }
type DocsParagraph        = { elements?: DocsParagraphElement[] }
type DocsStructural       = { paragraph?: DocsParagraph }
type DocsResponse         = { body?: { content?: DocsStructural[] } }

async function docsGetFlatten(fileId: string, token: string): Promise<string> {
  const r = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" }
  })
  if (!r.ok) {
    const body = await r.text().catch(() => "")
    throw new Error(`docs api ${r.status}: ${body || r.statusText}`)
  }
  const j = (await r.json()) as DocsResponse
  const parts: string[] = []
  for (const block of j.body?.content ?? []) {
    const elements = block.paragraph?.elements ?? []
    let line = ""
    for (const el of elements) line += el.textRun?.content ?? ""
    if (line.trim()) parts.push(line)
  }
  return parts.join("\n")
}

// Append text at end of document
async function docsAppendText(fileId: string, token: string, text: string) {
  const r = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        { insertText: { endOfSegmentLocation: {}, text } }
      ]
    })
  })
  if (!r.ok) throw new Error(`batchUpdate ${r.status}: ${await r.text().catch(()=>r.statusText)}`)
}

/* -------------------- Panel toggle relay ----------------- */
async function forwardPanelToggle(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  await new Promise<void>((resolve) => {
    chrome.tabs.sendMessage(tab.id!, { type: TOGGLE_PANEL }, () => resolve())
  })
}

/* ------------------------- Router ------------------------ */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return

  if (message.type === PING) {
    sendResponse({ ok: true })
    return true
  }

  if (message.type === CONNECT_REQUEST) {
    ;(async () => {
      try {
        const token = await getAuthToken(true)
        log("connect ok, token len:", token?.length || 0)
        sendResponse({ ok: true })
      } catch (e) {
        err("connect error:", e)
        sendResponse({ ok: false, error: String(e) })
      }
    })()
    return true
  }

  if (message.type === EXPORT_REQUEST) {
    ;(async () => {
      const fileId = message.fileId as string
      try {
        let token = await getAuthToken(false).catch(() => getAuthToken(true))
        try {
          const text = await driveExportText(fileId, token)
          sendResponse({ ok: true, origin: "drive_export", text })
          return
        } catch (e1: any) {
          warn("drive export failed, trying docs api:", e1?.message || e1)
          try {
            const text = await docsGetFlatten(fileId, token)
            sendResponse({ ok: true, origin: "docs_api", text })
            return
          } catch (e2: any) {
            warn("docs api also failed, refresh token and retry once:", e2?.message || e2)
            await removeToken(token)
            token = await getAuthToken(true)
            try {
              const text = await driveExportText(fileId, token)
              sendResponse({ ok: true, origin: "drive_export", text })
              return
            } catch (e3) {
              const text = await docsGetFlatten(fileId, token)
              sendResponse({ ok: true, origin: "docs_api", text })
              return
            }
          }
        }
      } catch (e) {
        err("auth/export error:", e)
        sendResponse({ ok: false, error: String(e) })
      }
    })()
    return true
  }

  if (message.type === INSERT_TEXT_REQUEST) {
    ;(async () => {
      try {
        const fileId = message.fileId as string
        const text   = String(message.text || "")
        if (!fileId || !text) throw new Error("missing fileId/text")
        const token = await getAuthToken(false).catch(() => getAuthToken(true))
        await docsAppendText(fileId, token, text)
        sendResponse({ ok: true })
      } catch (e) {
        err("insert text error:", e)
        sendResponse({ ok: false, error: String(e) })
      }
    })()
    return true
  }

  if (message.type === TOGGLE_REQUEST) {
    forwardPanelToggle()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
})
