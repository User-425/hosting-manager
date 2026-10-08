import readline from "readline";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { appConfig, serviceRegistry } from "./state.js";
import { ROOT_DIR } from "./utils.js";
import {
  startService,
  stopService,
  restartService,
  reloadConfig,
  syncPm2Status
} from "./process-manager.js";
import { installDependencies, buildPackage } from "./builder.js";
import { pm2GetLogs } from "./pm2-manager.js";

function getProcessMemory(pid) {
  if (!pid || process.platform !== "linux") {
    return null;
  }

  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);

    return match ? Number(match[1]) / 1024 : null;
  } catch {
    return null;
  }
}

export function formatTable(data) {
  if (!Array.isArray(data) || data.length === 0) return "No data to display.";
  const columns = Object.keys(data[0]);
  const colWidths = {};
  for (const col of columns) {
    colWidths[col] = col.length;
  }
  for (const row of data) {
    for (const col of columns) {
      const valStr = String(row[col] ?? "");
      colWidths[col] = Math.max(colWidths[col], valStr.length);
    }
  }

  const topBorder = "┌─" + columns.map((c) => "─".repeat(colWidths[c])).join("─┬─") + "─┐";
  const midBorder = "├─" + columns.map((c) => "─".repeat(colWidths[c])).join("─┼─") + "─┤";
  const botBorder = "└─" + columns.map((c) => "─".repeat(colWidths[c])).join("─┴─") + "─┘";

  const headerRow = "│ " + columns.map((c) => c.padEnd(colWidths[c])).join(" │ ") + " │";
  const rows = data.map((row) => {
    return "│ " + columns.map((c) => String(row[c] ?? "").padEnd(colWidths[c])).join(" │ ") + " │";
  });

  return [topBorder, headerRow, midBorder, ...rows, botBorder].join("\n");
}

export async function executeCommand(inputStr, logFn = console.log, errFn = console.error) {
  const input = inputStr.trim();
  if (!input) return;

  const [command, ...args] = input.split(/\s+/);
  const target = args[0];

  switch (command.toLowerCase()) {
    case "status":
    case "list":
    case "ls": {
      syncPm2Status();

      const tableData = [];
      for (const [name, conf] of Object.entries(appConfig.services)) {
        const state = serviceRegistry.get(name);
        const runner = state?.runner || conf.runner || appConfig.settings?.runner || "builtin";
        const isRunning = state?.status === "RUNNING";
        const uptime =
          isRunning && state?.startTime
            ? `${Math.floor((Date.now() - state.startTime) / 1000)}s`
            : "-";

        const pid = state?.pid || state?.child?.pid;

        let memoryStr = "-";
        if (state?.memory !== null && state?.memory !== undefined) {
          memoryStr = `${state.memory.toFixed(1)} MB`;
        } else if (pid) {
          const linuxMem = getProcessMemory(pid);
          if (linuxMem !== null) memoryStr = `${linuxMem.toFixed(1)} MB`;
        }

        tableData.push({
          Service: name,
          Runner: runner,
          Configured: conf.enabled ? "Enabled" : "Disabled",
          Status: state?.status || "STOPPED",
          PID: pid || "-",
          Port: conf.port || "-",
          Memory: memoryStr,
          Routes: conf.routes ? conf.routes.join(", ") : "-",
          Uptime: uptime,
          Crashes: state?.restartCount || 0,
        });
      }

      if (logFn === console.log) {
        console.table(tableData);
      } else {
        logFn(formatTable(tableData));
      }
      break;
    }

    case "restart": {
      if (!target) {
        logFn("Usage: restart <service-name> (or 'restart all')");
        break;
      }
      if (target === "all") {
        logFn("Restarting all enabled services...");
        for (const name of Object.keys(appConfig.services)) {
          restartService(name);
        }
      } else {
        restartService(target);
        logFn(`Restart triggered for service "${target}".`);
      }
      break;
    }

    case "start": {
      if (!target) {
        logFn("Usage: start <service-name> (or 'start all')");
        break;
      }
      if (target === "all") {
        logFn("Starting all enabled services...");
        for (const [name, conf] of Object.entries(appConfig.services)) {
          if (conf.enabled) {
            startService(name, true);
          }
        }
      } else {
        startService(target, true);
        logFn(`Start triggered for service "${target}".`);
      }
      break;
    }

    case "stop": {
      if (!target) {
        logFn("Usage: stop <service-name> (or 'stop all')");
        break;
      }
      if (target === "all") {
        logFn("Stopping all services...");
        for (const name of serviceRegistry.keys()) {
          stopService(name);
        }
      } else {
        stopService(target);
        logFn(`Stop triggered for service "${target}".`);
      }
      break;
    }

    case "logs":
    case "log": {
      if (!target) {
        logFn("Usage: logs <service-name> [lines]");
        break;
      }

      const conf = appConfig.services[target];
      const state = serviceRegistry.get(target);
      if (!conf && !state) {
        logFn(`[LOGS ERROR] Service "${target}" not found.`);
        break;
      }

      const runner = state?.runner || conf?.runner || appConfig.settings?.runner || "builtin";
      const lines = Number(args[1]) || 50;

      if (runner === "pm2") {
        logFn(`\n--- PM2 Logs: ${target} (Last ${lines} lines) ---`);
        logFn(pm2GetLogs(target, lines));
        logFn(`---------------------------------------------------\n`);
      } else {
        logFn(`[LOGS] Service "${target}" runs on the builtin runner. Its logs stream live directly to host stdout.`);
      }
      break;
    }

    case "reload": {
      await reloadConfig();
      logFn("[CONFIG] Reload complete.");
      break;
    }

    case "install": {
      if (!target) {
        logFn("Usage: install <service-name>");
        break;
      }
      const conf = appConfig.services[target];
      installDependencies(target, "", conf?.build);
      if (conf?.subProjects) {
        for (const sub of conf.subProjects) {
          if (sub.install) installDependencies(target, sub.path, sub.build);
        }
      }
      logFn(`[INSTALL] Dependency installation finished for "${target}".`);
      break;
    }

    case "build": {
      if (!target) {
        logFn("Usage: build <service-name>");
        break;
      }
      const conf = appConfig.services[target];
      if (conf?.build) buildPackage(target);
      if (conf?.subProjects) {
        for (const sub of conf.subProjects) {
          if (sub.build) buildPackage(target, sub.path);
        }
      }
      logFn(`[BUILD] Build finished for "${target}".`);
      break;
    }

    case "exec":
    case "cmd": {
      if (args.length < 2) {
        logFn("Usage: exec <service-name | .> <command...>");
        logFn("Example: exec discord-bot npm test");
        logFn("Example: exec . curl http://localhost:25575/_health");
        break;
      }

      const targetDir = target === "." ? ROOT_DIR : path.resolve(ROOT_DIR, target);
      const rawCmd = args.slice(1).join(" ");

      if (!fs.existsSync(targetDir)) {
        logFn(`[EXEC ERROR] Directory "${targetDir}" does not exist.`);
        break;
      }

      logFn(`[Directory]: ${targetDir}`);
      logFn(`[Running]  : ${rawCmd}\n`);

      const res = spawnSync(rawCmd, {
        cwd: targetDir,
        stdio: "pipe",
        shell: true,
        env: process.env,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024
      });

      if (res.stdout) logFn(res.stdout);
      if (res.stderr) errFn(res.stderr);
      if (res.error) errFn(`[EXEC ERROR]: ${res.error.message}`);
      break;
    }

    case "ntfy": {
      if (args.length < 2) {
        logFn("Usage: ntfy <topic> <message...>");
        logFn("Example: ntfy my_alerts Server is starting!");
        break;
      }
      const ntfyTopic = args[0];
      const ntfyMessage = args.slice(1).join(" ");

      const serverUrlStr =
        appConfig.settings.ntfyServer ||
        process.env.NTFY_SERVER ||
        "https://ntfy.sh";
      const auth = appConfig.settings.ntfyAuth || process.env.NTFY_AUTH || "";
      const serverUrl = serverUrlStr.endsWith("/")
        ? serverUrlStr.slice(0, -1)
        : serverUrlStr;

      const headers = { Title: "Hosting Manager" };
      if (auth) {
        headers["Authorization"] = auth;
      }

      try {
        const response = await fetch(`${serverUrl}/${ntfyTopic}`, {
          method: "POST",
          body: ntfyMessage,
          headers,
        });
        if (response.ok) {
          logFn(`[NTFY] Notification sent to topic "${ntfyTopic}" successfully.`);
        } else {
          errFn(`[NTFY ERROR] Failed to send notification: ${response.status} ${response.statusText}`);
        }
      } catch (err) {
        errFn(`[NTFY ERROR] Exception: ${err.message}`);
      }
      break;
    }

    case "clear":
    case "cls": {
      if (logFn === console.log) {
        console.clear();
      } else {
        logFn("__CLEAR__");
      }
      break;
    }

    case "help": {
      logFn(`
┌─────────────────────────────────────────────────────────────┐
│                 HOSTING MANAGER CLI COMMANDS                │
├─────────────────────────────────────────────────────────────┤
│  status | list | ls - Show status table of all services     │
│  restart <name>     - Restart a specific service (or 'all') │
│  start <name>       - Start an individual service (or 'all')│
│  stop <name>        - Stop an individual service (or 'all') │
│  logs <name> [n]    - View recent PM2 logs for a service    │
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
      logFn(`Unknown command: "${command}". Type "help" for a list of commands.`);
      break;
  }
}

export async function processCommand(inputStr) {
  return executeCommand(inputStr, console.log, console.error);
}

export function setupConsoleCLI() {
  if (!process.stdin.isTTY) {
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "",
  });

  rl.on("line", async (line) => {
    await processCommand(line);
  });
}
