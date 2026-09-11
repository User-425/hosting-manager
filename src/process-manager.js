import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { ROOT_DIR } from "./utils.js";
import { log, logError } from "./logger.js";
import { appConfig, setAppConfig, serviceRegistry, shuttingDown } from "./state.js";
import { loadConfig, CONFIG_PATH } from "./config.js";

export function getServiceEntryPoint(serviceDir) {
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

    if (isManual) {
        state.restartCount = 0;
        state.backoffDelay = appConfig.settings.restartDelayMs || 3000;
    }

    if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }

    const serviceFolder = path.join(ROOT_DIR, name);
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
        if (conf.enabled) {
            if (!state || state.status === "STOPPED") {
                log("CONFIG", name, "Starting enabled service...");
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
        if (!appConfig.services[name] && (state.status === "RUNNING" || state.status === "STARTING" || state.child || state.restartTimer)) {
            log("CONFIG", name, "Service was removed from configuration. Stopping...");
            stopService(name);
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
