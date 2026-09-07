import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";
import httpProxy from "http-proxy";
import readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   ENV FILE LOADER (.env)
========================================================= */
function loadEnv() {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    try {
        if (typeof process.loadEnvFile === "function") {
            process.loadEnvFile(envPath);
        } else {
            const content = fs.readFileSync(envPath, "utf-8");
            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) continue;
                const eqIdx = trimmed.indexOf("=");
                if (eqIdx !== -1) {
                    const key = trimmed.slice(0, eqIdx).trim();
                    let val = trimmed.slice(eqIdx + 1).trim();
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.slice(1, -1);
                    }
                    if (!(key in process.env)) {
                        process.env[key] = val;
                    }
                }
            }
        }
    } catch (e) {
        console.error(`[ENV] Failed to load .env: ${e.message}`);
    }
}
loadEnv();

const CONFIG_PATH = path.join(__dirname, "services.json");
const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.ADMIN_KEY || "hosting_admin_key";

let shuttingDown = false;
let appConfig = {
    settings: {
        publicPort: 25575,
        restartDelayMs: 3000,
        maxCrashCount: 5,
        crashWindowMs: 60000,
        autoWatchConfig: true
    },
    services: {}
};

// Map<string, {
//    child: ChildProcess | null,
//    status: 'RUNNING' | 'STOPPED' | 'STARTING' | 'SUSPENDED',
//    startTime: number | null,
//    restartCount: number,
//    lastCrashTime: number,
//    backoffDelay: number,
//    restartTimer: NodeJS.Timeout | null,
//    port: number | null,
//    routes: string[]
// }>
const serviceRegistry = new Map();

/* =========================================================
   LOGGING UTILITIES
========================================================= */

function getTimestamp() {
    return new Date().toLocaleTimeString();
}

function log(type, name, message) {
    console.log(`[${getTimestamp()}] [${type}] [${name}] ${message}`);
}

function logError(type, name, message) {
    console.error(`[${getTimestamp()}] [ERROR: ${type}] [${name}] ${message}`);
}

/* =========================================================
   CONFIG LOADER & WATCHER
========================================================= */

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        logError("CONFIG", "SYSTEM", `Configuration file not found at ${CONFIG_PATH}`);
        return null;
    }

    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed.services || typeof parsed.services !== "object") {
            throw new Error("Invalid config format: 'services' object is missing.");
        }
        return parsed;
    } catch (err) {
        logError("CONFIG", "SYSTEM", `Failed to read or parse services.json: ${err.message}`);
        return null;
    }
}

function watchConfigFile() {
    let watchDebounce = null;
    try {
        fs.watch(CONFIG_PATH, (eventType) => {
            if (eventType === "change" && appConfig.settings.autoWatchConfig) {
                clearTimeout(watchDebounce);
                watchDebounce = setTimeout(() => {
                    log("CONFIG", "WATCHER", "services.json modified on disk. Synchronizing...");
                    reloadConfig();
                }, 1000);
            }
        });
    } catch (err) {
        logError("WATCHER", "SYSTEM", `Could not watch services.json: ${err.message}`);
    }
}

/* =========================================================
   DEPENDENCY INSTALL & BUILD
========================================================= */

function installDependencies(serviceName, subFolder = "", isDev = false) {
    const targetFolder = path.join(__dirname, serviceName, subFolder);
    const packageJsonPath = path.join(targetFolder, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
        logError("NPM INSTALL", serviceName, `package.json not found in ${targetFolder}`);
        return false;
    }

    const label = subFolder ? `${serviceName}/${subFolder}` : serviceName;
    console.log(`[NPM INSTALL] ${label} -> installing dependencies...`);

    const packageLockPath = path.join(targetFolder, "package-lock.json");
    const args = fs.existsSync(packageLockPath)
        ? (isDev ? ["ci", "--include=dev"] : ["ci", "--omit=dev"])
        : (isDev ? ["install", "--include=dev"] : ["install", "--omit=dev"]);

    const result = spawnSync("npm", args, {
        cwd: targetFolder,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: {
            ...process.env,
            ...(isDev ? { NODE_ENV: "development", NPM_CONFIG_PRODUCTION: "false" } : {})
        }
    });

    if (result.error || result.status !== 0) {
        logError("NPM INSTALL FAILED", label, `Exit status: ${result.status}`);
        return false;
    }

    console.log(`[NPM INSTALL COMPLETE] ${label}`);
    return true;
}

function buildPackage(serviceName, subFolder = "") {
    const targetFolder = path.join(__dirname, serviceName, subFolder);
    const packageJsonPath = path.join(targetFolder, "package.json");

    const label = subFolder ? `${serviceName}/${subFolder}` : serviceName;

    if (!fs.existsSync(packageJsonPath)) {
        logError("BUILD", label, `package.json not found in ${targetFolder}`);
        return false;
    }

    log("BUILD", label, "Running npm run build...");

    const result = spawnSync("npm", ["run", "build"], {
        cwd: targetFolder,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: process.env
    });

    if (result.error || result.status !== 0) {
        logError("BUILD FAILED", label, `Exit status: ${result.status}`);
        return false;
    }

    log("BUILD COMPLETE", label, "Build finished successfully.");
    return true;
}

/* =========================================================
   ENTRY POINT RESOLUTION
========================================================= */

function getServiceEntryPoint(serviceDir) {
    const packageJsonPath = path.join(serviceDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
            if (pkg.main) {
                const mainPath = path.join(serviceDir, pkg.main);
                if (fs.existsSync(mainPath)) return mainPath;
            }
        } catch {}
    }

    const candidates = [
        path.join(serviceDir, "src", "index.js"),
        path.join(serviceDir, "dist", "bundle.cjs"),
        path.join(serviceDir, "dist", "bundle.js"),
        path.join(serviceDir, "bundle.cjs"),
        path.join(serviceDir, "bundle.js"),
        path.join(serviceDir, "dist", "index.js"),
        path.join(serviceDir, "index.js")
    ];

    return candidates.find((file) => fs.existsSync(file)) ?? null;
}

/* =========================================================
   PROCESS CONTROL & LIFECYCLE
========================================================= */

function getOrCreateServiceState(name) {
    let state = serviceRegistry.get(name);
    if (!state) {
        state = {
            child: null,
            status: "STOPPED",
            startTime: null,
            restartCount: 0,
            lastCrashTime: 0,
            backoffDelay: appConfig.settings.restartDelayMs || 3000,
            restartTimer: null,
            port: appConfig.services[name]?.port || null,
            routes: appConfig.services[name]?.routes || []
        };
        serviceRegistry.set(name, state);
    }
    return state;
}

export function startService(name, isManual = false) {
    if (shuttingDown) return;

    const conf = appConfig.services[name];
    if (!conf) {
        logError("START", name, `Service "${name}" does not exist in services.json.`);
        return;
    }

    if (!conf.enabled && !isManual) {
        return;
    }

    const state = getOrCreateServiceState(name);
    if (state.status === "RUNNING" && state.child) {
        log("WARN", name, `Service "${name}" is already running (PID ${state.child.pid}).`);
        return;
    }

    if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }

    const serviceFolder = path.join(__dirname, name);
    if (!fs.existsSync(serviceFolder)) {
        logError("START", name, `Directory "${serviceFolder}" does not exist.`);
        state.status = "STOPPED";
        return;
    }

    const entryPoint = getServiceEntryPoint(serviceFolder);
    if (!entryPoint) {
        logError("START", name, `No valid entry point found (checked package.json main, src/index.js, index.js, dist/).`);
        state.status = "STOPPED";
        return;
    }

    state.status = "STARTING";
    state.port = conf.port || null;
    state.routes = conf.routes || [];

    log("START", name, `Launching ${entryPoint}`);

    const childEnv = {
        ...process.env,
        BOT_NAME: name,
        ...(conf.port ? { PORT: String(conf.port) } : {})
    };

    const child = spawn(process.execPath, [entryPoint], {
        cwd: serviceFolder,
        stdio: "inherit",
        env: childEnv,
        windowsHide: true
    });

    state.child = child;
    state.startTime = Date.now();
    state.status = "RUNNING";

    child.once("spawn", () => {
        log("ONLINE", name, `PID ${child.pid}${conf.port ? ` [Internal Port: ${conf.port}]` : ""}`);
    });

    child.once("error", (err) => {
        logError("PROCESS ERROR", name, err.message);
    });

    child.once("exit", (code, signal) => {
        state.child = null;
        state.status = "STOPPED";

        if (shuttingDown) return;

        log("EXIT", name, `Exited with code ${code}, signal ${signal}`);

        const now = Date.now();
        const crashWindow = appConfig.settings.crashWindowMs || 60000;
        const maxCrashes = appConfig.settings.maxCrashCount || 5;

        // Reset crash counter if it was running stably for more than the crash window
        if (now - state.lastCrashTime > crashWindow) {
            state.restartCount = 0;
            state.backoffDelay = appConfig.settings.restartDelayMs || 3000;
        }

        state.restartCount++;
        state.lastCrashTime = now;

        // Circuit Breaker Triggered
        if (state.restartCount > maxCrashes) {
            state.status = "SUSPENDED";
            logError(
                "CIRCUIT BREAKER",
                name,
                `Exceeded ${maxCrashes} crashes within ${(crashWindow / 1000).toFixed(0)}s. Auto-restart suspended. Fix the error and run 'restart ${name}'.`
            );
            return;
        }

        log("AUTO-RESTART", name, `Restarting in ${(state.backoffDelay / 1000).toFixed(1)}s (Crash #${state.restartCount})...`);

        state.restartTimer = setTimeout(() => {
            state.restartTimer = null;
            startService(name);
        }, state.backoffDelay);

        // Exponential backoff up to 30 seconds
        state.backoffDelay = Math.min(state.backoffDelay * 1.5, 30000);
    });
}

export function stopService(name) {
    const state = serviceRegistry.get(name);
    if (!state || (!state.child && !state.restartTimer)) {
        log("INFO", name, "Service is not currently running or scheduled to restart.");
        return;
    }

    if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }

    if (state.child && state.child.pid) {
        log("STOP", name, `Terminating PID ${state.child.pid}...`);
        try {
            if (process.platform === "win32") {
                spawn("taskkill", ["/pid", state.child.pid.toString(), "/T", "/F"]);
            } else {
                state.child.kill("SIGTERM");
            }
        } catch (err) {
            logError("STOP ERROR", name, err.message);
        }
    }

    state.status = "STOPPED";
    state.child = null;
}

export function restartService(name) {
    log("RESTART", name, `Restart requested for "${name}"`);
    stopService(name);

    const state = serviceRegistry.get(name);
    if (state) {
        state.restartCount = 0;
        state.backoffDelay = appConfig.settings.restartDelayMs || 3000;
    }

    setTimeout(() => {
        startService(name, true);
    }, 1000);
}

/* =========================================================
   DYNAMIC CONFIG SYNCHRONIZATION (RELOAD)
========================================================= */

export async function reloadConfig() {
    log("CONFIG", "SYSTEM", "Synchronizing configuration with services.json...");
    const freshConfig = loadConfig();
    if (!freshConfig) {
        logError("CONFIG", "SYSTEM", "Sync aborted due to invalid services.json.");
        return;
    }

    appConfig = freshConfig;

    // 1. Start newly enabled or added services
    for (const [name, conf] of Object.entries(appConfig.services)) {
        const state = serviceRegistry.get(name);
        if (conf.enabled) {
            if (!state || state.status === "STOPPED") {
                log("CONFIG", name, "Starting enabled service...");
                startService(name);
            } else {
                // Update dynamic routes/ports in memory
                state.port = conf.port || null;
                state.routes = conf.routes || [];
            }
        } else if (!conf.enabled && state?.status === "RUNNING") {
            log("CONFIG", name, "Stopping disabled service...");
            stopService(name);
        }
    }

    // 2. Stop services removed from config
    for (const [name, state] of serviceRegistry) {
        if (!appConfig.services[name] && state.status === "RUNNING") {
            log("CONFIG", name, "Service was removed from configuration. Stopping...");
            stopService(name);
        }
    }

    log("CONFIG", "SYSTEM", "Configuration synchronization complete.");
}

/* =========================================================
   DYNAMIC REVERSE PROXY GATEWAY
========================================================= */

function startGateway(publicPort) {
    const proxy = httpProxy.createProxyServer({ ws: true });

    proxy.on("error", (err, req, res) => {
        if (res && res.writeHead) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    error: "502 Bad Gateway",
                    message: "The requested backend service is starting up or temporarily offline.",
                    timestamp: new Date().toISOString()
                })
            );
        } else if (res && res.destroy) {
            res.destroy();
        }
    });

    function resolveTarget(url) {
        // 1. Check exact / prefix route matches first
        for (const [name, conf] of Object.entries(appConfig.services)) {
            if (!conf.port || !conf.routes) continue;
            for (const route of conf.routes) {
                if (route !== "/" && url.startsWith(route)) {
                    return `http://127.0.0.1:${conf.port}`;
                }
            }
        }

        // 2. Fallback to default root route ("/")
        for (const [name, conf] of Object.entries(appConfig.services)) {
            if (conf.port && conf.routes?.includes("/")) {
                return `http://127.0.0.1:${conf.port}`;
            }
        }

        return null;
    }

    const server = http.createServer((req, res) => {
        // Global CORS Headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "*");
        res.setHeader("Access-Control-Expose-Headers", "*");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        // Admin Management API Endpoint
        if (req.url.startsWith("/_manage") || req.url === "/_health" || req.url === "/_status") {
            handleAdminApi(req, res);
            return;
        }

        const target = resolveTarget(req.url);
        if (target) {
            proxy.web(req, res, { target });
        } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "404 Not Found", message: "No active service mapped to this route." }));
        }
    });

    // WebSocket Upgrades
    server.on("upgrade", (req, socket, head) => {
        const target = resolveTarget(req.url);
        if (target) {
            proxy.ws(req, socket, head, { target });
        } else {
            socket.destroy();
        }
    });

    server.listen(publicPort, () => {
        console.log("\n========================================================");
        console.log(` [GATEWAY ONLINE] Listening on public port ${publicPort}`);
        console.log(` -> Admin Secret: ${ADMIN_SECRET}`);
        console.log("========================================================\n");
    });

    return server;
}

function handleAdminApi(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const token = parsedUrl.searchParams.get("key") || req.headers["x-admin-key"];

    // Public health check without secret
    if (pathname === "/_health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "OK", timestamp: new Date().toISOString() }));
        return;
    }

    // Require token for admin operations
    if (token !== ADMIN_SECRET) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "403 Forbidden", message: "Invalid or missing admin key." }));
        return;
    }

    if (pathname === "/_manage/status" || pathname === "/_status") {
        const summary = Array.from(serviceRegistry.entries()).map(([name, s]) => ({
            name,
            status: s.status,
            pid: s.child?.pid || null,
            port: s.port,
            routes: s.routes,
            uptimeSeconds: s.startTime && s.status === "RUNNING" ? Math.floor((Date.now() - s.startTime) / 1000) : 0,
            restarts: s.restartCount
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ services: summary, total: summary.length }));
        return;
    }

    const action = parsedUrl.searchParams.get("action");
    const serviceName = parsedUrl.searchParams.get("service");

    if (action === "reload") {
        reloadConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: "services.json reloaded." }));
        return;
    }

    if (action === "restart" && serviceName) {
        restartService(serviceName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: `Restarting ${serviceName}` }));
        return;
    }

    if (action === "start" && serviceName) {
        startService(serviceName, true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: `Starting ${serviceName}` }));
        return;
    }

    if (action === "stop" && serviceName) {
        stopService(serviceName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: `Stopping ${serviceName}` }));
        return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid action or parameters." }));
}

/* =========================================================
   INTERACTIVE CONSOLE (REPL CLI)
========================================================= */

function setupConsoleCLI() {
    if (!process.stdin.isTTY) {
        return; // Headless environment, skip interactive prompt
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: ""
    });

    rl.on("line", async (line) => {
        const input = line.trim();
        if (!input) return;

        const [command, ...args] = input.split(/\s+/);
        const target = args[0];

        switch (command.toLowerCase()) {
            case "status":
            case "list":
            case "ls": {
                const tableData = [];
                for (const [name, conf] of Object.entries(appConfig.services)) {
                    const state = serviceRegistry.get(name);
                    const isRunning = state?.status === "RUNNING";
                    const uptime = isRunning && state?.startTime
                        ? `${Math.floor((Date.now() - state.startTime) / 1000)}s`
                        : "-";

                    tableData.push({
                        Service: name,
                        Configured: conf.enabled ? "Enabled" : "Disabled",
                        Status: state?.status || "STOPPED",
                        PID: state?.child?.pid || "-",
                        Port: conf.port || "-",
                        Routes: conf.routes ? conf.routes.join(", ") : "-",
                        Uptime: uptime,
                        Crashes: state?.restartCount || 0
                    });
                }
                console.table(tableData);
                break;
            }

            case "restart": {
                if (!target) {
                    console.log("Usage: restart <service-name> (or 'restart all')");
                    break;
                }
                if (target === "all") {
                    console.log("Restarting all enabled services...");
                    for (const name of Object.keys(appConfig.services)) {
                        restartService(name);
                    }
                } else {
                    restartService(target);
                }
                break;
            }

            case "start": {
                if (!target) {
                    console.log("Usage: start <service-name>");
                    break;
                }
                startService(target, true);
                break;
            }

            case "stop": {
                if (!target) {
                    console.log("Usage: stop <service-name>");
                    break;
                }
                stopService(target);
                break;
            }

            case "reload": {
                await reloadConfig();
                break;
            }

            case "install": {
                if (!target) {
                    console.log("Usage: install <service-name>");
                    break;
                }
                const conf = appConfig.services[target];
                installDependencies(target, "", conf?.build);
                if (conf?.subProjects) {
                    for (const sub of conf.subProjects) {
                        if (sub.install) installDependencies(target, sub.path, sub.build);
                    }
                }
                break;
            }

            case "build": {
                if (!target) {
                    console.log("Usage: build <service-name>");
                    break;
                }
                const conf = appConfig.services[target];
                if (conf?.build) buildPackage(target);
                if (conf?.subProjects) {
                    for (const sub of conf.subProjects) {
                        if (sub.build) buildPackage(target, sub.path);
                    }
                }
                break;
            }

            case "help": {
                console.log(`
┌─────────────────────────────────────────────────────────────┐
│                 HOSTING MANAGER CLI COMMANDS                │
├─────────────────────────────────────────────────────────────┤
│  status | list      - Show status table of all services    │
│  restart <name>     - Restart a specific service (or 'all') │
│  start <name>       - Start an individual service           │
│  stop <name>        - Stop an individual service            │
│  reload             - Re-read services.json and apply       │
│  install <name>     - Run npm install for a service         │
│  build <name>       - Run npm run build for a service       │
│  help               - Display this help menu                │
└─────────────────────────────────────────────────────────────┘
                `);
                break;
            }

            default:
                console.log(`Unknown command: "${command}". Type "help" for a list of commands.`);
                break;
        }
    });
}

/* =========================================================
   SHUTDOWN & PROCESS ERROR GUARDS
========================================================= */

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[SHUTDOWN] Received ${signal}. Terminating all child processes...`);

    for (const [name] of serviceRegistry) {
        stopService(name);
    }

    setTimeout(() => {
        console.log("[SHUTDOWN] All services stopped. Exiting manager.");
        process.exit(0);
    }, 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Global safety net to prevent gateway crashes from rogue errors
process.on("uncaughtException", (err) => {
    logError("UNCAUGHT EXCEPTION", "SYSTEM", err.stack || err.message);
});

process.on("unhandledRejection", (reason) => {
    logError("UNHANDLED REJECTION", "SYSTEM", String(reason));
});

/* =========================================================
   MAIN INITIALIZATION
========================================================= */

async function main() {
    console.log("\n========================================================");
    console.log("            Robust Multi-Service Gateway Manager        ");
    console.log("========================================================\n");

    const loaded = loadConfig();
    if (loaded) {
        appConfig = loaded;
    }

    const publicPort = Number(process.env.PORT) || appConfig.settings?.publicPort || 25575;

    // 1. Initial Dependency Check & Builds
    log("INIT", "SYSTEM", "Checking dependencies and builds for enabled services...");
    for (const [name, conf] of Object.entries(appConfig.services)) {
        if (!conf.enabled) continue;

        if (conf.install) {
            installDependencies(name, "", conf.build);
        }

        if (conf.build) {
            buildPackage(name);
        }

        if (conf.subProjects) {
            for (const sub of conf.subProjects) {
                if (sub.install) installDependencies(name, sub.path, sub.build);
                if (sub.build) buildPackage(name, sub.path);
            }
        }
    }

    // 2. Start all configured services
    log("INIT", "SYSTEM", "Starting configured services...");
    for (const [name, conf] of Object.entries(appConfig.services)) {
        if (conf.enabled) {
            startService(name);
        }
    }

    // 3. Start Public Gateway Server
    startGateway(publicPort);

    // 4. Start File Watcher on services.json
    watchConfigFile();

    // 5. Initialize Interactive Terminal CLI
    setupConsoleCLI();

    log("READY", "SYSTEM", "Manager is operational. Type 'help' or 'status' in console.");
}

main();
