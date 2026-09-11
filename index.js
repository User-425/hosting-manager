import { loadEnv, loadConfig } from "./src/config.js";
import { appConfig, setAppConfig, serviceRegistry, shuttingDown, setShuttingDown } from "./src/state.js";
import { log, logError } from "./src/logger.js";
import { startService, stopService, watchConfigFile } from "./src/process-manager.js";
import { installDependencies, buildPackage } from "./src/builder.js";
import { startGateway } from "./src/gateway.js";
import { setupConsoleCLI } from "./src/cli.js";

loadEnv();

function shutdown(signal) {
    if (shuttingDown) return;
    setShuttingDown(true);

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

process.on("uncaughtException", (err) => {
    logError("UNCAUGHT EXCEPTION", "SYSTEM", err.stack || err.message);
});

process.on("unhandledRejection", (reason) => {
    logError("UNHANDLED REJECTION", "SYSTEM", String(reason));
});

async function main() {
    console.log("\n========================================================");
    console.log("            Robust Multi-Service Gateway Manager        ");
    console.log("========================================================\n");

    const loaded = loadConfig();
    if (loaded) {
        setAppConfig(loaded);
    }

    const publicPort = Number(process.env.PORT) || appConfig.settings?.publicPort || 25575;

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

    log("INIT", "SYSTEM", "Starting configured services...");
    for (const [name, conf] of Object.entries(appConfig.services)) {
        if (conf.enabled) {
            startService(name);
        }
    }

    startGateway(publicPort);
    watchConfigFile();
    setupConsoleCLI();

    log("READY", "SYSTEM", "Manager is operational. Type 'help' or 'status' in console.");
}

main();
