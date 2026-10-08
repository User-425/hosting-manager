import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { ROOT_DIR } from "./utils.js";
import { log, logError } from "./logger.js";
import { appConfig, setAppConfig, serviceRegistry, shuttingDown } from "./state.js";
import { loadConfig, CONFIG_PATH, systemEnv } from "./config.js";
import { pm2Start, pm2Stop, pm2Restart, pm2Delete, pm2GetProcessList } from "./pm2-manager.js";

export function getServiceEntryPoint(serviceDir) {
    if (!fs.existsSync(serviceDir)) return null;

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

export function getOrCreateServiceState(name) {
    let state = serviceRegistry.get(name);
    if (!state) {
        const conf = appConfig.services[name] || {};
        state = {
            child: null,
            status: "STOPPED",
            runner: conf.runner || appConfig.settings?.runner || "builtin",
            pid: null,
            memory: null,
            startTime: null,
            restartCount: 0,
            lastCrashTime: 0,
            backoffDelay: appConfig.settings?.restartDelayMs || 3000,
            restartTimer: null,
            port: conf.port || null,
            routes: conf.routes || []
        };
        serviceRegistry.set(name, state);
    }
    return state;
}

/**
 * Synchronizes live state from PM2 (`pm2 jlist`) into the service registry for all PM2-backed services.
 */
export function syncPm2Status() {
    const list = pm2GetProcessList();
    const pm2Map = new Map(list.map((p) => [p.name, p]));

    for (const [name, state] of serviceRegistry.entries()) {
        const conf = appConfig.services[name];
        const runner = state.runner || conf?.runner || appConfig.settings?.runner || "builtin";
        if (runner !== "pm2") continue;

        state.runner = "pm2";
        const proc = pm2Map.get(name);
        if (proc) {
            state.pid = proc.pid || null;
            state.restartCount = proc.pm2_env?.restart_time || 0;
            state.startTime = proc.pm2_env?.pm_uptime || state.startTime;
            state.memory = proc.monit?.memory ? proc.monit.memory / (1024 * 1024) : null;

            const pm2Status = proc.pm2_env?.status;
            if (pm2Status === "online") {
                state.status = "RUNNING";
            } else if (pm2Status === "launching") {
                state.status = "STARTING";
            } else if (pm2Status === "stopping" || pm2Status === "stopped") {
                state.status = "STOPPED";
            } else if (pm2Status === "errored") {
                state.status = "CRASHED";
            } else {
                state.status = pm2Status ? pm2Status.toUpperCase() : "STOPPED";
            }
        } else if (state.status === "RUNNING") {
            state.status = "STOPPED";
            state.pid = null;
        }
    }
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

    const runner = conf.runner || appConfig.settings?.runner || "builtin";
    const state = getOrCreateServiceState(name);
    state.runner = runner;

    if (runner === "builtin" && state.status === "RUNNING" && state.child) {
        log("WARN", name, `Service "${name}" is already running (PID ${state.child.pid}).`);
        return;
    }

    if (isManual) {
        state.restartCount = 0;
        state.backoffDelay = appConfig.settings?.restartDelayMs || 3000;
    }

    if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }

    const customCwd = conf.cwd ? path.resolve(ROOT_DIR, conf.cwd) : null;
    const localFolder = path.join(ROOT_DIR, name);
    const serviceFolder = customCwd || (fs.existsSync(localFolder) ? localFolder : ROOT_DIR);

    if (customCwd && !fs.existsSync(customCwd)) {
        logError("START", name, `Configured working directory "${customCwd}" does not exist.`);
        state.status = "STOPPED";
        return;
    }

    let entryPoint = conf.script || conf.entryPoint || conf.command || null;
    if (entryPoint) {
        const potentialPath = path.resolve(serviceFolder, entryPoint);
        if (fs.existsSync(potentialPath)) {
            entryPoint = potentialPath;
        }
    } else {
        entryPoint = getServiceEntryPoint(serviceFolder);
        if (!entryPoint && runner === "pm2") {
            // For PM2 global binaries/tools, fallback to the service name itself
            entryPoint = name;
        }
    }

    if (!entryPoint) {
        logError("START", name, `No valid entry point found (checked package.json main, src/index.js, index.js, dist/).`);
        state.status = "STOPPED";
        return;
    }

    if (runner === "builtin" && !fs.existsSync(entryPoint)) {
        logError("START", name, `Entry point "${entryPoint}" does not exist on disk.`);
        state.status = "STOPPED";
        return;
    }

    state.port = conf.port || null;
    state.routes = conf.routes || [];

    const childEnv = {
        ...systemEnv,
        BOT_NAME: name,
        ...(conf.port ? { PORT: String(conf.port) } : {})
    };

    if (runner === "pm2") {
        state.status = "STARTING";
        const res = pm2Start(name, entryPoint, serviceFolder, childEnv, conf.pm2Args || []);
        if (res.success) {
            state.status = "RUNNING";
            state.startTime = Date.now();
            syncPm2Status();
        } else {
            state.status = "STOPPED";
        }
        return;
    }

    // Builtin runner
    state.status = "STARTING";
    log("START", name, `Launching ${entryPoint} (Runner: builtin)`);

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
        if (state.child === child) {
            state.child = null;
            state.status = "STOPPED";
        }

        if (shuttingDown) return;

        if (child.intentionalStop) {
            log("EXIT", name, `Service stopped (code ${code ?? "none"}, signal ${signal ?? "none"}).`);
            return;
        }

        log("EXIT", name, `Exited with code ${code}, signal ${signal}`);

        const now = Date.now();
        const crashWindow = appConfig.settings.crashWindowMs || 60000;
        const maxCrashes = appConfig.settings.maxCrashCount || 5;

        if (now - state.lastCrashTime > crashWindow) {
            state.restartCount = 0;
            state.backoffDelay = appConfig.settings.restartDelayMs || 3000;
        }

        state.restartCount++;
        state.lastCrashTime = now;

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

        state.backoffDelay = Math.min(state.backoffDelay * 1.5, 30000);
    });
}

export function stopService(name) {
    const state = serviceRegistry.get(name);
    const conf = appConfig.services[name];
    const runner = state?.runner || conf?.runner || appConfig.settings?.runner || "builtin";

    if (runner === "pm2") {
        if (state?.restartTimer) {
            clearTimeout(state.restartTimer);
            state.restartTimer = null;
        }
        pm2Stop(name);
        if (state) {
            state.status = "STOPPED";
            state.pid = null;
        }
        return;
    }

    if (!state || (!state.child && !state.restartTimer)) {
        log("INFO", name, "Service is not currently running or scheduled to restart.");
        return;
    }

    if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }

    if (state.child) {
        state.child.intentionalStop = true;
        const pid = state.child.pid;
        if (pid) {
            log("STOP", name, `Terminating PID ${pid}...`);
            try {
                if (process.platform === "win32") {
                    spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"]);
                } else {
                    state.child.kill("SIGTERM");
                }
            } catch (err) {
                logError("STOP ERROR", name, err.message);
            }
        }
    }

    state.status = "STOPPED";
    state.child = null;
}

export function restartService(name) {
    const state = serviceRegistry.get(name);
    const conf = appConfig.services[name];
    const runner = state?.runner || conf?.runner || appConfig.settings?.runner || "builtin";

    log("RESTART", name, `Restart requested for "${name}" (Runner: ${runner})`);

    if (runner === "pm2") {
        const childEnv = {
            ...systemEnv,
            BOT_NAME: name,
            ...(conf?.port ? { PORT: String(conf.port) } : {})
        };
        pm2Restart(name, childEnv);
        if (state) {
            state.restartCount = 0;
            state.status = "RUNNING";
            state.startTime = Date.now();
        }
        syncPm2Status();
        return;
    }

    stopService(name);

    if (state) {
        state.restartCount = 0;
        state.backoffDelay = appConfig.settings?.restartDelayMs || 3000;
    }

    setTimeout(() => {
        startService(name, true);
    }, 1000);
}

export async function reloadConfig() {
    log("CONFIG", "SYSTEM", "Synchronizing configuration with services.json...");
    const freshConfig = loadConfig();
    if (!freshConfig) {
        logError("CONFIG", "SYSTEM", "Sync aborted due to invalid services.json.");
        return;
    }

    setAppConfig(freshConfig);

    for (const [name, conf] of Object.entries(appConfig.services)) {
        const state = serviceRegistry.get(name);
        const runner = conf.runner || appConfig.settings?.runner || "builtin";
        if (state) state.runner = runner;

        if (conf.enabled) {
            if (!state || state.status === "STOPPED") {
                log("CONFIG", name, `Starting enabled service (Runner: ${runner})...`);
                startService(name);
            } else {
                state.port = conf.port || null;
                state.routes = conf.routes || [];
            }
        } else if (!conf.enabled && (state?.status === "RUNNING" || state?.status === "STARTING" || state?.child || state?.restartTimer)) {
            log("CONFIG", name, "Stopping disabled service...");
            stopService(name);
        }
    }

    for (const [name, state] of serviceRegistry) {
        if (!appConfig.services[name]) {
            if (state.status === "RUNNING" || state.status === "STARTING" || state.child || state.restartTimer) {
                log("CONFIG", name, "Service was removed from configuration. Stopping...");
                stopService(name);
            }
            if (state.runner === "pm2") {
                pm2Delete(name);
            }
        }
    }

    log("CONFIG", "SYSTEM", "Configuration synchronization complete.");
}

export function watchConfigFile() {
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
