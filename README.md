# herdr-deck

English | [한국어](README.ko.md)

An Ulanzi Studio plugin for controlling [herdr](https://herdr.dev) coding-agent sessions from an Ulanzi Stream Deck (D200X).
It talks to herdr **only through its socket API** — no simulated keystrokes — so it works regardless of input method, focus, or window position.
Multi-session: each deck page can control a different herdr (local, or a remote server over SSH).

## Actions

| Action | Behavior |
|---|---|
| **Space 1–5** | Shows the status of a project (main space) by color — gray none / green idle / yellow working / red blocked / blue done. Worktree spaces are not numbered, but their status rolls up into the parent project. Press to jump: blocked agent → nearest agent (main first, then worktrees) → the space itself. A missing number is created with the current pane's folder as its root |
| **Split Vertical / Horizontal, Close Pane, Zoom** | `pane.split` / `pane.close` / `pane.zoom` |
| **Answer Agent** | Jump straight to a blocked (waiting for input) agent; otherwise idle, then working |
| **New Worktree** | `git worktree` + a new space, then switch to it (branch `agent-MMDD-HHMMSS`). If the current space is not a repo, a repo space is created from the pane's folder and the action retries |
| **Remove Worktree** | Remove the current worktree space (the branch is kept) |
| **Lazygit** | Open lazygit |
| **Knob: herdr Tabs** | Rotate = previous/next tab, press = new tab, hold + rotate left = close tab |
| **Knob: Agents** | Rotate = cycle agents (across the session), press = Answer Agent |
| **Knob: Spaces** | Rotate = cycle spaces, press = new space |
| **Session Label** | Indicator for the host this page controls (large background images: `resources/label_*_wide.png`) |

Failed actions show herdr's error message as a toast.

## Install

Clone the repo anywhere; `npm run deploy` installs a **built copy** into the Plugins folder
(not a symlink, so moving or deleting the repo does not break the installed plugin).

```bash
git clone https://github.com/dylan-jung/herdr-deck
cd herdr-deck
npm install
npm run deploy     # esbuild bundle → install to Plugins/com.ulanzi.herdrstatus.ulanziPlugin → restart Ulanzi Studio
```

- Update: `git pull && npm run deploy`
- `npm run build` only writes the bundle to `.dist/`. To install without restarting: `npm run deploy -- --no-restart`
- The installed `sessions.json` is never overwritten. A (gitignored) `sessions.json` in the repo is copied only on first install
- Install folder name, shipped files, and preserved files are set under `ulanzi` in `package.json` (`scripts/deploy.mjs` itself is plugin-agnostic)

After Ulanzi Studio restarts, the actions appear under the "Herdr" category in the sidebar.
Button placement is out of scope for this plugin: arrange actions in Ulanzi Studio, or use a separate layout tool that generates a profile from several plugins.

## Sessions — `sessions.json`

Create it with `cp sessions.example.json sessions.json` and edit. You can also edit the installed copy (`Plugins/com.ulanzi.herdrstatus.ulanziPlugin/sessions.json`) directly.

```json
{
  "sessions": {
    "remote": { "host": "my-server", "remote_sock": "/home/me/.config/herdr/herdr.sock" },
    "gpu":    { "host": "gpu-box",   "remote_sock": "/home/me/.config/herdr/herdr.sock" }
  }
}
```

- `local` always exists and uses `~/.config/herdr/herdr.sock`
- `host` is a name from your SSH config (connects with BatchMode, so key auth is required)
- `remote_sock` must be an **absolute path** (an SSH unix-socket forwarding constraint)
- Buttons reference these names via `ActionParam.session`, so switching servers is just an edit to this file
- Reloaded every 30 seconds. If the file is broken the last good config is kept; buttons for an unknown session refuse to run (no fallback to local)

For remote sessions the plugin creates, reconnects, and cleans up SSH unix-socket tunnels (`~/.config/herdr/deck-<name>.sock`) on its own.
Preparing a remote server: `ssh <host> 'herdr server'` (headless), or connect once with `herdr --remote <host>`.

## Layout

```
manifest.json           # action definitions (icons, names, states)
plugin/app.js           # all logic (Node, run by the app's bundled runtime)
plugin/libs/            # Ulanzi plugin-common-node (vendored)
resources/              # all icons (PNGs generated with a Pillow script)
sessions.example.json   # example session (host) config → sessions.json (gitignored)
scripts/deploy.mjs      # build (esbuild), install, restart
```

### Implementation notes

- Button identity: the function comes from the action UUID, the session from the profile files (redundant on purpose, since the app does not always include settings in events)
- Space icons are swapped via `setPathIcon` with PNGs that have the number baked in (this app version does not render text over plugin icons)
- Per-session serial queue with backpressure for rapid knob turns, and a re-entrancy guard on polling
- When the app connection drops, the process cleans up itself and its tunnels (no zombies)

### Development caveats

**Do not connect a test instance to the live Ulanzi Studio (port 3906).** Connecting with the same UUID moves
the registration to the new connection and the real plugin stops receiving events. Limit syntax checks to `node --check`.
To restart only the plugin, kill the process and rerun it with the same arguments; the app re-sends button registrations:

```bash
"/Applications/Ulanzi Studio.app/Contents/MacOS/NodeJS/node" plugin/app.js 127.0.0.1 3906 ko-KR
```
