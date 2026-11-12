#!/usr/bin/env node
/**
 * yt-automation (Linux port) — YouTube TV add-on cancellation automation
 * ======================================================================
 * Linux equivalent of cancel-addons.mjs. Instead of the accessibility tree
 * (ocu), it drives an already-running Brave/Chrome over the Chrome DevTools
 * Protocol (CDP) on http://127.0.0.1:9222.
 *
 * Per run:
 *   1. Find (or open) the YouTube TV Membership → Subscriptions tab.
 *   2. Reload it so the add-on list is current.
 *   3. Every button whose accessible label starts with "Remove" is a pending
 *      add-on. Pick the first one and click it with trusted mouse events.
 *   4. Wait for the dialog, click the button "Yes, cancel".
 *   5. Wait for "Cancellation successful", reload, and verify the Remove
 *      button is gone.
 *   6. Stop after OCU_MAX_REMOVALS (default 1) or when nothing is pending.
 *
 * Safety:
 *   - Only ever clicks buttons labelled "Remove …" and "Yes, cancel".
 *   - Never clicks "Add" or the base plan (it has no Remove button).
 *   - One cancellation per run by default; no retry within a run.
 *   - Lock file prevents overlapping runs; stale locks (>30 min) are stolen.
 *   - OCU_SCAN_ONLY=1 reports what would be removed without clicking.
 *
 * Configuration (environment variables):
 *   CDP_PORT               default 9222
 *   TV_URL                 default https://tv.youtube.com/settings/subscriptions
 *   OCU_MAX_REMOVALS       default 1
 *   OCU_RUN_TIMEOUT_MS     default 180000
 *   OCU_SCAN_ONLY          "1" = scan & report only, never click
 *   OCU_AUTOMATION_DIR     where cancel-log.txt / run.lock live (default: script dir)
 */

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_DIR = process.env.OCU_AUTOMATION_DIR || SCRIPT_DIR;
const LOG_FILE = join(AUTOMATION_DIR, "cancel-log.txt");
const LOCK_FILE = join(AUTOMATION_DIR, "run.lock");
const REJECTION_FILE = join(AUTOMATION_DIR, "rejections.json");

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const TV_URL = process.env.TV_URL || "https://tv.youtube.com/settings/subscriptions";
// URL fragment used to pick the browser tab. Override only for local tests.
const URL_PATTERN = process.env.OCU_URL_PATTERN || "tv\\.youtube\\.com";
const URL_RE = new RegExp(URL_PATTERN);
const SCAN_ONLY = process.env.OCU_SCAN_ONLY === "1";
const MAX_REMOVALS_PER_RUN = Math.max(1, Number(process.env.OCU_MAX_REMOVALS || 1));
// YouTube refuses to cancel some trial add-ons server-side. By default the
// next 15-minute tick tries again (cooldown 0). Set OCU_REJECT_COOLDOWN_MIN
// to a positive number if you want to back off longer.
const REJECT_COOLDOWN_MS = Math.max(0, Number(process.env.OCU_REJECT_COOLDOWN_MIN ?? 0)) * 60 * 1000;
const RUN_TIMEOUT_MS = Number(process.env.OCU_RUN_TIMEOUT_MS || 180000);
const LOAD_TIMEOUT_MS = Number(process.env.OCU_LOAD_TIMEOUT_MS || 60000);
const CONFIRM_TIMEOUT_MS = Number(process.env.OCU_CONFIRM_TIMEOUT_MS || 20000);
const POLL_MS = 1000;
const STALE_LOCK_MS = 30 * 60 * 1000;

const BUTTONS_SELECTOR = 'button,[role="button"],tp-yt-paper-button';
const REMOVE_RE = /^remove\b/i;
const YES_CANCEL_RE = /^yes,?\s*cancel$/i;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function truncateLog() {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      renameSync(LOG_FILE, LOG_FILE + ".1");
    }
  } catch { /* ignore */ }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* ignore */ }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  try {
    closeSync(openSync(LOCK_FILE, "wx"));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(LOCK_FILE).mtimeMs > STALE_LOCK_MS) {
        unlinkSync(LOCK_FILE);
        closeSync(openSync(LOCK_FILE, "wx"));
        return true;
      }
    } catch { /* race */ }
    return false;
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

function loadRejections() {
  try {
    const raw = JSON.parse(readFileSync(REJECTION_FILE, "utf8"));
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const fresh = {};
    for (const [name, ts] of Object.entries(raw)) {
      if (typeof ts === "number" && ts > cutoff) fresh[name] = ts;
    }
    return fresh;
  } catch {
    return {};
  }
}

function saveRejections(rejections) {
  try { writeFileSync(REJECTION_FILE, JSON.stringify(rejections, null, 2)); } catch { /* ignore */ }
}

function minutesAgo(ts) {
  return Math.round((Date.now() - ts) / 60000);
}

function backoffNote() {
  return REJECT_COOLDOWN_MS > 0
    ? `backing off for ${Math.round(REJECT_COOLDOWN_MS / 60000)} min`
    : "will retry on the next 15-minute tick";
}

async function waitFor(fn, timeoutMs, what) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
      lastError = null;
    } catch (e) {
      lastError = e;
    }
    sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for ${what}${lastError ? ` (${lastError.message})` : ""}`);
}

async function fetchJson(path, options) {
  const res = await fetch(CDP_BASE + path, { ...options, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} for ${path}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Minimal CDP client (Node's built-in WebSocket, no dependencies)
// ---------------------------------------------------------------------------

class Cdp {
  static async connect(wsUrl) {
    const cdp = new Cdp(wsUrl);
    await cdp.open();
    return cdp;
  }

  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.ws = null;
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("could not open CDP websocket"));
      this.ws.onclose = () => {
        this.closed = true;
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error("CDP websocket closed"));
        }
        this.pending.clear();
      };
      this.ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg.id || !this.pending.has(msg.id)) return;
        const { resolve: resolvePending, reject: rejectPending } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rejectPending(new Error(msg.error.message || "CDP error"));
        else resolvePending(msg.result);
      };
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP socket is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error("page JavaScript error: " + detail);
    }
    return result.result?.value;
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function connectToTvPage() {
  let pages = (await fetchJson("/json/list")).filter((p) => p.type === "page");
  let page = pages.find((p) => URL_RE.test(p.url));

  if (!page) {
    log("no YouTube TV tab found — opening one");
    try {
      await fetchJson(`/json/new?${encodeURIComponent(TV_URL)}`, { method: "PUT" });
    } catch { /* old Chrome may need GET; fall through to polling */ }
    page = await waitFor(async () => {
      const now = (await fetchJson("/json/list")).filter((p) => p.type === "page");
      return now.find((p) => URL_RE.test(p.url)) || null;
    }, 15000, "a YouTube TV tab");
  }

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  try { await cdp.send("Page.bringToFront"); } catch { /* not fatal */ }
  return cdp;
}

async function reloadAndWait(cdp) {
  await cdp.send("Page.reload", { ignoreCache: true });
  // Page.reload resolves before the old document is torn down; give the
  // navigation a moment so we do not read the stale page as "loaded".
  sleep(1500);

  const state = await waitFor(async () => {
    const raw = await cdp.eval(`JSON.stringify({
      ready: document.readyState,
      len: document.body ? document.body.innerText.length : 0,
      url: location.href
    })`);
    const parsed = JSON.parse(raw);
    if (parsed.ready === "complete" && parsed.len > 1000) return parsed;
    return null;
  }, LOAD_TIMEOUT_MS, "the subscriptions page to load");

  if (/accounts\.google\.com/.test(state.url)) {
    throw new Error("signed out — YouTube TV redirected to Google sign-in; log in again in Brave");
  }
  if (!URL_RE.test(state.url)) {
    throw new Error(`unexpected page after reload: ${state.url}`);
  }

  // Best effort: wait for the add-on list. The page is a slow SPA, but the
  // actual scan below is authoritative, so a short miss here is not fatal.
  try {
    await waitFor(async () => {
      const n = await cdp.eval(`document.body.innerText.includes("Your add-ons")`);
      return n === true;
    }, 20000, "the add-on list to render");
  } catch { /* scan will report what is actually present */ }
}

async function findRemoveButtons(cdp) {
  return cdp.eval(`(() => {
    const seen = new Set();
    const out = [];
    for (const b of document.querySelectorAll(${JSON.stringify(BUTTONS_SELECTOR)})) {
      const aria = (b.getAttribute("aria-label") || "").trim();
      const text = (b.innerText || "").trim();
      const label = aria || text;
      if (!${REMOVE_RE.toString()}.test(label)) continue;
      if (b.getClientRects().length === 0) continue;
      const name = label.replace(/^remove\\s+/i, "").trim() || label;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, label });
    }
    return out;
  })()`);
}

async function elementRect(cdp, expression) {
  return cdp.eval(`(() => {
    const el = ${expression};
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
}

async function trustedClick(cdp, rect) {
  const x = rect.x + rect.w / 2;
  const y = rect.y + rect.h / 2;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function clickRemove(cdp, name) {
  const rect = await elementRect(cdp, `[...document.querySelectorAll(${JSON.stringify(BUTTONS_SELECTOR)})].find((b) => {
    const aria = (b.getAttribute("aria-label") || "").trim();
    const text = (b.innerText || "").trim();
    return aria === ${JSON.stringify("Remove " + name)} || text === "Remove";
  })`);
  if (!rect) throw new Error("could not locate the Remove button for: " + name);
  sleep(300); // let scrollIntoView settle
  await trustedClick(cdp, rect);
}

async function hasYesCancel(cdp) {
  return cdp.eval(`[...document.querySelectorAll(${JSON.stringify(BUTTONS_SELECTOR)})].some((b) => {
    if (b.getClientRects().length === 0) return false;
    const text = (b.innerText || "").trim();
    const aria = (b.getAttribute("aria-label") || "").trim();
    return ${YES_CANCEL_RE.toString()}.test(text) || ${YES_CANCEL_RE.toString()}.test(aria);
  })`);
}

// Polymer buttons respond reliably to element.click(). Using this for the
// dialog avoids missing the button while the dialog is still animating in.
async function clickYesCancel(cdp) {
  return cdp.eval(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(BUTTONS_SELECTOR)})].find((b) => {
      if (b.getClientRects().length === 0) return false;
      const text = (b.innerText || "").trim();
      const aria = (b.getAttribute("aria-label") || "").trim();
      return ${YES_CANCEL_RE.toString()}.test(text) || ${YES_CANCEL_RE.toString()}.test(aria);
    });
    if (!b) return false;
    b.click();
    return true;
  })()`);
}

async function bodyMentions(cdp, needle) {
  return cdp.eval(`document.body.innerText.includes(${JSON.stringify(needle)})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(AUTOMATION_DIR, { recursive: true });
  truncateLog();
  log(`=== run start (linux/cdp, scanOnly=${SCAN_ONLY}, max=${MAX_REMOVALS_PER_RUN}) ===`);

  if (!acquireLock()) {
    log("another run already in progress — skipping this tick");
    return;
  }

  let cdp = null;
  let removals = 0;
  let lastError = null;

  try {
    try {
      await fetchJson("/json/version");
    } catch {
      throw new Error(`Brave is not exposing CDP on ${CDP_BASE} — start it with run-check.sh / launch-brave.sh`);
    }

    cdp = await connectToTvPage();
    const started = Date.now();

    while (Date.now() - started < RUN_TIMEOUT_MS && removals < MAX_REMOVALS_PER_RUN) {
      try {
        await reloadAndWait(cdp);
      } catch (e) {
        lastError = "page load error: " + e.message;
        log(lastError);
        break;
      }

      const pending = await findRemoveButtons(cdp);
      if (pending.length === 0) {
        log("no pending Remove buttons found — nothing to do");
        break;
      }

      const rejections = loadRejections();
      const eligible = pending.filter((p) => {
        const ts = rejections[p.name];
        return !ts || Date.now() - ts >= REJECT_COOLDOWN_MS;
      });

      for (const p of pending) {
        const ts = rejections[p.name];
        if (ts && Date.now() - ts < REJECT_COOLDOWN_MS) {
          log(`skipping ${p.name} — YouTube rejected it ${minutesAgo(ts)} min ago (cooldown ${Math.round(REJECT_COOLDOWN_MS / 60000)} min)`);
        }
      }

      if (SCAN_ONLY) {
        log(`SCAN_ONLY: found ${pending.length} pending removal(s):`);
        for (const p of pending) log("  - " + p.name);
        break;
      }

      if (eligible.length === 0) {
        log("no eligible pending removals (all are inside the rejection cooldown) — nothing to do");
        break;
      }

      const target = eligible[0].name;
      log(`clicking Remove for: ${target}`);
      try {
        await clickRemove(cdp, target);
      } catch (e) {
        lastError = "click error: " + e.message;
        log(lastError);
        break;
      }

      // Wait for the confirmation dialog, a rejection, or the item vanishing.
      let confirmed = false;
      let rejected = false;
      const dialogDeadline = Date.now() + CONFIRM_TIMEOUT_MS;
      while (Date.now() < dialogDeadline) {
        sleep(POLL_MS);
        if (await bodyMentions(cdp, "error canceling your membership")) {
          rejected = true;
          break;
        }
        if (await hasYesCancel(cdp)) {
          log('confirming with "Yes, cancel"');
          sleep(300); // let the dialog finish animating
          await clickYesCancel(cdp);
          confirmed = true;
          break;
        }
        const stillThere = (await findRemoveButtons(cdp)).some((p) => p.name === target);
        if (!stillThere) {
          log("no dialog but item gone — counted as cancelled: " + target);
          removals += 1;
          confirmed = false;
          rejected = false;
          break;
        }
      }

      if (rejected) {
        rejections[target] = Date.now();
        saveRejections(rejections);
        log('YouTube rejected the cancellation ("error canceling your membership") — ' +
          backoffNote() + ": " + target);
        break;
      }
      if (!confirmed) {
        if (removals > 0) break; // item-gone path already counted
        log('no "Yes, cancel" dialog and item still present — stopping this run, will retry on next tick: ' + target);
        break;
      }

      // Wait for either the success toast or the error toast.
      const outcome = await waitFor(async () => {
        if (await bodyMentions(cdp, "Cancellation successful")) return "success";
        if (await bodyMentions(cdp, "error canceling your membership")) return "rejected";
        return null;
      }, 20000, "the cancellation result").catch(() => "timeout");

      if (outcome === "rejected") {
        rejections[target] = Date.now();
        saveRejections(rejections);
        log('YouTube rejected the cancellation ("error canceling your membership") — ' +
          backoffNote() + ": " + target);
        break;
      }
      if (outcome === "timeout") {
        log("no success message appeared — stopping this run, will retry on next tick: " + target);
        break;
      }

      removals += 1;
      delete rejections[target];
      saveRejections(rejections);
      log("cancellation submitted for: " + target + ` (total this run: ${removals})`);

      // Reload and verify that the Remove button is really gone.
      try {
        await reloadAndWait(cdp);
        const left = (await findRemoveButtons(cdp)).some((p) => p.name === target);
        if (left) log("warning: Remove button for " + target + " is still present after reload");
        else log("verified removed: " + target);
      } catch (e) {
        log("verification reload failed (cancellation already accepted): " + e.message);
      }
    }

    if (lastError) log("run ended with issue: " + lastError);
    log(`=== run end (removals=${removals}) ===`);
    process.exitCode = lastError && removals === 0 ? 1 : 0;
  } catch (e) {
    lastError = e.message;
    log("fatal: " + (e && e.stack ? e.stack : String(e)));
    log(`=== run end (removals=${removals}) ===`);
    process.exitCode = 1;
  } finally {
    cdp?.close();
    releaseLock();
  }
}

main();
