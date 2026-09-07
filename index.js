import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";
import httpProxy from "http-proxy";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Public port allocated by your host
const PUBLIC_PORT = Number(process.env.PORT) || 25575;

// Internal ports for each service
const SERVICE_PORTS = {
    "ndfy": 8003,
    "llm-discord": 8004,
};

const bots = [
    "llm-discord",
    "SofiHelper",
    "Discord247",
    "ndfy",
];

const installPackages = [
    "llm-discord",
    "llm-discord/dashboard",
    "SofiHelper",
    "Discord247",
    "ndfy",
];

const buildPackages = [
    "llm-discord/dashboard",
    "ndfy",
];

const processes = new Map();
const RESTART_DELAY = 3000;
let shuttingDown = false;

/* =========================================================
   LOGGING
========================================================= */

function log(type, name, message) {
    const time = new Date().toLocaleString();
    console.log(`[${time}] [${type}] [${name}] ${message}`);
}

function logError(type, name, message) {
    const time = new Date().toLocaleString();
    console.error(`[${time}] [${type}] [${name}] ${message}`);
}

/* =========================================================
   REVERSE PROXY GATEWAY (PORT 25575)
========================================================= */

function startGateway(publicPort) {
    const proxy = httpProxy.createProxyServer({ ws: true });

    proxy.on("error", (err, req, res) => {
        if (res && res.writeHead) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("502 Bad Gateway: Service is starting up or offline.");
        } else if (res && res.destroy) {
            res.destroy();
        }
    });

    const server = http.createServer((req, res) => {
        // 1. CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "*");
        res.setHeader("Access-Control-Expose-Headers", "*");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        // 2. Route /ndfy or /ntfy to ndfy
        if (req.url.startsWith("/ndfy") || req.url.startsWith("/ntfy")) {
            proxy.web(req, res, { target: `http://127.0.0.1:${SERVICE_PORTS["ndfy"]}` });
        } else {
            // Everything else goes to llm-discord
            proxy.web(req, res, { target: `http://127.0.0.1:${SERVICE_PORTS["llm-discord"]}` });
        }
    });

    // Handle WebSockets
    server.on("upgrade", (req, socket, head) => {
        if (req.url.startsWith("/ndfy") || req.url.startsWith("/ntfy")) {
            proxy.ws(req, socket, head, { target: `http://127.0.0.1:${SERVICE_PORTS["ndfy"]}` });
        } else {
            proxy.ws(req, socket, head, { target: `http://127.0.0.1:${SERVICE_PORTS["llm-discord"]}` });
        }
    });

    server.listen(publicPort, () => {
        console.log("\n==========================================");
        console.log(` [GATEWAY ONLINE] Listening on public port ${publicPort}`);
        console.log(` -> /ndfy/* (or /ntfy/*) ==> ndfy (127.0.0.1:${SERVICE_PORTS["ndfy"]})`);
        console.log(` -> /*                   ==> llm-discord (127.0.0.1:${SERVICE_PORTS["llm-discord"]})`);
        console.log("==========================================\n");
    });

    return server;
}

/* =========================================================
   INSTALL DEPENDENCIES
========================================================= */

function installDependencies(packageName) {
    if (!installPackages.includes(packageName)) {
        return true;
    }

    const folder = path.join(__dirname, packageName);
    const packageJsonPath = path.join(folder, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
        logError("INSTALL ERROR", packageName, "package.json not found.");
        return false;
    }

    console.log(`[NPM INSTALL] ${packageName} -> installing dependencies...`);

    const packageLockPath = path.join(folder, "package-lock.json");
    const needsDev = buildPackages.includes(packageName);

    const args = fs.existsSync(packageLockPath)
        ? (needsDev ? ["ci", "--include=dev"] : ["ci", "--omit=dev"])
        : (needsDev ? ["install", "--include=dev"] : ["install", "--omit=dev"]);

    const result = spawnSync("npm", args, {
        cwd: folder,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: {
            ...process.env,
            ...(needsDev ? { NODE_ENV: "development", NPM_CONFIG_PRODUCTION: "false" } : {})
        }
    });

    if (result.error || result.status !== 0) {
        logError("NPM INSTALL FAILED", packageName, `Status: ${result.status}`);
        return false;
    }

    console.log(`[NPM INSTALL COMPLETE] ${packageName}`);
    return true;
}

/* =========================================================
   BUILD PACKAGES
========================================================= */

function buildPackage(packageName) {
    const folder = path.join(__dirname, packageName);
    const packageJsonPath = path.join(folder, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
        logError("BUILD", packageName, "package.json not found.");
        return false;
    }

    log("BUILD", packageName, "Running npm run build...");

    const result = spawnSync("npm", ["run", "build"], {
        cwd: folder,
        stdio: "inherit",
        shell: process.platform === "win32"
    });

    if (result.error || result.status !== 0) {
        logError("BUILD FAILED", packageName, `Status: ${result.status}`);
        return false;
    }

    log("BUILD COMPLETE", packageName, "Build finished.");
    return true;
}

/* =========================================================
   FIND BOT ENTRY POINT
========================================================= */

function getBotEntryPoint(botDir) {
    const packageJsonPath = path.join(botDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
            if (pkg.main) {
                const mainPath = path.join(botDir, pkg.main);
                if (fs.existsSync(mainPath)) {
                    return mainPath;
                }
            }
        } catch {}
    }

    const candidates = [
        path.join(botDir, "dist", "bundle.cjs"),
        path.join(botDir, "dist", "bundle.js"),
        path.join(botDir, "bundle.cjs"),
        path.join(botDir, "bundle.js"),
        path.join(botDir, "dist", "index.js"),
        path.join(botDir, "index.js")
    ];

    return candidates.find(file => fs.existsSync(file)) ?? null;
}

/* =========================================================
   START BOT
========================================================= */

function startBot(bot) {
    if (shuttingDown) return;

    const botFolder = path.join(__dirname, bot);
    if (!fs.existsSync(botFolder)) {
        logError("START", bot, "Bot directory not found.");
        return;
    }

    const botPath = getBotEntryPoint(botFolder);
    if (!botPath) {
        logError("START", bot, "No valid entry point found.");
        return;
    }

    log("START", bot, `Running ${botPath}`);

    // Override PORT so each child gets its dedicated internal port
    const childEnv = {
        ...process.env,
        BOT_NAME: bot,
        ...(SERVICE_PORTS[bot] ? { PORT: String(SERVICE_PORTS[bot]) } : {})
    };

    const child = spawn(process.execPath, [botPath], {
        cwd: botFolder,
        stdio: "inherit",
        env: childEnv,
        windowsHide: true
    });

    processes.set(bot, child);

    child.once("spawn", () => log("ONLINE", bot, `PID ${child.pid}`));
    child.once("error", error => logError("PROCESS ERROR", bot, error.message));
    child.once("exit", (code, signal) => {
        processes.delete(bot);
        if (shuttingDown) return;

        log("EXIT", bot, `code=${code}, signal=${signal}`);
        log("RESTART", bot, `Restarting in ${RESTART_DELAY / 1000}s...`);

        setTimeout(() => startBot(bot), RESTART_DELAY);
    });
}

/* =========================================================
   SHUTDOWN
========================================================= */

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[SHUTDOWN] Received ${signal}`);

    for (const [bot, child] of processes) {
        log("STOP", bot, `Stopping PID ${child.pid}`);
        try {
            child.kill("SIGTERM");
        } catch (error) {
            logError("STOP ERROR", bot, error.message);
        }
    }

    setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* =========================================================
   MAIN
========================================================= */

function main() {
    console.log("\n==========================================");
    console.log("           Discord Bot Manager");
    console.log("==========================================\n");

    // STEP 1: Install
    for (const packageName of installPackages) {
        if (!fs.existsSync(path.join(__dirname, packageName))) continue;
        installDependencies(packageName);
    }

    // STEP 2: Build
    for (const packageName of buildPackages) {
        buildPackage(packageName);
    }

    // STEP 3: Start Services
    for (const bot of bots) {
        startBot(bot);
    }

    // STEP 4: Start Public Gateway on Port 25575
    startGateway(PUBLIC_PORT);
}

main();
