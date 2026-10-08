import { serviceRegistry, getAdminSecret } from "./state.js";
import { startService, stopService, restartService, reloadConfig, syncPm2Status } from "./process-manager.js";
import { pm2GetLogs } from "./pm2-manager.js";

export function handleAdminApi(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const token = parsedUrl.searchParams.get("key") || req.headers["x-admin-key"];

    if (pathname === "/_health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "OK", timestamp: new Date().toISOString() }));
        return;
    }

    if (token !== getAdminSecret()) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "403 Forbidden", message: "Invalid or missing admin key." }));
        return;
    }

    if (pathname === "/_manage/status" || pathname === "/_status") {
        syncPm2Status();

        const summary = Array.from(serviceRegistry.entries()).map(([name, s]) => ({
            name,
            runner: s.runner || "builtin",
            status: s.status,
            pid: s.pid || s.child?.pid || null,
            port: s.port,
            memoryMb: s.memory !== null && s.memory !== undefined ? Number(s.memory.toFixed(1)) : null,
            routes: s.routes,
            uptimeSeconds: s.startTime && s.status === "RUNNING" ? Math.floor((Date.now() - s.startTime) / 1000) : 0,
            restarts: s.restartCount
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ services: summary, total: summary.length }));
        return;
    }

    const action = parsedUrl.searchParams.get("action");
    const serviceName = parsedUrl.searchParams.get("service");

    if (action === "reload") {
        reloadConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: "services.json reloaded." }));
        return;
    }

    if (action === "restart" && serviceName) {
        restartService(serviceName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: `Restarting ${serviceName}` }));
        return;
    }

    if (action === "start" && serviceName) {
        startService(serviceName, true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: `Starting ${serviceName}` }));
        return;
    }

    if (action === "stop" && serviceName) {
        stopService(serviceName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: `Stopping ${serviceName}` }));
        return;
    }

    if (action === "logs" && serviceName) {
        const lines = Number(parsedUrl.searchParams.get("lines")) || 50;
        const state = serviceRegistry.get(serviceName);
        if (state?.runner === "pm2") {
            const logs = pm2GetLogs(serviceName, lines);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, service: serviceName, logs }));
        } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, service: serviceName, message: "Service runs on builtin runner; logs stream directly to host console." }));
        }
        return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid action or parameters." }));
}
