import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load root .env
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
}

const args = process.argv.slice(2);

if (args.length < 1) {
    console.log(`
Usage:
  node exec.js <service|path|.> <command...>
  node exec.js <service> npm <script>

Examples:
  node exec.js discord-bot npm test
  node exec.js . curl http://localhost:25575/_health
  node exec.js discord-bot git pull
    `);
    process.exit(0);
}

const [target, ...cmdArgs] = args;
const targetDir = target === "." ? __dirname : path.resolve(__dirname, target);

if (!fs.existsSync(targetDir)) {
    console.error(`[EXEC ERROR] Target directory does not exist: ${targetDir}`);
    process.exit(1);
}

// If no command provided after target, default to interactive shell or status
const command = cmdArgs.length > 0 ? cmdArgs.join(" ") : (process.platform === "win32" ? "cmd.exe" : "bash");

console.log(`\n[Directory]: ${targetDir}`);
console.log(`[Running]  : ${command}\n`);

const child = spawn(command, {
    cwd: targetDir,
    stdio: "inherit",
    shell: true,
    env: {
        ...process.env,
        // Inherit subfolder .env if it exists
        ...(fs.existsSync(path.join(targetDir, ".env")) ? {} : {})
    }
});

child.on("exit", (code) => {
    process.exit(code ?? 0);
});
