import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { ROOT_DIR } from "./utils.js";
import { log, logError } from "./logger.js";

export function installDependencies(serviceName, subFolder = "", isDev = false) {
    const targetFolder = path.join(ROOT_DIR, serviceName, subFolder);
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

export function buildPackage(serviceName, subFolder = "") {
    const targetFolder = path.join(ROOT_DIR, serviceName, subFolder);
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
