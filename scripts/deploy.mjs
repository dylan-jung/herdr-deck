#!/usr/bin/env node
// Build the plugin into .dist/ and install a real copy into Ulanzi Studio's Plugins folder.
//
//   npm run build              bundle only (.dist/)
//   npm run deploy             build + install + restart Ulanzi Studio
//   npm run deploy -- --no-restart
//
// Plugin-agnostic: everything repo-specific lives in package.json "ulanzi":
//   folder    installed folder name under Plugins/
//   files     extra files/dirs to ship besides manifest.json and its CodePath bundle
//   preserve  user config kept across installs (seeded from the repo only on first install)
import { build } from "esbuild";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(ROOT, ".dist");
const PLUGINS_DIR = path.join(os.homedir(), "Library/Application Support/Ulanzi/UlanziDeck/Plugins");
const APP = "Ulanzi Studio";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const cfg = pkg.ulanzi || {};
if (!cfg.folder) throw new Error('package.json "ulanzi.folder" is required');
const TARGET = path.join(PLUGINS_DIR, cfg.folder);
const preserve = cfg.preserve || [];

const args = new Set(process.argv.slice(2));
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: "inherit", ...opts });

async function bundle() {
  fs.rmSync(DIST, { recursive: true, force: true });
  await build({
    entryPoints: [path.join(ROOT, manifest.CodePath)],
    outfile: path.join(DIST, manifest.CodePath), // same relative path, so runtime path math is unchanged
    bundle: true,
    platform: "node",
    target: "node20", // Ulanzi Studio ships node 20
    format: "esm",
    // ws probes these native addons with try/require; leave them unresolved
    external: ["bufferutil", "utf-8-validate"],
    // esbuild's ESM output needs a real require for bundled CJS deps (ws)
    banner: { js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);' },
    logLevel: "warning",
  });
  for (const f of ["manifest.json", ...(cfg.files || []), ...preserve]) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(DIST, f), { recursive: true });
  }
  fs.writeFileSync(path.join(DIST, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  console.log(`built ${manifest.Name} ${manifest.Version} -> ${path.relative(ROOT, DIST)}/`);
}

function appRunning() {
  try { execFileSync("pgrep", ["-x", "UlanziDeck"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    execFileSync("sleep", ["0.5"]);
  }
  return false;
}

function install() {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  // a dev symlink (or anything that isn't a real folder) gets replaced by a copy
  const st = fs.lstatSync(TARGET, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) fs.rmSync(TARGET);

  // user config already installed wins over the repo copy
  const excludes = preserve
    .filter((f) => fs.existsSync(path.join(TARGET, f)))
    .flatMap((f) => ["--exclude", `/${f}`]);
  sh("rsync", ["-a", "--delete", ...excludes, `${DIST}/`, `${TARGET}/`]);
  console.log(`installed -> ${TARGET}`);
}

function restart() {
  if (appRunning()) {
    // a busy app can time out the AppleEvent; fall back to SIGTERM
    try { sh("osascript", ["-e", `quit app "${APP}"`], { stdio: "ignore" }); } catch {}
    if (!waitFor(() => !appRunning(), 10000)) {
      try { sh("pkill", ["-x", "UlanziDeck"]); } catch {}
      if (!waitFor(() => !appRunning(), 5000)) throw new Error(`${APP} did not quit`);
    }
  }
  // LaunchServices can refuse while the old instance is still tearing down
  for (let i = 0; ; i++) {
    try { sh("open", ["-a", APP], { stdio: "ignore" }); break; }
    catch (e) { if (i >= 5) throw e; execFileSync("sleep", ["1"]); }
  }
  console.log(`restarted ${APP}`);
}

await bundle();
if (process.argv[2] === "deploy") {
  install();
  if (!args.has("--no-restart")) restart();
}
