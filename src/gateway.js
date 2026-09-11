import http from "http";
import httpProxy from "http-proxy";
import { appConfig, getAdminSecret } from "./state.js";
import { handleAdminApi } from "./admin-api.js";

export function startGateway(publicPort) {
    const proxy = httpProxy.createProxyServer({ ws: true });

    proxy.on("error", (err, req, res) => {
        if (res && res.writeHead) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    error: "502 Bad Gateway",
                    message: "The requested backend service is starting up or temporarily offline.",
                    timestamp: new Date().toISOString()
                })
            );
        } else if (res && res.destroy) {
            res.destroy();
        }
    });

    function resolveTarget(url) {
        for (const [name, conf] of Object.entries(appConfig.services)) {
            if (!conf.port || !conf.routes) continue;
            for (const route of conf.routes) {
                if (route !== "/" && url.startsWith(route)) {
                    return `http://127.0.0.1:${conf.port}`;
                }
            }
        }

        for (const [name, conf] of Object.entries(appConfig.services)) {
            if (conf.port && conf.routes?.includes("/")) {
                return `http://127.0.0.1:${conf.port}`;
            }
        }

        return null;
    }

    const server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "*");
        res.setHeader("Access-Control-Expose-Headers", "*");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.url.startsWith("/_manage") || req.url === "/_health" || req.url === "/_status") {
            handleAdminApi(req, res);
            return;
        }

        const target = resolveTarget(req.url);
        if (target) {
            proxy.web(req, res, { target });
        } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "404 Not Found", message: "No active service mapped to this route." }));
        }
    });

    server.on("upgrade", (req, socket, head) => {
        const target = resolveTarget(req.url);
        if (target) {
            proxy.ws(req, socket, head, { target });
        } else {
            socket.destroy();
        }
    });

    server.listen(publicPort, () => {
        console.log("\n========================================================");
        console.log(` [GATEWAY ONLINE] Listening on public port ${publicPort}`);
        console.log(` -> Admin Secret: ${getAdminSecret()}`);
        console.log("========================================================\n");
    });

    return server;
}
