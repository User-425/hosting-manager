import { spawnSync } from "child_process";
import { ROOT_DIR } from "./utils.js";
import { log, logError } from "./logger.js";
import { appConfig } from "./state.js";

let cachedPm2Command = null;

/**
 * Resolves the PM2 CLI command to use (either system `pm2`, custom configured path, or fallback to `npx pm2`).
 */
export function resolvePm2Command() {
    if (cachedPm2Command) {
        return cachedPm2Command;
    }

    if (process.env.PM2_CMD) {
        cachedPm2Command = process.env.PM2_CMD;
        return cachedPm2Command;
    }

    if (appConfig.settings?.pm2Path) {
        cachedPm2Command = appConfig.settings.pm2Path;
        return cachedPm2Command;
    }

    // Try testing system `pm2 -v`
    try {
        const testRes = spawnSync("pm2", ["-v"], {
            shell: true,
            encoding: "utf-8",
            stdio: "pipe",
            timeout: 4000
        });

        if (testRes.status === 0) {
            cachedPm2Command = "pm2";
            return cachedPm2Command;
        }
    } catch {
        // Ignored
    }

    // Fallback to npx pm2
    cachedPm2Command = "npx pm2";
    return cachedPm2Command;
}

/**
 * Executes a PM2 command synchronously and returns the output.
 */
export function executePm2(args, options = {}) {
    const cmd = resolvePm2Command();
    const fullArgs = cmd.startsWith("npx ") ? ["pm2", ...args] : args;
    const executable = cmd.startsWith("npx ") ? "npx" : cmd;

    const spawnEnv = {
        ...process.env,
        ...(options.env || {})
    };

    try {
        const res = spawnSync(executable, fullArgs, {
            cwd: options.cwd || ROOT_DIR,
            shell: true,
            encoding: "utf-8",
            env: spawnEnv,
            windowsHide: true,
            maxBuffer: 10 * 1024 * 1024
        });

        return {
            success: res.status === 0,
            status: res.status,
            stdout: res.stdout || "",
            stderr: res.stderr || "",
            error: res.error || null
        };
    } catch (err) {
        return {
            success: false,
            status: -1,
            stdout: "",
            stderr: err.message,
            error: err
        };
    }
}

/**
 * Retrieves the parsed process list from PM2 (`pm2 jlist`).
 */
export function pm2GetProcessList() {
    const res = executePm2(["jlist"]);
    if (!res.stdout) {
        return [];
    }

    try {
        const raw = res.stdout.trim();
        const startIdx = raw.indexOf("[");
        const endIdx = raw.lastIndexOf("]");

        if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
            return [];
        }

        const jsonStr = raw.substring(startIdx, endIdx + 1);
        return JSON.parse(jsonStr);
    } catch (err) {
        logError("PM2", "JLIST", `Failed to parse PM2 jlist output: ${err.message}`);
        return [];
    }
}

/**
 * Finds a specific process description in PM2 by name.
 */
export function pm2FindProcess(name) {
    const list = pm2GetProcessList();
    return list.find((p) => p.name === name) || null;
}

/**
 * Launches a service with PM2: `pm2 start <entryPoint> --name <name> [pm2Args]`
 */
export function pm2Start(name, entryPoint, cwd, env = {}, pm2Args = []) {
    const existing = pm2FindProcess(name);

    if (existing) {
        const status = existing.pm2_env?.status;
        if (status === "online") {
            log("INFO", name, `[PM2] Service "${name}" is already running in PM2 (PID ${existing.pid}).`);
            return { success: true, message: "Already running" };
        }

        // Restart with updated env and entrypoint if already registered
        log("START", name, `[PM2] Resuming existing PM2 service "${name}"...`);
        const restartRes = executePm2(["restart", name, "--update-env"], { cwd, env });
        if (!restartRes.success) {
            logError("PM2 START ERROR", name, restartRes.stderr || restartRes.stdout);
            return { success: false, message: restartRes.stderr };
        }
        return { success: true, message: "Restarted" };
    }

    const args = [
        "start",
        entryPoint,
        "--name",
        name,
        ...(Array.isArray(pm2Args) ? pm2Args : [])
    ];

    log("START", name, `[PM2] Launching: pm2 ${args.join(" ")}`);
    const startRes = executePm2(args, { cwd, env });

    if (!startRes.success) {
        logError("PM2 START ERROR", name, startRes.stderr || startRes.stdout);
        return { success: false, message: startRes.stderr };
    }

    return { success: true, message: "Started" };
}

/**
 * Stops a service running under PM2: `pm2 stop <name>`
 */
export function pm2Stop(name) {
    log("STOP", name, `[PM2] Stopping service "${name}"...`);
    const res = executePm2(["stop", name]);
    if (!res.success && !res.stderr.includes("not found")) {
        logError("PM2 STOP ERROR", name, res.stderr || res.stdout);
        return false;
    }
    return true;
}

/**
 * Restarts a service running under PM2: `pm2 restart <name> --update-env`
 */
export function pm2Restart(name, env = {}) {
    log("RESTART", name, `[PM2] Restarting service "${name}"...`);
    const res = executePm2(["restart", name, "--update-env"], { env });
    if (!res.success) {
        logError("PM2 RESTART ERROR", name, res.stderr || res.stdout);
        return false;
    }
    return true;
}

/**
 * Deletes a service from PM2: `pm2 delete <name>`
 */
export function pm2Delete(name) {
    log("DELETE", name, `[PM2] Deleting service "${name}" from PM2...`);
    const res = executePm2(["delete", name]);
    return res.success;
}

/**
 * Fetches recent logs for a PM2 service: `pm2 logs <name> --lines <lines> --nostream`
 */
export function pm2GetLogs(name, lines = 50) {
    const res = executePm2(["logs", name, "--lines", String(lines), "--nostream"]);
    return res.stdout || res.stderr || "No log output available.";
}
