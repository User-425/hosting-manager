# Hosting Manager
One server, multiple apps. Run all your Node.js services under a single entry instance.

A multi-bot and service manager with a dynamic reverse proxy gateway, hybrid process runners (Built-in Supervisor & PM2), automatic crash recovery, live configuration watching, and interactive CLI management.

![Hosting Manager Preview](docs/preview.png)

---

## Why Hosting Manager?

Many budget hosting providers, PaaS platforms, and bot panels limit deployments to a **single entry point** (`npm start`) and a **single public port**. Running multiple bots, webhooks, or dashboards traditionally requires purchasing multiple hosting plans or configuring complex Nginx/Docker setups.

**Hosting Manager enables your hosting environment to support multiple applications simultaneously:**

- **Multiple Applications on One Instance**: Run multiple independent bots, webhooks, and APIs concurrently in isolated processes under a single root command.
- **Hybrid Process Runners**: Choose between the zero-dependency built-in child process supervisor or native **PM2** process management (`pm2 start <entryPoint> --name <name>`) per service or globally.
- **Single Public Port Routing**: Route incoming HTTP and WebSocket traffic (e.g., `/api`, `/dashboard`, `/bot`) to different internal services using the integrated reverse proxy gateway.
- **Process Isolation and Self-Healing**: If one service crashes, other services remain uninterrupted while the circuit breaker or PM2 manages automatic retries.
- **Zero-Downtime Configuration**: Add, enable, or disable services dynamically by editing `services.json`—the file watcher updates processes without restarting the host.
- **Zero Configuration Overhead**: Run with standard Node.js or PM2 without complex reverse proxy servers.

---

## Features

- **Hybrid Process Runners (Builtin & PM2)**: Seamlessly run services using either Node's built-in process supervisor or PM2 (`pm2 start <entryPoint> --name <name>`), automatically auto-detecting system `pm2` or falling back to `npx pm2`.
- **Dynamic Reverse Proxy Gateway**: Built-in HTTP and WebSocket proxying (`http-proxy`) with route-based request dispatching to backend services.
- **Resilience and Circuit Breaking**: Automatic crash recovery with exponential backoff and circuit breaking for built-in services, plus native PM2 crash supervision.
- **Live State Synchronization**: Direct `pm2 jlist` integration to reflect real-time PIDs, memory consumption, uptime, and restart counts.
- **Hot-Reloading and File Watcher**: Automatically detects and applies updates to `services.json` at runtime without restarting the main manager process.
- **Interactive REPL Console**: Built-in CLI with live status tables, logs inspection, and commands to start, stop, restart, install, and build individual services.
- **RESTful Management API**: Endpoints (`/_health`, `/_status`, `/_manage`) for remote monitoring, health checks, log retrieval, and service orchestration.
- **Automated Dependency and Build Pipeline**: Automatically triggers `npm install` / `npm ci` and `npm run build` on startup or on demand, including nested sub-projects.
- **Entry Point Resolution**: Automatically detects entry points via `package.json` (`main`), `src/index.js`, `dist/`, `bundle.cjs`, or root `index.js`, with optional manual overrides.

---

## Architecture Overview

```
                          ┌───────────────────────────┐
                          │   Public Gateway (Port)   │
                          │   HTTP / WebSocket Proxy  │
                          └─────────────┬─────────────┘
                                        │
           ┌────────────────────────────┼────────────────────────────┐
           │ Routes: /api, /service-a   │ Routes: /                  │ Background / Non-routed
           ▼                            ▼                            ▼
   ┌───────────────┐            ┌───────────────┐            ┌───────────────┐
   │   Service A   │            │   Service B   │            │   Worker /    │
   │  (Port 8003)  │            │  (Port 8004)  │            │   Bot Service │
   │  Runner: PM2  │            │Runner: Builtin│            │  Runner: PM2  │
   └───────────────┘            └───────────────┘            └───────────────┘
```

---

## Getting Started

### 1. Prerequisites

- Node.js v18.0.0 or higher
- npm v9.0.0 or higher
- *(Optional)* PM2 installed globally (`npm install -g pm2`) or available via `npx`

### 2. Installation

Clone the repository and install the root gateway dependencies:

```bash
git clone https://github.com/User-425/hosting-manager.git
cd hosting-manager
npm install
```

### 3. Environment Configuration

Copy the example environment file and configure settings:

```bash
cp .env.example .env
```

Configuration variables:

```env
PORT=8000
ADMIN_SECRET=your_super_secret_admin_key
NODE_ENV=production
```

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Public port the reverse proxy gateway listens on | `25575` |
| `ADMIN_SECRET` | Secret token used to authenticate Admin API endpoints | `hosting_admin_key` |
| `NODE_ENV` | Environment mode (`production` or `development`) | `development` |
| `PM2_CMD` | Custom PM2 executable command / path | Auto-detected (`pm2` or `npx pm2`) |
| `NTFY_ENABLED` | Enable or disable the ntfy integration | `true` |
| `NTFY_TOPIC` | Ntfy topic to listen to for incoming remote commands | - |
| `NTFY_SERVER` | Custom ntfy server URL | `https://ntfy.sh` |
| `NTFY_AUTH` | Authorization header for private ntfy topics | - |
| `NTFY_PREFIX` | Prefix required to execute a command (e.g., `!`) | `""` |

---

### 4. Service Configuration (`services.json`)

Create `services.json` from the provided example template:

```bash
cp services.json.example services.json
```

Example configuration:

```json
{
  "settings": {
    "publicPort": 25575,
    "runner": "builtin",
    "restartDelayMs": 3000,
    "maxCrashCount": 5,
    "crashWindowMs": 60000,
    "autoWatchConfig": true
  },
  "services": {
    "discord-bot": {
      "runner": "pm2",
      "pm2Args": ["--max-memory-restart", "300M"],
      "enabled": true,
      "port": 8004,
      "routes": ["/"],
      "install": true,
      "build": false,
      "subProjects": [
        {
          "name": "dashboard",
          "path": "dashboard",
          "install": true,
          "build": true
        }
      ]
    },
    "ndfy": {
      "runner": "builtin",
      "enabled": true,
      "port": 8003,
      "routes": ["/ndfy", "/ntfy"],
      "install": true,
      "build": true
    },
    "discord-assistant": {
      "runner": "builtin",
      "enabled": true,
      "install": true,
      "build": false
    }
  }
}
```

#### Settings Schema

- `settings.publicPort` *(number)*: Default gateway port (overridden by `process.env.PORT` if set).
- `settings.runner` *(string)*: Global default process runner (`"builtin"` or `"pm2"`). Defaults to `"builtin"`.
- `settings.pm2Path` *(string, optional)*: Explicit path or command for PM2 binary.
- `settings.restartDelayMs` *(number)*: Base delay (in milliseconds) before restarting a crashed service (builtin runner).
- `settings.maxCrashCount` *(number)*: Maximum allowed consecutive crashes before triggering circuit breaker (builtin runner).
- `settings.crashWindowMs` *(number)*: Window (in ms) after which crash counters reset for stable services.
- `settings.autoWatchConfig` *(boolean)*: Automatically reload configuration when `services.json` changes.
- `settings.ntfyEnabled` *(boolean)*: Enable or disable the ntfy listener.
- `settings.ntfyTopic` *(string)*: Topic name to listen to on the ntfy server.
- `settings.ntfyServer` *(string)*: Custom ntfy server URL (defaults to `https://ntfy.sh`).
- `settings.ntfyAuth` *(string)*: Authorization header string for private topics.
- `settings.ntfyPrefix` *(string)*: Prefix required for ntfy commands to execute.
- `settings.ntfyAliases` *(object)*: Map of custom command aliases to actual commands.

#### Service Definition Schema

- `runner` *(string, optional)*: Process runner for this specific service (`"builtin"` or `"pm2"`). Inherits `settings.runner` if omitted.
- `pm2Args` *(string[], optional)*: Additional flags passed when launching via PM2 (e.g., `["--max-memory-restart", "200M"]`).
- `entryPoint` *(string, optional)*: Explicit entry file path relative to service folder (auto-detected if omitted).
- `enabled` *(boolean)*: Whether the service should be started on launch.
- `port` *(number, optional)*: Internal port assigned to the service (exposed as `PORT` env var to the child process).
- `routes` *(string[], optional)*: Path prefixes mapped by the reverse proxy to this service.
- `install` *(boolean)*: Automatically run `npm install` / `npm ci` before starting.
- `build` *(boolean)*: Automatically run `npm run build` before starting.
- `subProjects` *(array, optional)*: Nested directories requiring separate install or build steps.

---

## Running the Manager

Start the manager process:

```bash
npm start
```

---

## Interactive Console CLI

When run in an interactive terminal, the manager provides a command prompt:

| Command | Usage | Description |
| :--- | :--- | :--- |
| `status` / `list` / `ls` | `status` | Displays a table of all services, runner type, status, PID, memory, port, uptime, and crash count. |
| `start` | `start <service-name>` | Manually starts a service. |
| `stop` | `stop <service-name>` | Gracefully terminates/stops a running service. |
| `restart` | `restart <service-name \| all>` | Restarts a specific service or all enabled services. |
| `logs` | `logs <service-name> [lines]` | Inspects recent output logs for PM2 services (default: 50 lines). |
| `reload` | `reload` | Re-reads `services.json` and synchronizes running processes immediately. |
| `install` | `install <service-name>` | Triggers dependency installation for the service and its sub-projects. |
| `build` | `build <service-name>` | Triggers `npm run build` for the service and its sub-projects. |
| `exec` / `cmd` | `exec <service-name \| .> <cmd>` | Executes a command within the service or manager directory. |
| `clear` / `cls` | `clear` | Clears the terminal console screen. |
| `help` | `help` | Displays the help menu and list of available commands. |

---

## REST Admin and Health API

The gateway exposes administrative endpoints for health monitoring, logs, and remote management.

### 1. Health Check (Public)

```http
GET /_health
```

**Response:**
```json
{
  "status": "OK",
  "timestamp": "2026-10-08T15:20:00.000Z"
}
```

### 2. Service Status (Protected)

```http
GET /_manage/status?key=YOUR_ADMIN_SECRET
```

*Alternatively, pass `x-admin-key: YOUR_ADMIN_SECRET` in request headers.*

**Response:**
```json
{
  "services": [
    {
      "name": "discord-bot",
      "runner": "pm2",
      "status": "RUNNING",
      "pid": 12345,
      "port": 8004,
      "memoryMb": 48.2,
      "routes": ["/"],
      "uptimeSeconds": 3600,
      "restarts": 0
    }
  ],
  "total": 1
}
```

### 3. Service Management Actions (Protected)

```http
GET /_manage?action=<action>&service=<service-name>&key=YOUR_ADMIN_SECRET
```

Supported actions:
- `reload`: Reload configuration file `services.json`.
- `restart`: Restart the target service (`&service=<name>`).
- `start`: Start the target service (`&service=<name>`).
- `stop`: Stop the target service (`&service=<name>`).
- `logs`: Fetch recent logs for the target service (`&service=<name>&lines=50`).

---

## Ntfy Remote Commands Integration

Hosting Manager includes a built-in listener for [ntfy.sh](https://ntfy.sh/) (or custom self-hosted ntfy servers), allowing you to securely execute commands from your phone or any external webhook by simply sending a push notification.

### 1. Configuration

Add the following to your `.env` file:
```env
NTFY_ENABLED=true
NTFY_TOPIC=my_secret_hosting_topic
NTFY_SERVER=https://ntfy.sh
NTFY_AUTH=Bearer tk_your_access_token
NTFY_PREFIX=!
```

Alternatively, configure these directly in `services.json` under `settings`:
```json
  "settings": {
    "ntfyEnabled": true,
    "ntfyTopic": "my_secret_hosting_topic",
    "ntfyServer": "https://ntfy.sh",
    "ntfyAuth": "Bearer tk_your_access_token",
    "ntfyPrefix": "!",
    "ntfyAliases": {
      "deploy": "exec my-service npm run start"
    }
  }
```

### 2. Custom Aliases & Prefixes
- **Prefixes**: For security, you can enforce a prefix (like `!`). Messages lacking the prefix will be safely ignored. Sending `!status` executes `status`.
- **Aliases**: You can map short commands to longer scripts. With the alias configured above, sending `!deploy` translates to executing `exec my-service npm run start`.

### 3. Sending Notifications via CLI
You can also use the integrated console to send push notifications outward:
```text
ntfy my_alerts Deploy completed successfully!
```

---

## Crash Handling and Resilience

- **Built-in Runner**: When a managed service exits unexpectedly, the manager automatically schedules a restart with exponential backoff (up to 30 seconds). If a service crashes more than `maxCrashCount` times within `crashWindowMs`, the service enters `SUSPENDED` status.
- **PM2 Runner**: PM2 natively handles automatic daemon restarts, clustering, and memory thresholds. Status and crash statistics are synchronized with the Hosting Manager via `pm2 jlist`.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
