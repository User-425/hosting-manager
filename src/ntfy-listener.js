import https from "https";
import http from "http";
import { appConfig } from "./state.js";
import { processCommand } from "./cli.js";
import { log, logError } from "./logger.js";

let currentRequest = null;
let reconnectTimer = null;

export function startNtfyListener() {
    let isEnabled = true;
    if (appConfig.settings.ntfyEnabled !== undefined) {
        isEnabled = !!appConfig.settings.ntfyEnabled;
    } else if (process.env.NTFY_ENABLED !== undefined) {
        isEnabled = process.env.NTFY_ENABLED === 'true' || process.env.NTFY_ENABLED === '1';
    }

    if (!isEnabled) {
        log("NTFY", "LISTENER", "Ntfy integration is disabled. Skipping remote commands.");
        return;
    }

    const topic = appConfig.settings.ntfyTopic || process.env.NTFY_TOPIC;
    if (!topic) {
        log("NTFY", "LISTENER", "No ntfy topic configured. Skipping remote commands.");
        return;
    }

    const serverUrlStr = appConfig.settings.ntfyServer || process.env.NTFY_SERVER || "https://ntfy.sh";
    const auth = appConfig.settings.ntfyAuth || process.env.NTFY_AUTH || "";

    log("NTFY", "LISTENER", `Subscribing to ntfy topic: ${topic} on ${serverUrlStr}`);

    function connect() {
        if (currentRequest) {
            currentRequest.abort();
            currentRequest = null;
        }

        try {
            const serverUrl = new URL(serverUrlStr);
            const options = {
                hostname: serverUrl.hostname,
                port: serverUrl.port || (serverUrl.protocol === 'https:' ? 443 : 80),
                path: `${serverUrl.pathname === '/' ? '' : serverUrl.pathname}/${topic}/json`,
                method: 'GET',
                headers: {}
            };

            if (auth) {
                options.headers['Authorization'] = auth;
            }

            const client = serverUrl.protocol === 'https:' ? https : http;

            const req = client.request(options, (res) => {
                let buffer = "";

                res.on('data', async (chunk) => {
                    buffer += chunk.toString();
                    let boundary = buffer.indexOf('\n');
                    
                    while (boundary !== -1) {
                        const line = buffer.substring(0, boundary).trim();
                        buffer = buffer.substring(boundary + 1);
                        boundary = buffer.indexOf('\n');

                        if (!line) continue;
                        
                        try {
                            const data = JSON.parse(line);
                            if (data.event === "message" && data.message) {
                                let msg = data.message.trim();
                                
                                const prefix = appConfig.settings.ntfyPrefix !== undefined 
                                    ? appConfig.settings.ntfyPrefix 
                                    : (process.env.NTFY_PREFIX || "");
                                    
                                if (prefix && !msg.startsWith(prefix)) {
                                    continue;
                                }
                                
                                if (prefix) {
                                    msg = msg.substring(prefix.length).trim();
                                }
                                
                                const aliases = appConfig.settings.ntfyAliases || {};
                                const parts = msg.split(/\s+/);
                                const cmdName = parts[0];
                                
                                if (aliases[cmdName]) {
                                    const aliasTarget = aliases[cmdName];
                                    msg = aliasTarget + (parts.length > 1 ? " " + parts.slice(1).join(" ") : "");
                                }

                                log("NTFY", "COMMAND", `Executing remote command: ${msg}`);
                                await processCommand(msg);

                                // Send confirmation back
                                try {
                                    const headers = { 'Title': 'Hosting Manager' };
                                    if (auth) {
                                        headers['Authorization'] = auth;
                                    }
                                    
                                    const baseUrl = serverUrlStr.endsWith('/') ? serverUrlStr.slice(0, -1) : serverUrlStr;
                                    await fetch(`${baseUrl}/${topic}`, {
                                        method: 'POST',
                                        body: `✅ Command executed successfully:\n${msg}`,
                                        headers
                                    });
                                } catch (e) {
                                    logError("NTFY", "REPLY", `Failed to send confirmation: ${e.message}`);
                                }
                            }
                        } catch (err) {
                            // ignore JSON parse error for partial lines
                        }
                    }
                });

                res.on('end', () => {
                    logError("NTFY", "STREAM", "Connection closed by server. Reconnecting in 5s...");
                    reconnectTimer = setTimeout(connect, 5000);
                });
            });

            req.on('error', (e) => {
                logError("NTFY", "STREAM ERROR", e.message);
                reconnectTimer = setTimeout(connect, 5000);
            });

            req.end();
            currentRequest = req;
        } catch (err) {
            logError("NTFY", "SETUP ERROR", `Failed to connect to ${serverUrlStr}: ${err.message}`);
        }
    }

    connect();
}
