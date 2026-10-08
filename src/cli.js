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

export async function processCommand(inputStr) {
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

    case "logs":
    case "log": {
      if (!target) {
        console.log("Usage: logs <service-name> [lines]");
        break;
      }

      const conf = appConfig.services[target];
      const state = serviceRegistry.get(target);
      if (!conf && !state) {
        console.log(`[LOGS ERROR] Service "${target}" not found.`);
        break;
      }

      const runner = state?.runner || conf?.runner || appConfig.settings?.runner || "builtin";
      const lines = Number(args[1]) || 50;

      if (runner === "pm2") {
        console.log(`\n--- PM2 Logs: ${target} (Last ${lines} lines) ---`);
        console.log(pm2GetLogs(target, lines));
        console.log(`---------------------------------------------------\n`);
      } else {
        console.log(`[LOGS] Service "${target}" runs on the builtin runner. Its logs stream live directly to this console.`);
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

      const targetDir =
        target === "." ? ROOT_DIR : path.resolve(ROOT_DIR, target);
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
        env: process.env,
      });

      if (res.error) {
        console.error(`[EXEC ERROR]: ${res.error.message}`);
      }
      break;
    }

    case "ntfy": {
      if (args.length < 2) {
        console.log("Usage: ntfy <topic> <message...>");
        console.log("Example: ntfy my_alerts Server is starting!");
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
          console.log(
            `[NTFY] Notification sent to topic "${ntfyTopic}" successfully.`,
          );
        } else {
          console.error(
            `[NTFY ERROR] Failed to send notification: ${response.status} ${response.statusText}`,
          );
        }
      } catch (err) {
        console.error(`[NTFY ERROR] Exception: ${err.message}`);
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
      console.log(
        `Unknown command: "${command}". Type "help" for a list of commands.`,
      );
      break;
  }
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
