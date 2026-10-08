import fs from "fs";
import path from "path";
import { ROOT_DIR } from "./utils.js";
import { logError } from "./logger.js";

export const systemEnv = { ...process.env };

export function getResolvedConfigPath() {
    const plural = path.join(ROOT_DIR, "services.json");
    const singular = path.join(ROOT_DIR, "service.json");
    if (fs.existsSync(plural)) return plural;
    if (fs.existsSync(singular)) return singular;
    return plural;
}

export const CONFIG_PATH = getResolvedConfigPath();

export function loadEnv() {
    const envPath = path.join(ROOT_DIR, ".env");
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

export function loadConfig() {
    const resolvedPath = getResolvedConfigPath();
    if (!fs.existsSync(resolvedPath)) {
        logError("CONFIG", "SYSTEM", `Configuration file not found at ${resolvedPath}`);
        return null;
    }

    try {
        const raw = fs.readFileSync(resolvedPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed.services || typeof parsed.services !== "object") {
            throw new Error("Invalid config format: 'services' object is missing.");
        }
        return parsed;
    } catch (err) {
        logError("CONFIG", "SYSTEM", `Failed to read or parse configuration (${resolvedPath}): ${err.message}`);
        return null;
    }
}
