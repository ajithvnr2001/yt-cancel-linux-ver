# yt-cancel-linux-ver

**Automatically cancel pending YouTube TV add-ons on Linux + Brave — one per run, every 15 minutes.**

This is the Linux port of [yt-automation](https://github.com/ajithvnr2001/yt-automation).
The original drives Windows + Chrome through the OS accessibility tree (`ocu`).
This version drives **Brave** (or Chrome/Chromium) on Linux through the
**Chrome DevTools Protocol (CDP)** — no desktop-automation package, no npm
dependencies.

You point it at your own YouTube TV **Membership → Subscriptions** page. Every
run it looks for add-ons showing a **Remove** button, cancels **one**, verifies
the result, and exits. A cron entry repeats that every **15 minutes**.

> ⚠️ **This performs real subscription cancellations on your own account.**
> It only clicks buttons whose label starts with `Remove` and the confirmation
> button `Yes, cancel`. The base YouTube TV plan has no Remove button and is
> never touched. Run a scan-only pass first (section 6.1) and read the output
> before enabling cron.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [What it never does](#2-what-it-never-does)
3. [How it works](#3-how-it-works)
4. [Requirements](#4-requirements)
5. [One-time setup (from zero)](#5-one-time-setup-from-zero)
6. [First runs (manual)](#6-first-runs-manual)
7. [Automate every 15 minutes](#7-automate-every-15-minutes)
8. [Configuration](#8-configuration)
9. [Behavior matrix](#9-behavior-matrix)
10. [Errors, retries and backoff](#10-errors-retries-and-backoff)
11. [Logs](#11-logs)
12. [Troubleshooting](#12-troubleshooting)
13. [Stop / uninstall / revert](#13-stop--uninstall--revert)
14. [Security notes](#14-security-notes)
15. [FAQ](#15-faq)
16. [Project layout](#16-project-layout)
17. [Windows version](#17-windows-version)
18. [License](#18-license)

---

## 1. What it does

On `https://tv.youtube.com/settings/subscriptions`:

1. Opens or reuses a Brave tab showing the Membership page.
2. Reloads it so the add-on list is current.
3. Finds every button whose accessible label starts with **`Remove`**
   (these are add-ons you currently own).
4. Clicks the first one with trusted mouse events.
5. Waits for the **Review and cancel** dialog and clicks **`Yes, cancel`**.
6. Waits for **`Cancellation successful`**.
7. Reloads and verifies that the Remove button is gone.
8. Repeats until one cancellation is done (default), or nothing is pending.

Then the script exits. Cron starts it again 15 minutes later.

### Quick start (already set up)

```bash
cd /home/ajith/yt-automation      # or wherever you cloned it
OCU_SCAN_ONLY=1 ./run-check.sh    # report only, never clicks
./run-check.sh                    # one real check/removal
./install-cron.sh 15              # every 15 minutes
tail -f cancel-log.txt            # watch
./uninstall-cron.sh               # stop
```

---

## 2. What it never does

- ❌ Never clicks **`Add`** buttons.
- ❌ Never touches the **base YouTube TV plan** (it has no Remove button).
- ❌ Never clicks a confirmation other than **`Yes, cancel`**.
- ❌ Never cancels more than `OCU_MAX_REMOVALS` items per run (default **1**).
- ❌ Never retries inside the same run after a failed confirmation.
- ❌ Never kills your browser to force the debugging port on.
- ❌ Never runs without your logged-in Brave profile.

---

## 3. How it works

```
cron (*/15)
   │
   ▼
run-check.sh ──► is CDP port 9222 up?
   │                 ├─ no, Brave not running ──► launch-brave.sh
   │                 └─ no, Brave already running ──► log error, exit
   ▼
cancel-addons-linux.mjs
   │
   ├─ connect to the tv.youtube.com tab over CDP
   ├─ Page.reload  → wait for the SPA to render
   ├─ find buttons labelled "Remove …"
   │     ├─ none → "nothing to do" → exit 0
   │     └─ some → pick the first eligible one
   ├─ click Remove (trusted mouse events)
   ├─ wait for dialog:
   │     ├─ "Yes, cancel" → click it
   │     ├─ "error canceling your membership" → back off, retry next tick
   │     ├─ item disappeared → count as cancelled
   │     └─ nothing after 20 s → stop, retry next tick
   ├─ wait for "Cancellation successful"
   ├─ reload + verify the Remove button is gone
   └─ exit
```

Why CDP instead of the Windows accessibility tree?

- It reads the real DOM, so the add-on name is precise (`aria-label="Remove Acorn TV"`).
- It dispatches real mouse events, which YouTube's Polymer UI accepts.
- It can reload the page and verify the final state.
- It needs no extra automation runtime on Linux.

`--force-renderer-accessibility` is still passed to Brave. It makes the page
readable to accessibility clients (and to `ocu` if you ever want to debug with
it), but the automation itself uses CDP.

---

## 4. Requirements

| Requirement | Why | How to check |
|---|---|---|
| Linux with X11 (Linux Mint/Ubuntu/Debian tested) | CDP + browser session | `echo $DISPLAY` (usually `:0`) |
| Node.js **18+** | Runs the engine | `node -v` |
| Brave (or Chrome/Chromium) | The browser being driven | `brave-browser --version` |
| Logged-in YouTube TV session | The page must show your add-ons | open `tv.youtube.com` and sign in |
| `curl` | Health checks in the wrapper | `curl --version` |
| `cron` | 15-minute schedule | `pgrep -x cron` |
| `python3` (optional) | Only for `test-error.sh` | `python3 --version` |

No `npm install`, no `open-computer-use`, no sudo for the app itself.

---

## 5. One-time setup (from zero)

The commands below are for Linux Mint 22 / Ubuntu 24.04 and similar. If a step
is already done, skip it.

### 5.1 Install Node.js 18+

Check:

```bash
node -v
```

If it is missing or older than v18, install Node 22 from NodeSource:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # should print v22.x or newer
```

> Alternative: install `nvm` from https://github.com/nvm-sh/nvm and run
> `nvm install 22`. Either is fine; the scripts use the `node` on `PATH`.

### 5.2 Install Brave

Linux Mint's software manager works, or use Brave's official apt repository:

```bash
sudo apt update
sudo apt install -y curl

sudo curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
  https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg

echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" \
  | sudo tee /etc/apt/sources.list.d/brave-browser-release.list

sudo apt update
sudo apt install -y brave-browser
brave-browser --version
```

### 5.3 Get the code

```bash
git clone https://github.com/ajithvnr2001/yt-cancel-linux-ver.git
cd yt-cancel-linux-ver
chmod +x run-check.sh launch-brave.sh install-cron.sh uninstall-cron.sh doctor.sh test-error.sh
```

If you downloaded a ZIP instead, extract it and `cd` into the folder.

### 5.4 Sign in to YouTube TV in Brave

1. Open Brave.
2. Go to <https://tv.youtube.com/> and sign in with the Google account that
   owns the add-ons.
3. Open <https://tv.youtube.com/settings/subscriptions>.
4. Confirm you can see **Your plan** and **Your add-ons**.

Keep this tab open. The automation reloads it, so it does not need to stay
focused, but the browser must stay running.

> If Brave asks to **Unlock Keyring** after a reboot, unlock it. Without the
> keyring, Brave cannot decrypt the saved login cookies and the page will show
> the signed-out state.

### 5.5 Start Brave with the DevTools port

The automation needs Brave listening on `127.0.0.1:9222`.

**Easiest (recommended):**

```bash
cd yt-cancel-linux-ver
./launch-brave.sh
```

It will:

- do nothing if port 9222 is already open,
- refuse to kill an existing Brave session that lacks the port,
- otherwise start Brave with:
  ```
  --remote-debugging-port=9222 --force-renderer-accessibility
  --restore-last-session https://tv.youtube.com/settings/subscriptions
  ```

Verify:

```bash
curl -s http://127.0.0.1:9222/json/version
```

You should see JSON with a `webSocketDebuggerUrl`.

> **Important:** you cannot add the debugging port to an already-running Brave.
> If `launch-brave.sh` says *"Brave is running without --remote-debugging-port"*,
> close Brave completely and run it again.

### 5.6 Make the flags persistent (recommended)

Patch the per-user application launchers so starting Brave from the menu also
enables the port:

```bash
mkdir -p ~/.local/share/applications

for f in brave-browser.desktop com.brave.Browser.desktop; do
  [ -f "/usr/share/applications/$f" ] || continue
  sed -E 's|^Exec=/usr/bin/brave-browser-stable %U$|Exec=/usr/bin/brave-browser-stable --remote-debugging-port=9222 --force-renderer-accessibility %U|' \
    "/usr/share/applications/$f" > "$HOME/.local/share/applications/$f"
done

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
```

Check the result:

```bash
grep '^Exec=' ~/.local/share/applications/brave-browser.desktop
```

Expected:

```
Exec=/usr/bin/brave-browser-stable --remote-debugging-port=9222 --force-renderer-accessibility %U
Exec=/usr/bin/brave-browser-stable
Exec=/usr/bin/brave-browser-stable --incognito
```

If your Brave executable is `brave-browser` instead of
`brave-browser-stable`, adjust the `sed` pattern or edit the file by hand.

### 5.7 Run the doctor

```bash
./doctor.sh
```

It checks the display, Node version, Brave, the CDP port, the YouTube TV tab,
cron, and the launcher override. Fix anything marked ❌ before continuing.

---

## 6. First runs (manual)

### 6.1 Scan only (safe — never clicks)

```bash
OCU_SCAN_ONLY=1 ./run-check.sh
```

Example:

```
=== run start (linux/cdp, scanOnly=true, max=1) ===
SCAN_ONLY: found 2 pending removal(s):
  - Acorn TV
  - Gaia
=== run end (removals=0) ===
```

If it says `no pending Remove buttons found — nothing to do`, there is nothing
to cancel right now. That is a successful run.

### 6.2 Cancel one add-on

```bash
./run-check.sh
```

Example:

```
=== run start (linux/cdp, scanOnly=false, max=1) ===
clicking Remove for: Acorn TV
confirming with "Yes, cancel"
cancellation submitted for: Acorn TV (total this run: 1)
verified removed: Acorn TV
=== run end (removals=1) ===
```

Run it again to cancel the next one. Or set `OCU_MAX_REMOVALS=3` to cancel up
to three in one run.

### 6.3 Safely test the error branch

YouTube sometimes answers the confirmation with:

> There was an error canceling your membership. Please try again later…

You can verify the automation handles that **without touching your account**:

```bash
./test-error.sh
```

It starts a local mock subscriptions page, opens it in a new Brave tab, runs
the engine against it (twice), checks that:

- the `Remove` → `Yes, cancel` flow is executed,
- the rejection is detected,
- the log says *"will retry on the next 15-minute tick"*,
- the second run retries the same item,

then closes the tab, stops the mock server, and deletes the temporary logs.
It never visits the real YouTube TV page.

---

## 7. Automate every 15 minutes

### 7.1 Install the schedule

```bash
./install-cron.sh          # every 15 minutes
./install-cron.sh 30       # optional: every 30 minutes
```

This adds one user-crontab line:

```
*/15 * * * * /path/to/yt-cancel-linux-ver/run-check.sh >> /path/to/yt-cancel-linux-ver/cron.log 2>&1 # yt-automation
```

No sudo is needed: it is your user's crontab.

### 7.2 Verify

```bash
crontab -l
pgrep -x cron        # must print a PID
```

Wait for the next quarter hour, then:

```bash
tail -n 20 cron.log
tail -n 20 cancel-log.txt
```

The first tick may log `another run already in progress — skipping this tick`
if you are manually running the script at the same time. That is expected.

### 7.3 Watch it

```bash
tail -f cancel-log.txt
# in another terminal:
tail -f cron.log
```

### 7.4 Stop / restart

```bash
./uninstall-cron.sh      # stop all automatic runs
./install-cron.sh 15     # start again
```

---

## 8. Configuration

All settings are optional environment variables. Put them in `run-check.sh`
(export them before the `exec node` line) or in the crontab line.

| Variable | Default | Meaning |
|---|---|---|
| `CDP_PORT` | `9222` | Local DevTools port |
| `TV_URL` | `https://tv.youtube.com/settings/subscriptions` | Page to open/drive |
| `OCU_URL_PATTERN` | `tv\.youtube\.com` | Regex used to pick the browser tab. **Testing only** |
| `OCU_MAX_REMOVALS` | `1` | Maximum cancellations per run |
| `OCU_RUN_TIMEOUT_MS` | `180000` | Hard cap for one run |
| `OCU_LOAD_TIMEOUT_MS` | `60000` | Page-load timeout |
| `OCU_CONFIRM_TIMEOUT_MS` | `20000` | Dialog wait |
| `OCU_REJECT_COOLDOWN_MIN` | `0` | Minutes to skip an add-on after YouTube rejects it. `0` = retry on the next tick |
| `OCU_SCAN_ONLY` | unset | `1` = report only, never click |
| `OCU_AUTOMATION_DIR` | script folder | Where `cancel-log.txt`, `run.lock`, `rejections.json` live |

Examples:

```bash
# report only
OCU_SCAN_ONLY=1 ./run-check.sh

# cancel up to 3, retry rejected items every tick
OCU_MAX_REMOVALS=3 OCU_REJECT_COOLDOWN_MIN=0 ./run-check.sh

# try a non-default port
CDP_PORT=9333 ./run-check.sh
```

---

## 9. Behavior matrix

| Scenario | What happens | Exit code |
|---|---|---|
| Nothing shows **Remove** | Logs `no pending Remove buttons found — nothing to do` | 0 |
| One pending add-on, normal dialog | Remove → Yes, cancel → `Cancellation successful` → verified | 0 |
| Several pending add-ons | Cancels one (`OCU_MAX_REMOVALS=1`); next tick does the next | 0 |
| Item disappears without a dialog | Counted as cancelled; run stops | 0 |
| No dialog and item still there | Stops; next 15-minute tick retries | 0 |
| YouTube rejects (`error canceling your membership`) | Logs rejection; retries next tick (default cooldown 0) | 0 |
| Page takes too long / won't load | Logs `page load error`; next tick retries | 1 |
| Signed out / redirected to Google | Logs `signed out`; next tick retries | 1 |
| Brave not running | `run-check.sh` starts it (if possible) | — |
| Brave running without port 9222 | Logs a clear error; **does not kill Brave** | 1 |
| Two runs overlap | Lock file → `another run already in progress — skipping this tick` | 0 |
| Stale lock older than 30 min | Stolen automatically | 0 |
| `OCU_SCAN_ONLY=1` | Lists pending removals, clicks nothing | 0 |

---

## 10. Errors, retries and backoff

Every run is independent. **There is no retry loop inside a run**, so a stuck
page cannot hammer YouTube. Instead:

- Any error ends the current run.
- The next **15-minute cron tick** tries again automatically.
- A server rejection is also retried on the next tick by default.
- The rejected add-on is written to `rejections.json` so you can see it.

If you want a longer pause for a permanently rejected item (for example a free
trial YouTube refuses to cancel), set:

```bash
OCU_REJECT_COOLDOWN_MIN=360    # skip it for 6 hours
```

The cooldown is per add-on: other pending add-ons are still handled every tick.

> The `error canceling your membership` response is usually server-side and
> often temporary. In a real run on this project, the same add-on was rejected
> twice and succeeded on the third attempt. The automation logged and retried
> it exactly as described above.

---

## 11. Logs

| File | Contents |
|---|---|
| `cancel-log.txt` | One line per action, timestamped (UTC) |
| `cron.log` | stdout/stderr of each scheduled tick |
| `rejections.json` | `{ "Add-on name": unix_ms }` for server rejections |
| `run.lock` | Exists only while a run is active |

Useful greps:

```bash
grep "cancellation submitted" cancel-log.txt
grep "rejected" cancel-log.txt
grep "nothing to do" cancel-log.txt
```

`cancel-log.txt` is rotated to `cancel-log.txt.1` when it exceeds 2 MB.

---

## 12. Troubleshooting

### `Brave is not exposing CDP on http://127.0.0.1:9222`

Brave is running without `--remote-debugging-port=9222`, or it is not running.

1. Close Brave completely.
2. Run `./launch-brave.sh`.
3. Or start it from the menu if you applied section 5.6.

The wrapper **never kills** an existing browser to fix this.

### `signed out — YouTube TV redirected to Google sign-in`

Log in to <https://tv.youtube.com/> in Brave again. If the page still shows the
signed-out view, unlock the login keyring and restart Brave.

### `timed out waiting for the subscriptions page to load`

The SPA is slow or the network is unstable. The next tick retries. If it happens
every time, raise `OCU_LOAD_TIMEOUT_MS` (e.g. `120000`) in `run-check.sh`.

### `another run already in progress — skipping this tick`

Normal when two runs overlap. The next tick continues. If it persists, remove
`run.lock` after confirming no run is active (`pgrep -af cancel-addons-linux`).

### `no "Yes, cancel" dialog and item still present`

The Remove click did not produce a dialog. The next tick retries. If it is
always the same item, check the browser manually — the page may be in an
unexpected state.

### `no success message appeared`

The confirmation was clicked but YouTube did not show success or an error in
20 seconds. Next tick retries, and the add-on may already be gone.

### `error canceling your membership`

Usually a free trial or a temporary server refusal. It will retry every 15
minutes by default. Set `OCU_REJECT_COOLDOWN_MIN` if you want less noise. Only
YouTube support can force a server-side refusal.

### Cron does nothing

1. `pgrep -x cron` — the daemon must be running.
2. `crontab -l` — the line must be present.
3. `cat cron.log` — look for wrapper errors.
4. Make sure the display is correct. `run-check.sh` defaults to `DISPLAY=:0`;
   if yours is different, export it there.

### Brave pops to the front every 15 minutes

Expected: the engine calls `Page.bringToFront`. If it bothers you, stop cron or
reduce the frequency. CDP clicks can work in a background tab, but raising the
tab makes the page state reliable.

### `Unlock Keyring` dialog after reboot

Unlock it. Brave cannot read the saved YouTube TV cookies while the keyring is
locked.

### Nothing happens at all

Run the doctor:

```bash
./doctor.sh
```

Then run one scan manually and read `cancel-log.txt`.

---

## 13. Stop / uninstall / revert

Stop the automation:

```bash
./uninstall-cron.sh
```

This removes only the `# yt-automation` crontab line. Logs and files remain.

Stop a run in progress:

```bash
pkill -f cancel-addons-linux.mjs
```

Revert the Brave launcher change:

```bash
rm -f ~/.local/share/applications/brave-browser.desktop \
      ~/.local/share/applications/com.brave.Browser.desktop
update-desktop-database ~/.local/share/applications 2>/dev/null || true
```

Then close Brave completely and start it normally. The debugging port is gone
until you launch it with the flag again.

Remove the project:

```bash
rm -rf ~/yt-automation      # or your clone path
```

The GitHub repository and its history are separate; delete it on GitHub if you
want it gone too.

---

## 14. Security notes

- `--remote-debugging-port=9222` lets **any process running as your user**
  control the browser, including reading logged-in pages and cookies.
- The port binds to `127.0.0.1` only. Do **not** add
  `--remote-allow-origins=*` or expose it on `0.0.0.0`.
- The port is required for this automation. When you stop using it, close Brave
  and start it without the flag (section 13).
- The scripts never store your Google password. They use your existing Brave
  profile.
- `cancel-log.txt` contains add-on names only, not credentials.
- This tool performs real cancellations. Use the scan-only mode and review the
  output before enabling cron.

---

## 15. FAQ

**Do I need `open-computer-use` / `ocu` on Linux?**
No. That is the Windows implementation. The Linux port uses CDP only.

**Does it cancel my base plan?**
No. The base plan has no Remove button and is never matched.

**How many add-ons per run?**
One by default (`OCU_MAX_REMOVALS`).

**Does the Brave tab need to stay focused?**
No, but it must exist and stay logged in. The engine reloads it and may bring
it to the front.

**Does my PC need to be on?**
Yes. Missed cron ticks are skipped; the next quarter hour runs normally.

**What if I have two YouTube TV tabs open?**
The engine picks the first matching tab and reloads it. Extra tabs are left
alone. They may show stale state until reloaded.

**Can I use Chrome/Chromium instead of Brave?**
Yes, if it listens on the same CDP port. Start it with
`--remote-debugging-port=9222` and set `TV_URL`/`OCU_URL_PATTERN` if needed. The
defaults and `launch-brave.sh` are Brave-specific.

**Where are the logs?**
`cancel-log.txt` (actions) and `cron.log` (scheduler output).

**How do I test without cancelling anything?**
`OCU_SCAN_ONLY=1 ./run-check.sh`, or `./test-error.sh` for the error path.

---

## 16. Project layout

```
yt-cancel-linux-ver/
├── cancel-addons-linux.mjs    # Linux/Brave engine (CDP, no dependencies)
├── run-check.sh               # one tick: env + start Brave + run engine
├── launch-brave.sh            # start Brave with CDP enabled
├── install-cron.sh            # install the 15-minute user crontab entry
├── uninstall-cron.sh          # remove it
├── doctor.sh                  # environment health check
├── test-error.sh              # safe mock test of the rejection branch
├── test/mock/index.html       # the mock subscriptions page used by the test
├── README.md                  # this Linux guide
├── README-WINDOWS.md          # original Windows + Chrome + ocu documentation
├── cancel-addons.mjs          # original Windows ocu engine
├── install-cron.ps1           # original Windows Task Scheduler installer
├── uninstall-cron.ps1
├── run-cancel.cmd
├── LICENSE                    # MIT
├── cancel-log.txt             # created at runtime (gitignored)
├── cron.log                   # created at runtime (gitignored)
├── rejections.json            # created at runtime (gitignored)
└── run.lock                   # created at runtime (gitignored)
```

---

## 17. Windows version

The original Windows implementation is preserved:

- code: `cancel-addons.mjs`, `run-cancel.cmd`,
  `install-cron.ps1`, `uninstall-cron.ps1`
- documentation: [`README-WINDOWS.md`](README-WINDOWS.md)

It uses Chrome + `open-computer-use` / `ocu` and Windows Task Scheduler. It is
independent of the Linux files.

---

## 18. License

MIT — see [LICENSE](LICENSE). You are responsible for your own account actions.
