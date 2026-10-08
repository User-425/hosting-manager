import { appConfig, serviceRegistry, getAdminSecret } from "./state.js";
import { executeCommand } from "./cli.js";
import { syncPm2Status } from "./process-manager.js";

/**
 * Executes a terminal command in an isolated capture context.
 */
export async function runTerminalCommand(rawCommand) {
    const logs = [];
    const logFn = (...args) => {
        logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" "));
    };
    const errFn = (...args) => {
        logs.push("[ERROR] " + args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" "));
    };

    try {
        await executeCommand(rawCommand, logFn, errFn);
        return {
            success: true,
            output: logs.join("\n") || "(Command produced no output)"
        };
    } catch (err) {
        return {
            success: false,
            output: `[EXECUTION EXCEPTION]: ${err.message}`
        };
    }
}

/**
 * Returns live status summary for the terminal dashboard header.
 */
export function getTerminalStateSummary() {
    syncPm2Status();
    const services = Array.from(serviceRegistry.entries()).map(([name, s]) => ({
        name,
        runner: s.runner || "builtin",
        status: s.status,
        port: s.port,
        pid: s.pid || s.child?.pid || null
    }));

    const runningCount = services.filter((s) => s.status === "RUNNING").length;

    return {
        publicPort: appConfig.settings?.publicPort || 25575,
        defaultRunner: appConfig.settings?.runner || "builtin",
        serviceCount: services.length,
        runningCount,
        services,
        serverTime: new Date().toLocaleTimeString(),
        uptimeSeconds: Math.floor(process.uptime())
    };
}

/**
 * Handles incoming HTTP requests for /terminal and its API subpaths.
 */
export async function handleTerminalRequest(req, res, terminalPath = "/terminal") {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = (parsedUrl.pathname || "").replace(/\/+$/, "") || "/";
    const token =
        parsedUrl.searchParams.get("key") ||
        req.headers["x-admin-key"] ||
        (req.headers["authorization"]?.startsWith("Bearer ")
            ? req.headers["authorization"].slice(7).trim()
            : null);

    const cleanTerminalPath = (terminalPath.startsWith("/") ? terminalPath : `/${terminalPath}`).replace(/\/+$/, "");
    const apiPrefix = `${cleanTerminalPath}/api`;

    // 1. API: Auth Check
    if (pathname === `${apiPrefix}/auth-check`) {
        const isValid = token === getAdminSecret();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ authenticated: isValid }));
        return;
    }

    // 2. API: State Summary
    if (pathname === `${apiPrefix}/state`) {
        if (token !== getAdminSecret()) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing admin key." }));
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(getTerminalStateSummary()));
        return;
    }

    // 3. API: Command Execution
    if (pathname === `${apiPrefix}/exec` && req.method === "POST") {
        if (token !== getAdminSecret()) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing admin key." }));
            return;
        }

        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                req.destroy();
            }
        });

        req.on("end", async () => {
            try {
                const parsed = JSON.parse(body || "{}");
                const command = (parsed.command || "").trim();
                if (!command) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Empty command string." }));
                    return;
                }

                const result = await runTerminalCommand(command);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        success: result.success,
                        command,
                        output: result.output,
                        timestamp: new Date().toLocaleTimeString()
                    })
                );
            } catch (err) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // 4. Web UI Page: GET /terminal (or any sub-route under cleanTerminalPath)
    if (pathname === cleanTerminalPath || pathname === `${cleanTerminalPath}/` || pathname.startsWith(`${cleanTerminalPath}`)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getTerminalHtml(cleanTerminalPath));
        return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
}

/**
 * Generates the self-contained interactive web terminal UI.
 */
function getTerminalHtml(terminalPath) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hosting Manager &mdash; Terminal</title>
  <style>
    :root {
      --bg-canvas: #090d13;
      --bg-surface: #0f151f;
      --bg-surface-elevated: #161f2d;
      --bg-surface-active: #1d293b;
      --border-subtle: #243042;
      --border-active: #3b82f6;
      --text-primary: #e2e8f0;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent-primary: #3b82f6;
      --accent-emerald: #10b981;
      --accent-amber: #f59e0b;
      --accent-rose: #f43f5e;
      --accent-cyan: #06b6d4;
      --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; background: var(--bg-canvas); color: var(--text-primary); font-family: var(--font-mono); font-size: 13.5px; line-height: 1.5; overflow: hidden; }

    .app-container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
    }

    /* Top Navigation Bar */
    header.terminal-header {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      padding: 8px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      user-select: none;
    }

    .brand-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 700;
      color: #f8fafc;
      letter-spacing: 0.5px;
    }
    .brand-title .badge {
      font-size: 10px;
      background: rgba(59, 130, 246, 0.15);
      color: var(--accent-primary);
      border: 1px solid rgba(59, 130, 246, 0.3);
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
    }

    .header-metrics {
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 11.5px;
      color: var(--text-secondary);
    }
    .metric-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .metric-val {
      font-weight: 600;
      color: var(--text-primary);
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent-emerald);
      box-shadow: 0 0 6px var(--accent-emerald);
    }
    .status-dot.offline {
      background: var(--accent-rose);
      box-shadow: 0 0 6px var(--accent-rose);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn-action {
      background: var(--bg-surface-elevated);
      color: var(--text-secondary);
      border: 1px solid var(--border-subtle);
      padding: 4px 10px;
      border-radius: 5px;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
    }
    .btn-action:hover {
      background: var(--bg-surface-active);
      color: var(--text-primary);
      border-color: var(--text-muted);
    }

    /* Quick Action Chips */
    .chips-bar {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      padding: 6px 16px;
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      white-space: nowrap;
      user-select: none;
    }
    .chips-label {
      font-size: 11px;
      color: var(--text-muted);
      margin-right: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .chip {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      padding: 2px 9px;
      border-radius: 4px;
      font-size: 11.5px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .chip:hover {
      background: var(--bg-surface-active);
      color: var(--accent-cyan);
      border-color: var(--accent-cyan);
    }

    /* Terminal Output Viewport */
    .terminal-screen {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: var(--bg-canvas);
    }

    .log-entry {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .command-header {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--accent-cyan);
      font-weight: 600;
    }
    .command-header .prompt-symbol {
      color: var(--accent-emerald);
      user-select: none;
    }
    .command-header .timestamp {
      font-size: 11px;
      color: var(--text-muted);
      font-weight: normal;
      margin-left: auto;
    }
    .command-output {
      background: rgba(15, 21, 31, 0.7);
      border: 1px solid rgba(36, 48, 66, 0.6);
      border-radius: 6px;
      padding: 10px 14px;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--font-mono);
      font-size: 13px;
      overflow-x: auto;
    }
    .command-output.error {
      border-color: rgba(244, 63, 94, 0.4);
      color: #fda4af;
      background: rgba(244, 63, 94, 0.05);
    }

    /* Bottom Command Prompt Bar */
    .prompt-bar {
      background: var(--bg-surface);
      border-top: 1px solid var(--border-subtle);
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .prompt-prefix {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--accent-emerald);
      font-weight: 600;
      user-select: none;
      white-space: nowrap;
    }
    .prompt-prefix .path {
      color: var(--accent-primary);
    }

    .prompt-input-wrapper {
      flex: 1;
      position: relative;
      display: flex;
      align-items: center;
    }
    .prompt-input {
      width: 100%;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 8px 12px;
      color: #f8fafc;
      font-family: var(--font-mono);
      font-size: 13.5px;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .prompt-input:focus {
      border-color: var(--border-active);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }

    .btn-send {
      background: var(--accent-primary);
      color: #ffffff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease;
      white-space: nowrap;
    }
    .btn-send:hover {
      background: #2563eb;
    }

    /* Auth Modal / Drawer */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999;
      padding: 16px;
    }
    .modal-overlay.hidden { display: none; }
    .modal-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 24px;
      width: 100%;
      max-width: 440px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .modal-title {
      font-size: 15px;
      font-weight: 700;
      color: #f8fafc;
    }
    .modal-body {
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-bottom: 20px;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .form-label {
      font-size: 12px;
      color: var(--text-secondary);
      font-weight: 500;
    }
    .form-input {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 8px 12px;
      color: #f8fafc;
      font-family: var(--font-mono);
      font-size: 13px;
      outline: none;
    }
    .form-input:focus {
      border-color: var(--border-active);
    }
    .modal-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }

    /* Autocomplete dropdown */
    .autocomplete-list {
      position: absolute;
      bottom: 100%;
      left: 0;
      width: 100%;
      max-height: 180px;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      overflow-y: auto;
      margin-bottom: 4px;
      display: none;
      z-index: 100;
    }
    .autocomplete-item {
      padding: 6px 12px;
      font-size: 12px;
      color: var(--text-secondary);
      cursor: pointer;
    }
    .autocomplete-item:hover, .autocomplete-item.active {
      background: var(--bg-surface-active);
      color: var(--accent-cyan);
    }

    /* Responsive */
    @media (max-width: 640px) {
      .header-metrics { display: none; }
      .prompt-prefix .path { display: none; }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <!-- Top Header -->
    <header class="terminal-header">
      <div class="brand-title">
        <span>⚡ Hosting Manager</span>
        <span class="badge">Web Terminal</span>
      </div>

      <div class="header-metrics">
        <div class="metric-item">
          <div class="status-dot" id="status-dot"></div>
          <span>Gateway:</span>
          <span class="metric-val" id="metric-port">:${25575}</span>
        </div>
        <div class="metric-item">
          <span>Active:</span>
          <span class="metric-val" id="metric-services">0/0</span>
        </div>
        <div class="metric-item">
          <span>Uptime:</span>
          <span class="metric-val" id="metric-uptime">0s</span>
        </div>
      </div>

      <div class="header-actions">
        <button class="btn-action" onclick="openKeyModal()" title="Admin Secret Settings">
          🔑 Key
        </button>
        <button class="btn-action" onclick="clearScreen()" title="Clear terminal screen (Ctrl+L)">
          🧹 Clear
        </button>
        <button class="btn-action" onclick="fetchState()" title="Refresh status">
          🔄 Sync
        </button>
      </div>
    </header>

    <!-- Quick Command Chips -->
    <div class="chips-bar">
      <span class="chips-label">Quick Actions:</span>
      <button class="chip" onclick="quickRun('status')">status</button>
      <button class="chip" onclick="quickRun('restart all')">restart all</button>
      <button class="chip" onclick="quickRun('reload')">reload config</button>
      <button class="chip" onclick="quickRun('help')">help</button>
      <button class="chip" onclick="quickRun('exec . git status')">git status</button>
      <button class="chip" onclick="quickRun('exec . pm2 list')">pm2 list</button>
    </div>

    <!-- Output Screen -->
    <main class="terminal-screen" id="terminal-screen">
      <div class="log-entry">
        <div class="command-output">
======================================================================
              Hosting Manager Interactive Web Terminal
======================================================================
Type "help" for a list of management commands.
Use Tab for auto-completion &bull; &uarr;&darr; for history &bull; Ctrl+L to clear screen.
        </div>
      </div>
    </main>

    <!-- Command Input Bar -->
    <footer class="prompt-bar">
      <div class="prompt-prefix">
        <span class="path">manager:~</span>
        <span>$&gt;</span>
      </div>
      <div class="prompt-input-wrapper">
        <input
          type="text"
          id="cmd-input"
          class="prompt-input"
          placeholder="Type command (e.g. 'status', 'restart pm2-dashboard', 'logs <service>')..."
          autocomplete="off"
          autofocus
        />
        <div class="autocomplete-list" id="autocomplete-list"></div>
      </div>
      <button class="btn-send" id="btn-send" onclick="submitCommand()">Run</button>
    </footer>
  </div>

  <!-- Admin Key Modal -->
  <div class="modal-overlay hidden" id="key-modal">
    <div class="modal-card">
      <div class="modal-header">
        <h3 class="modal-title">Admin Authentication</h3>
        <button class="btn-action" onclick="closeKeyModal()">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size: 12px; color: var(--text-secondary); line-height: 1.4;">
          Enter your <code>ADMIN_SECRET</code> or <code>ADMIN_KEY</code> from your <code>.env</code> to authenticate terminal commands.
        </p>
        <div class="form-group">
          <label class="form-label" for="admin-key-input">Admin Secret Key</label>
          <input type="password" id="admin-key-input" class="form-input" placeholder="e.g. hosting_admin_key" />
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-action" onclick="closeKeyModal()">Cancel</button>
        <button class="btn-send" onclick="saveAdminKey()">Save &amp; Connect</button>
      </div>
    </div>
  </div>

  <script>
    const TERMINAL_PATH = "${terminalPath}";
    const STORAGE_KEY = "hosting_admin_secret";

    const cmdInput = document.getElementById("cmd-input");
    const terminalScreen = document.getElementById("terminal-screen");
    const keyModal = document.getElementById("key-modal");
    const adminKeyInput = document.getElementById("admin-key-input");
    const metricPort = document.getElementById("metric-port");
    const metricServices = document.getElementById("metric-services");
    const metricUptime = document.getElementById("metric-uptime");
    const statusDot = document.getElementById("status-dot");

    let commandHistory = JSON.parse(localStorage.getItem("terminal_cmd_history") || "[]");
    let historyIndex = -1;
    let knownServices = [];

    function getAdminKey() {
      const urlParams = new URLSearchParams(window.location.search);
      const urlKey = urlParams.get("key");
      if (urlKey) {
        localStorage.setItem(STORAGE_KEY, urlKey);
        return urlKey;
      }
      return localStorage.getItem(STORAGE_KEY) || "";
    }

    function openKeyModal() {
      adminKeyInput.value = getAdminKey();
      keyModal.classList.remove("hidden");
      adminKeyInput.focus();
    }

    function closeKeyModal() {
      keyModal.classList.add("hidden");
      cmdInput.focus();
    }

    function saveAdminKey() {
      const key = adminKeyInput.value.trim();
      if (key) {
        localStorage.setItem(STORAGE_KEY, key);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
      closeKeyModal();
      fetchState();
    }

    function appendLog(command, output, isError = false) {
      const entry = document.createElement("div");
      entry.className = "log-entry";

      const timeStr = new Date().toLocaleTimeString();
      entry.innerHTML = \`
        <div class="command-header">
          <span class="prompt-symbol">$&gt;</span>
          <span>\${escapeHtml(command)}</span>
          <span class="timestamp">\${timeStr}</span>
        </div>
        <div class="command-output \${isError ? 'error' : ''}">\${escapeHtml(output)}</div>
      \`;

      terminalScreen.appendChild(entry);
      terminalScreen.scrollTop = terminalScreen.scrollHeight;
    }

    function clearScreen() {
      terminalScreen.innerHTML = "";
      cmdInput.focus();
    }

    function quickRun(cmd) {
      cmdInput.value = cmd;
      submitCommand();
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    async function submitCommand() {
      const command = cmdInput.value.trim();
      if (!command) return;

      if (command.toLowerCase() === "clear" || command.toLowerCase() === "cls") {
        clearScreen();
        cmdInput.value = "";
        return;
      }

      // Record History
      commandHistory.push(command);
      if (commandHistory.length > 100) commandHistory.shift();
      localStorage.setItem("terminal_cmd_history", JSON.stringify(commandHistory));
      historyIndex = -1;

      cmdInput.value = "";
      cmdInput.disabled = true;

      const key = getAdminKey();

      try {
        const response = await fetch(\`\${TERMINAL_PATH}/api/exec\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-key": key
          },
          body: JSON.stringify({ command })
        });

        if (response.status === 403) {
          appendLog(command, "403 Forbidden: Invalid or missing admin key. Click 'Key' in top right to enter your secret.", true);
          openKeyModal();
        } else {
          const data = await response.json();
          appendLog(command, data.output, !data.success);
        }
      } catch (err) {
        appendLog(command, "Network / Execution Error: " + err.message, true);
      } finally {
        cmdInput.disabled = false;
        cmdInput.focus();
        fetchState();
      }
    }

    async function fetchState() {
      const key = getAdminKey();
      try {
        const res = await fetch(\`\${TERMINAL_PATH}/api/state\`, {
          headers: { "x-admin-key": key }
        });
        if (res.ok) {
          const data = await res.json();
          metricPort.textContent = ":" + data.publicPort;
          metricServices.textContent = \`\${data.runningCount}/\${data.serviceCount}\`;
          metricUptime.textContent = formatUptime(data.uptimeSeconds);
          statusDot.className = "status-dot";
          knownServices = data.services.map(s => s.name);
        } else {
          statusDot.className = "status-dot offline";
        }
      } catch {
        statusDot.className = "status-dot offline";
      }
    }

    function formatUptime(secs) {
      if (secs < 60) return secs + "s";
      const m = Math.floor(secs / 60);
      if (m < 60) return m + "m";
      const h = Math.floor(m / 60);
      return h + "h " + (m % 60) + "m";
    }

    // Keyboard navigation
    cmdInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        submitCommand();
      } else if (e.key === "ArrowUp") {
        if (commandHistory.length === 0) return;
        if (historyIndex === -1) historyIndex = commandHistory.length - 1;
        else if (historyIndex > 0) historyIndex--;
        cmdInput.value = commandHistory[historyIndex] || "";
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        if (historyIndex !== -1) {
          if (historyIndex < commandHistory.length - 1) {
            historyIndex++;
            cmdInput.value = commandHistory[historyIndex];
          } else {
            historyIndex = -1;
            cmdInput.value = "";
          }
          e.preventDefault();
        }
      } else if (e.ctrlKey && e.key === "l") {
        e.preventDefault();
        clearScreen();
      }
    });

    // Auto-init
    if (!getAdminKey()) {
      setTimeout(openKeyModal, 400);
    } else {
      fetchState();
    }
    setInterval(fetchState, 10000);
  </script>
</body>
</html>`;
}
