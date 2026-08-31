import net from "net";
import os from "os";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import UlanziApi from "./libs/ulanziApi.js";

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // plugin root
const UUID = "com.ulanzi.ulanzistudio.herdrstatus";
const DEFAULT_SOCK = process.env.HERDR_SOCKET_PATH ||
  path.join(os.homedir(), ".config", "herdr", "herdr.sock");

const $UD = new UlanziApi();
const buttons = {}; // context -> { op | index, session }

// serialize herdr operations per session: knob spins and rapid presses run in order,
// and a dead remote session's timeouts never stall the local page
const chains = {};
const pendingOps = {};
function enqueue(sess, fn) {
  const key = sess || "local";
  pendingOps[key] = (pendingOps[key] || 0) + 1;
  const run = async () => { try { await fn(); } finally { pendingOps[key]--; } };
  chains[key] = (chains[key] || Promise.resolve()).catch(() => {}).then(run);
  return chains[key];
}

// ---------------- sessions ----------------
// "local" is always the default herdr socket. Extra sessions come from
// <plugin>/sessions.json:  { "sessions": { "<name>": { "host": "<ssh host>", "remote_sock": "<path>" } } }
// Buttons reference sessions by name (ActionParam.session), so switching servers is a config edit only.
const SESSIONS_PATH = path.join(PLUGIN_DIR, "sessions.json");
let SESSIONS = { local: { sock: DEFAULT_SOCK } };
function loadSessions() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8")); }
  catch { return; } // keep the last-good config: a half-written file must not collapse sessions to local
  const next = { local: { sock: DEFAULT_SOCK } };
  for (const [name, c] of Object.entries(cfg.sessions || {})) {
    if (!c.host || name === "local") continue;
    next[name] = {
      host: c.host,
      remoteSock: c.remote_sock || "/home/" + (c.user || "dylan") + "/.config/herdr/herdr.sock", // ssh -L needs an ABSOLUTE remote path
      sock: path.join(os.homedir(), ".config", "herdr", `deck-${name}.sock`),
    };
  }
  SESSIONS = next;
}

// ssh unix-socket forward per remote session, respawned when it drops
const tunnels = {}; // name -> { proc, lastTry }
function ensureTunnel(name) {
  const s = SESSIONS[name];
  if (!s?.host) return;
  const t = tunnels[name];
  if (t?.proc && t.proc.exitCode === null) return;
  if (t && Date.now() - t.lastTry < 5000) return; // don't hammer a dead host
  try { fs.unlinkSync(s.sock); } catch {}
  const proc = spawn("ssh", [
    "-o", "BatchMode=yes", "-o", "StreamLocalBindUnlink=yes",
    "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15",
    "-N", "-L", `${s.sock}:${s.remoteSock}`, s.host,
  ], { stdio: "ignore" });
  tunnels[name] = { proc, lastTry: Date.now() };
}
process.on("exit", () => { // take the tunnels down with us
  Object.values(tunnels).forEach((t) => { try { t.proc.kill(); } catch {} });
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(0));

// herdr closes the connection after each response, so: one connection per call
function herdrOnce(sockPath, method, params) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sockPath);
    c.setEncoding("utf8"); // avoid splitting multibyte UTF-8 across data chunks
    let buf = "";
    const t = setTimeout(() => { c.destroy(); reject(new Error("timeout")); }, 2500);
    c.on("connect", () => c.write(JSON.stringify({ id: "r", method, params }) + "\n"));
    c.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        clearTimeout(t);
        c.end();
        try {
          const j = JSON.parse(buf.slice(0, i));
          j.error ? reject(new Error(j.error.message || j.error.code)) : resolve(j);
        } catch (e) { reject(e); }
      }
    });
    c.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function herdr(method, params = {}, sess = "local") {
  const info = SESSIONS[sess];
  if (!info) throw new Error(`unknown session '${sess}' (check sessions.json)`);
  if (info.host) ensureTunnel(sess);
  try {
    return await herdrOnce(info.sock, method, params);
  } catch (e) {
    if (info.host && /ENOENT|ECONNREFUSED/.test(String(e))) {
      // tunnel was just (re)spawned — give it a beat and retry once
      await new Promise((r) => setTimeout(r, 800));
      return herdrOnce(info.sock, method, params);
    }
    throw e;
  }
}

// ---------------- state ----------------
let wsBySess = { local: [] };
function usedSessions() {
  const used = new Set(["local"]);
  Object.values(buttons).forEach((b) => used.add(b.session));
  return [...used].filter((s) => SESSIONS[s]);
}

// space buttons count only MAIN spaces — linked-worktree workspaces are skipped,
// but their agent status rolls up into the parent project's button
const isMain = (w) => !(w.worktree && w.worktree.is_linked_worktree);
const spaces = (sess) => wsBySess[sess] || [];
const mainSpaces = (sess) => spaces(sess).filter(isMain);
function familyOf(main, sess) {
  const key = main.worktree?.repo_key;
  if (!key) return [main];
  return [main, ...spaces(sess).filter((w) => w.worktree?.is_linked_worktree && w.worktree.repo_key === key)];
}
function familyStatus(fam) {
  for (const st of ["blocked", "working", "idle", "done"]) {
    if (fam.some((w) => w.agent_status === st)) return st;
  }
  return "unknown";
}

function render(context) {
  const b = buttons[context];
  if (!b?.index) return;
  const ws = mainSpaces(b.session)[b.index - 1];
  const st = ws ? familyStatus(familyOf(ws, b.session)) : "unknown";
  if (b.last === st) return; // only repaint on change
  b.last = st;
  // number is baked into the icon: title/textData don't render over plugin icons in this app version
  $UD.setPathIcon(context, `${PLUGIN_DIR}/resources/state_${st}_${b.index}.png`);
}

let polling = false;
async function poll() {
  if (polling) return; // a slow (dead-remote) poll must not stack behind the 2s timer
  polling = true;
  try {
    const next = {};
    await Promise.all(usedSessions().map(async (sess) => {
      try {
        const r = await herdr("workspace.list", {}, sess);
        next[sess] = r.result?.workspaces || [];
      } catch {
        next[sess] = [];
      }
    }));
    wsBySess = next; // full swap: removed sessions don't leave frozen status behind
    Object.keys(buttons).forEach(render);
  } finally {
    polling = false;
  }
}

// create a workspace rooted at the folder the focused pane is currently in
async function createSpaceHere(sess) {
  let cwd = null;
  try {
    const r = await herdr("pane.current", {}, sess);
    cwd = r.result?.pane?.foreground_cwd || r.result?.pane?.cwd || null;
  } catch {}
  const r = await herdr("workspace.create", cwd ? { cwd } : {}, sess);
  return r.result?.workspace;
}

async function focusedWorkspace(sess) {
  const r = await herdr("workspace.list", {}, sess);
  return (r.result?.workspaces || []).find((w) => w.focused);
}

// ---------------- operations (all take the session name) ----------------
const OPS = {
  new_space: async (sess) => {
    const w = await createSpaceHere(sess);
    if (w) await herdr("workspace.focus", { workspace_id: w.workspace_id }, sess);
  },
  jump_blocked: async (sess) => {
    const r = await herdr("agent.list", {}, sess);
    const agents = r.result?.agents || [];
    const target = ["blocked", "idle", "working"]
      .map((st) => agents.find((a) => a.agent_status === st && !a.focused))
      .find(Boolean) || agents[0];
    if (target) await herdr("agent.focus", { target: target.pane_id }, sess);
  },
  new_worktree: async (sess) => {
    let ws = await focusedWorkspace(sess);
    if (!ws) return;
    const t = new Date();
    const pad = (v) => String(v).padStart(2, "0");
    const branch = `agent-${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
    try {
      await herdr("worktree.create", { workspace_id: ws.workspace_id, branch, focus: true }, sess);
    } catch (e) {
      if (!/git work tree/i.test(e.message)) throw e;
      // current space is not repo-rooted: make one from the pane's cwd, then retry there
      ws = await createSpaceHere(sess);
      if (!ws) throw e;
      await herdr("worktree.create", { workspace_id: ws.workspace_id, branch, focus: true }, sess);
    }
  },
  remove_worktree: async (sess) => {
    const ws = await focusedWorkspace(sess);
    if (!ws) return;
    await herdr("worktree.remove", { workspace_id: ws.workspace_id }, sess); // errors surface as a toast
    try { await herdr("workspace.close", { workspace_id: ws.workspace_id }, sess); } catch {}
  },
  new_tab: async (sess) => {
    const ws = await focusedWorkspace(sess);
    if (ws) await herdr("tab.create", { workspace_id: ws.workspace_id }, sess);
  },
  close_tab: async (sess) => {
    const ws = await focusedWorkspace(sess);
    if (ws) await herdr("tab.close", { tab_id: ws.active_tab_id }, sess);
  },
  split_v: (sess) => herdr("pane.split", { direction: "right" }, sess),
  split_h: (sess) => herdr("pane.split", { direction: "down" }, sess),
  close_pane: async (sess) => {
    const r = await herdr("pane.current", {}, sess);
    const p = r.result?.pane;
    if (p) await herdr("pane.close", { pane_id: p.pane_id }, sess);
  },
  zoom_pane: (sess) => herdr("pane.zoom", {}, sess),
  lazygit: async (sess) => {
    const ws = await focusedWorkspace(sess);
    if (!ws) return;
    const r = await herdr("tab.create", { workspace_id: ws.workspace_id }, sess);
    const tab = r.result?.tab, pane = r.result?.root_pane;
    if (tab) await herdr("tab.focus", { tab_id: tab.tab_id }, sess);
    if (pane) {
      await new Promise((res) => setTimeout(res, 400)); // let the shell start before typing
      await herdr("pane.send_text", { pane_id: pane.pane_id, text: "lazygit\n" }, sess);
    }
  },
  cycle_pane: (sess) => stepPane(1, sess),
  session_label: () => {}, // indicator only

};

async function stepAgent(d, sess) {
  const r = await herdr("agent.list", {}, sess);
  const agents = r.result?.agents || [];
  if (!agents.length) return;
  const i = Math.max(0, agents.findIndex((a) => a.focused));
  await herdr("agent.focus", { target: agents[(i + d + agents.length) % agents.length].pane_id }, sess);
}

async function stepPane(d, sess) {
  const ws = await focusedWorkspace(sess);
  if (!ws) return;
  const r = await herdr("pane.list", { tab_id: ws.active_tab_id }, sess);
  // pane.list returns panes from every workspace — filter to the current tab ourselves
  const panes = (r.result?.panes || []).filter((p) => p.tab_id === ws.active_tab_id);
  if (panes.length < 2) return;
  const i = Math.max(0, panes.findIndex((p) => p.focused));
  await herdr("pane.focus", { pane_id: panes[(i + d + panes.length) % panes.length].pane_id }, sess);
}

async function stepTab(d, sess) {
  const ws = await focusedWorkspace(sess);
  if (!ws) return;
  const r = await herdr("tab.list", { workspace_id: ws.workspace_id }, sess);
  const tabs = r.result?.tabs || [];
  const i = Math.max(0, tabs.findIndex((t) => t.focused));
  if (tabs.length > 1) {
    await herdr("tab.focus", { tab_id: tabs[(i + d + tabs.length) % tabs.length].tab_id }, sess);
  }
}

async function stepSpace(d, sess) {
  const list = spaces(sess);
  if (list.length < 2) return;
  const i = Math.max(0, list.findIndex((w) => w.focused));
  await herdr("workspace.focus", { workspace_id: list[(i + d + list.length) % list.length].workspace_id }, sess);
}

// ---------------- button registry ----------------
// Source of truth: our actions' settings from the profile manifests, keyed by
// ActionID — the app does not reliably deliver ActionParam in its events.
let byActionId = {};
function loadProfiles() {
  const root = path.join(os.homedir(), "Library/Application Support/Ulanzi/UlanziDeck/ProfilesV2");
  const next = {};
  try {
    for (const prof of fs.readdirSync(root)) {
      const pagesDir = path.join(root, prof, "Profiles");
      if (!fs.existsSync(pagesDir)) continue;
      for (const page of fs.readdirSync(pagesDir)) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(pagesDir, page, "manifest.json"), "utf8"));
          for (const ctrl of d.Controllers || []) {
            for (const a of Object.values(ctrl.Actions || {})) {
              if (a.Action?.startsWith(UUID)) next[a.ActionID] = a.ActionParam || {};
            }
          }
        } catch {}
      }
    }
    byActionId = next; // full rebuild: deleted buttons don't linger
  } catch {}
}

const OP_NAMES = ["split_v", "split_h", "close_pane", "cycle_pane", "zoom_pane",
  "new_tab", "close_tab", "jump_blocked", "new_worktree", "remove_worktree", "new_space", "lazygit",
  "knob_tabs", "knob_agents", "knob_panes", "knob_spaces", "session_label"];
// knob press falls through to an existing op
const KNOB_PRESS = { knob_tabs: "new_tab", knob_agents: "jump_blocked", knob_panes: "zoom_pane", knob_spaces: "new_space" };

function configFor(jsn) {
  // what the button does comes from the action UUID; where it acts (session) from stored settings
  const stored = { ...(byActionId[jsn.actionid] || {}), ...(jsn.param || {}) }; // fresh event param wins over the 30s disk cache
  const actionUuid = (jsn.uuid || jsn.context.split("___")[0] || "");
  const suffix = actionUuid.startsWith(UUID + ".") ? actionUuid.slice(UUID.length + 1) : "";
  const sp = /^space([1-9])$/.exec(suffix);
  const derived = sp ? { index: Number(sp[1]) } : (OP_NAMES.includes(suffix) ? { op: suffix } : {});
  return { ...stored, ...derived };
}

function register(jsn) {
  const p = configFor(jsn);
  const session = p.session || "local"; // keep the declared session even if unknown — ops then fail loudly instead of hitting local
  if (p.op) {
    buttons[jsn.context] = { op: p.op, session };
    let icon = p.op;
    if (p.op === "session_label") {
      icon = fs.existsSync(`${PLUGIN_DIR}/resources/label_${session}.png`) ? `label_${session}` : "label_remote";
    }
    $UD.setPathIcon(jsn.context, `${PLUGIN_DIR}/resources/${icon}.png`);
  } else {
    buttons[jsn.context] = { index: parseInt(p.index, 10) || 1, session };
    render(jsn.context);
  }
}

async function press(jsn) {
  if (!buttons[jsn.context]) register(jsn); // event may arrive before add (e.g. after plugin restart)
  const b = buttons[jsn.context];
  if (!b) return;
  const now = Date.now();
  if (now - (b.pressedAt || 0) < 200) return; // keydown and dialdown can both fire for one press
  b.pressedAt = now;
  await enqueue(b.session, async () => {
  try {
    if (b.op) await OPS[KNOB_PRESS[b.op] || b.op]?.(b.session);
    else {
      const main = mainSpaces(b.session);
      let ws = main[b.index - 1];
      // no such main space yet -> create until enough exist (worktree spaces don't count)
      for (let count = main.length; !ws && count < b.index && count < 9; count++) {
        const created = await createSpaceHere(b.session);
        if (!created) break;
        (wsBySess[b.session] ||= []).push(created); // next press sees it even before the poll returns
        if (count + 1 >= b.index) ws = created;
      }
      if (ws) {
        // land on an agent: blocked first, else the nearest one (main -> worktree1 -> worktree2 ...)
        const famIds = familyOf(ws, b.session).map((w) => w.workspace_id);
        let agents = [];
        try { agents = (await herdr("agent.list", {}, b.session)).result?.agents || []; } catch {}
        const inFam = agents.filter((a) => famIds.includes(a.workspace_id));
        let target = inFam.find((a) => a.agent_status === "blocked");
        if (!target) {
          for (const id of famIds) {
            target = inFam.find((a) => a.workspace_id === id);
            if (target) break;
          }
        }
        if (target) await herdr("agent.focus", { target: target.pane_id }, b.session);
        else await herdr("workspace.focus", { workspace_id: ws.workspace_id }, b.session);
      }
      poll(); // refresh status icons right away
    }
  } catch (e) {
    $UD.toast(`herdr: ${e.message}`);
  }
  });
}

function dial(jsn, d, hold) {
  if (!buttons[jsn.context]) register(jsn);
  const b = buttons[jsn.context];
  if (!b?.op) return;
  if ((pendingOps[b.session || "local"] || 0) > 3) return; // drop excess detents instead of queueing minutes of work
  return enqueue(b.session, async () => {
    try {
      if (b.op === "knob_tabs") await (hold && d < 0 ? OPS.close_tab(b.session) : stepTab(d, b.session));
      else if (b.op === "knob_agents") await stepAgent(d, b.session);
      else if (b.op === "knob_panes") await stepPane(d, b.session);
      else if (b.op === "knob_spaces") await stepSpace(d, b.session);
    } catch {}
  });
}

// ---------------- wiring ----------------
loadSessions();
loadProfiles();
setInterval(() => { loadSessions(); loadProfiles(); }, 30000); // pick up config/profile edits

$UD.connect(UUID);
$UD.onConnected(() => {});
$UD.onAdd(register);
$UD.onParamFromApp(register);
$UD.onParamFromPlugin(register);
$UD.onClear((jsn) => { (jsn.param || []).forEach((p) => delete buttons[p.context]); });
$UD.onKeyDown(press);
$UD.onDialDown(press);
$UD.onDialRotateLeft((jsn) => dial(jsn, -1, false));
$UD.onDialRotateRight((jsn) => dial(jsn, 1, false));
$UD.onDialRotateHoldLeft((jsn) => dial(jsn, -1, true));
$UD.onDialRotateHoldRight((jsn) => dial(jsn, 1, true));
$UD.onClose(() => process.exit(0)); // app is gone: die instead of lingering as a zombie

poll();
setInterval(poll, 2000);
