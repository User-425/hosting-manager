import readline from "readline";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { appConfig, serviceRegistry } from "./state.js";
import { ROOT_DIR } from "./utils.js";
import { startService, stopService, restartService, reloadConfig } from "./process-manager.js";
import { installDependencies, buildPackage } from "./builder.js";

export function setupConsoleCLI() {
    if (!process.stdin.isTTY) {
        return;
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
                    console.log("Usage: start <service-name> (or 'start all')");
                    break;
                }
                if (target === "all") {
                    console.log("Starting all enabled services...");
                    for (const [name, conf] of Object.entries(appConfig.services)) {
                        if (conf.enabled) {
                            startService(name, true);
                        }
                    }
                } else {
                    startService(target, true);
                }
                break;
            }

            case "stop": {
                if (!target) {
                    console.log("Usage: stop <service-name> (or 'stop all')");
                    break;
                }
                if (target === "all") {
                    console.log("Stopping all services...");
                    for (const name of serviceRegistry.keys()) {
                        stopService(name);
                    }
                } else {
                    stopService(target);
                }
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

            case "exec":
            case "cmd": {
                if (args.length < 2) {
                    console.log("Usage: exec <service-name | .> <command...>");
                    console.log("Example: exec discord-bot npm test");
                    console.log("Example: exec . curl http://localhost:25575/_health");
                    break;
                }

                const targetDir = target === "." ? ROOT_DIR : path.resolve(ROOT_DIR, target);
                const rawCmd = args.slice(1).join(" ");

                if (!fs.existsSync(targetDir)) {
                    console.log(`[EXEC ERROR] Directory "${targetDir}" does not exist.`);
                    break;
                }

                console.log(`\n[Directory]: ${targetDir}`);
                console.log(`[Running]  : ${rawCmd}\n`);

                const res = spawnSync(rawCmd, {
                    cwd: targetDir,
                    stdio: "inherit",
                    shell: true,
                    env: process.env
                });

                if (res.error) {
                    console.error(`[EXEC ERROR]: ${res.error.message}`);
                }
                break;
            }

            case "clear":
            case "cls": {
                console.clear();
                break;
            }

            case "help": {
                console.log(`
┌─────────────────────────────────────────────────────────────┐
│                 HOSTING MANAGER CLI COMMANDS                │
├─────────────────────────────────────────────────────────────┤
│  status | list | ls - Show status table of all services     │
│  restart <name>     - Restart a specific service (or 'all') │
│  start <name>       - Start an individual service (or 'all')│
│  stop <name>        - Stop an individual service (or 'all') │
│  reload             - Re-read services.json and apply       │
│  install <name>     - Run npm install for a service         │
│  build <name>       - Run npm run build for a service       │
│  exec <name|.> <cmd>- Run any custom command in directory   │
│  clear | cls        - Clear the console screen              │
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
