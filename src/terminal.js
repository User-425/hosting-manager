import { appConfig, serviceRegistry, getAdminSecret } from "./state.js";
import { executeCommand } from "./cli.js";
import { syncPm2Status } from "./process-manager.js";

/**
 * Executes a terminal command in an isolated capture context.
 */
export async function runTerminalCommand(rawCommand) {
    const logs = [];
    const logFn = (...args) => {
        logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" "));
    };
    const errFn = (...args) => {
        logs.push("[ERROR] " + args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" "));
    };

    try {
        await executeCommand(rawCommand, logFn, errFn);
        return {
            success: true,
            output: logs.join("\n") || "(Command produced no output)"
        };
    } catch (err) {
        return {
            success: false,
            output: `[EXECUTION EXCEPTION]: ${err.message}`
        };
    }
}

/**
 * Returns live status summary for the terminal dashboard header.
 */
export function getTerminalStateSummary() {
    syncPm2Status();
    const services = Array.from(serviceRegistry.entries()).map(([name, s]) => ({
        name,
        runner: s.runner || "builtin",
        status: s.status,
        port: s.port,
        pid: s.pid || s.child?.pid || null,
        restarts: s.restartCount || 0,
        uptimeSeconds: s.status === "RUNNING" && s.startTime ? Math.floor((Date.now() - s.startTime) / 1000) : null
    }));

    const runningCount = services.filter((s) => s.status === "RUNNING").length;

    return {
        publicPort: appConfig.settings?.publicPort || 25575,
        defaultRunner: appConfig.settings?.runner || "builtin",
        serviceCount: services.length,
        runningCount,
        services,
        serverTime: new Date().toLocaleTimeString(),
        uptimeSeconds: Math.floor(process.uptime())
    };
}

/**
 * Handles incoming HTTP requests for /terminal and its API subpaths.
 */
export async function handleTerminalRequest(req, res, terminalPath = "/terminal") {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = (parsedUrl.pathname || "").replace(/\/+$/, "") || "/";
    const token =
        parsedUrl.searchParams.get("key") ||
        req.headers["x-admin-key"] ||
        (req.headers["authorization"]?.startsWith("Bearer ")
            ? req.headers["authorization"].slice(7).trim()
            : null);

    const cleanTerminalPath = (terminalPath.startsWith("/") ? terminalPath : `/${terminalPath}`).replace(/\/+$/, "");
    const apiPrefix = `${cleanTerminalPath}/api`;

    // 1. API: Auth Check
    if (pathname === `${apiPrefix}/auth-check`) {
        const isValid = token === getAdminSecret();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ authenticated: isValid }));
        return;
    }

    // 2. API: State Summary
    if (pathname === `${apiPrefix}/state`) {
        if (token !== getAdminSecret()) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing admin key." }));
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(getTerminalStateSummary()));
        return;
    }

    // 3. API: Command Execution
    if (pathname === `${apiPrefix}/exec` && req.method === "POST") {
        if (token !== getAdminSecret()) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing admin key." }));
            return;
        }

        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                req.destroy();
            }
        });

        req.on("end", async () => {
            try {
                const parsed = JSON.parse(body || "{}");
                const command = (parsed.command || "").trim();
                if (!command) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Empty command string." }));
                    return;
                }

                const result = await runTerminalCommand(command);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        success: result.success,
                        command,
                        output: result.output,
                        timestamp: new Date().toLocaleTimeString()
                    })
                );
            } catch (err) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // 4. Web UI Page: GET /terminal (or any sub-route under cleanTerminalPath)
    if (pathname === cleanTerminalPath || pathname === `${cleanTerminalPath}/` || pathname.startsWith(`${cleanTerminalPath}`)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getTerminalHtml(cleanTerminalPath));
        return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
}

/**
 * Generates the self-contained interactive web terminal UI.
 *
 * Layout follows the GitHub Actions run page: services in the left rail,
 * each command as a collapsible step with status, duration and numbered lines.
 *
 * The markup is a String.raw literal so regexes and escapes in the client
 * script survive untouched. Do not use backticks or "${" inside it; the
 * terminal path is injected through the __TERMINAL_PATH__ placeholder.
 */
function getTerminalHtml(terminalPath) {
    const safePath = JSON.stringify(terminalPath).replace(/</g, "\\u003c");
    return TERMINAL_HTML.replace("__TERMINAL_PATH__", () => safePath);
}

const TERMINAL_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Terminal · Hosting Manager</title>
<style>
  :root {
    --canvas: #0d1117;
    --surface: #161b22;
    --raised: #21262d;
    --line: #30363d;
    --fg: #e6edf3;
    --fg-muted: #8d96a0;
    --fg-faint: #6e7681;
    --accent: #4493f8;
    --ok: #3fb950;
    --bad: #f85149;
    --warn: #d29922;
    --btn-primary: #238636;
    --btn-primary-hover: #2ea043;
    --mono: ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    --r: 6px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--canvas); color: var(--fg); font: 14px/1.5 var(--sans); }
  button { font: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: var(--r); }
  svg { flex: none; }

  .app { display: grid; grid-template-columns: 296px 1fr; grid-template-rows: auto 1fr; height: 100vh; height: 100dvh; }

  /* top bar */
  .bar { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--surface); }
  .crumbs { display: flex; align-items: center; gap: 6px; font-size: 16px; min-width: 0; }
  .crumbs .owner { color: var(--fg-muted); }
  .crumbs b { font-weight: 600; }
  .crumbs .sl { color: var(--fg-faint); }
  .bar .right { margin-left: auto; display: flex; gap: 8px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: var(--r); border: 1px solid #363b42; background: var(--raised); font-weight: 500; font-size: 14px; cursor: pointer; white-space: nowrap; }
  .btn:hover { background: #292e36; border-color: #8b949e55; }
  .btn:active { background: #31363e; }
  .btn.sm { height: 28px; padding: 0 10px; font-size: 12px; }
  .btn.primary { background: var(--btn-primary); border-color: #ffffff1a; color: #fff; }
  .btn.primary:hover { background: var(--btn-primary-hover); }
  .btn[disabled] { opacity: .5; cursor: progress; }
  .btn svg { color: var(--fg-muted); }

  /* left rail */
  aside { border-right: 1px solid var(--line); overflow-y: auto; padding: 16px 12px 24px; }
  .summary { padding: 4px 8px 16px; border-bottom: 1px solid var(--line); margin-bottom: 12px; }
  .summary .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 13px; color: var(--fg-muted); }
  .summary .row b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 12.5px; }
  .summary .state { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; color: var(--fg); margin-bottom: 8px; }
  .rail-h { font-size: 12px; font-weight: 600; color: var(--fg-muted); padding: 4px 8px 6px; }
  .svc { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--r); }
  .svc:hover { background: var(--raised); }
  .svc.flash { animation: flash 900ms ease-out; }
  @keyframes flash { from { background: #388bfd26; } }
  .svc .nm { font-size: 14px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; background: none; border: 0; padding: 0; text-align: left; }
  .svc .nm small { display: block; color: var(--fg-faint); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
  .svc .acts { display: flex; gap: 2px; opacity: 0; }
  .svc:hover .acts, .svc:focus-within .acts { opacity: 1; }
  .icon-btn { width: 28px; height: 28px; display: inline-grid; place-items: center; border-radius: var(--r); background: none; border: 0; color: var(--fg-muted); cursor: pointer; }
  .icon-btn:hover { background: #30363d; color: var(--fg); }
  .rail-empty { color: var(--fg-muted); font-size: 13px; padding: 8px; }

  /* main */
  main { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .mhead { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .mhead h1 { font-size: 16px; font-weight: 600; margin: 0; }
  .mhead .sub { color: var(--fg-muted); font-size: 12px; }
  .search { margin-left: auto; display: flex; align-items: center; gap: 6px; height: 32px; width: 280px; max-width: 100%; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--r); background: var(--canvas); color: var(--fg-muted); }
  .search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .search input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; color: var(--fg); font: 13px var(--sans); }
  .search .count { font-size: 12px; color: var(--fg-muted); white-space: nowrap; }

  .steps { flex: 1; overflow-y: auto; padding: 8px 12px 16px; }
  .step.new { animation: in 200ms ease-out; }
  @keyframes in { from { opacity: 0; transform: translateY(-3px); } }
  .step-h { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; background: var(--canvas); border: 0; border-radius: var(--r); cursor: pointer; text-align: left; position: sticky; top: 0; }
  .step-h:hover { background: var(--surface); }
  .chev { color: var(--fg-muted); transition: transform 120ms ease; }
  .step.open .chev { transform: rotate(90deg); }
  .step-h .c { font: 13px var(--mono); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .step-h .t { color: var(--fg-muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .step-h .d { color: var(--fg-muted); font: 12px var(--mono); width: 52px; text-align: right; }
  .step.dim { opacity: .45; }

  .lines { display: none; font: 12.5px/20px var(--mono); padding: 4px 0 10px; overflow-x: auto; }
  .step.open .lines { display: block; }
  .ln { display: flex; min-width: max-content; padding-right: 16px; }
  .ln:hover { background: #6e76811a; }
  .ln .n { width: 56px; flex: none; text-align: right; padding-right: 16px; color: var(--fg-faint); user-select: none; }
  .ln .x { white-space: pre; }
  .ln.err { background: #f851491a; }
  .ln.err .x { color: #ffa198; }
  .ln.dir .x { color: var(--fg-muted); }
  mark { background: #bb800966; color: var(--fg); border-radius: 2px; }

  .ic-ok { color: var(--ok); } .ic-bad { color: var(--bad); } .ic-warn { color: var(--warn); } .ic-off { color: var(--fg-faint); }
  .spin { animation: spin 900ms linear infinite; color: var(--warn); }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* composer */
  .composer { border-top: 1px solid var(--line); padding: 12px 20px 16px; background: var(--canvas); }
  .sugg { display: flex; gap: 6px; margin-bottom: 10px; overflow-x: auto; scrollbar-width: none; }
  .sugg .btn { font-family: var(--mono); font-weight: 400; }
  .box { position: relative; display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: var(--r); background: var(--canvas); padding: 4px 4px 4px 12px; }
  .box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .box .ps { font: 600 13px var(--mono); color: var(--fg-muted); user-select: none; }
  .box input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; color: var(--fg); font: 14px var(--mono); height: 32px; }
  .box input::placeholder { color: var(--fg-faint); }
  .hint { display: flex; gap: 14px; margin-top: 8px; font-size: 12px; color: var(--fg-muted); }
  kbd { font: 11px var(--mono); padding: 1px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--fg); box-shadow: inset 0 -1px 0 #484f58; }
  .ac { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 6px; display: none; box-shadow: 0 8px 24px #01040999; max-height: 240px; overflow-y: auto; z-index: 5; }
  .ac.open { display: block; }
  .ac div { padding: 6px 10px; border-radius: var(--r); font: 13px var(--mono); cursor: pointer; }
  .ac div.on, .ac div:hover { background: #388bfd1a; box-shadow: inset 2px 0 0 var(--accent); }

  /* dialog */
  .scrim { position: fixed; inset: 0; background: #010409cc; display: none; place-items: center; padding: 16px; z-index: 10; }
  .scrim.open { display: grid; }
  .dialog { width: 100%; max-width: 448px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 24px #010409; animation: pop 160ms ease-out; }
  @keyframes pop { from { opacity: 0; transform: scale(.98); } }
  .dialog header { display: flex; align-items: center; padding: 12px 8px 12px 16px; border-bottom: 1px solid var(--line); }
  .dialog header h2 { font-size: 14px; font-weight: 600; margin: 0; flex: 1; }
  .dialog .body { padding: 16px; }
  .dialog .body p { margin: 0 0 12px; color: var(--fg-muted); }
  .dialog code { font: 12px var(--mono); background: #6e768166; padding: 2px 5px; border-radius: 4px; color: var(--fg); }
  .dialog label { display: block; font-weight: 600; margin-bottom: 6px; }
  .dialog input { width: 100%; height: 32px; padding: 0 12px; background: var(--canvas); border: 1px solid var(--line); border-radius: var(--r); color: var(--fg); font: 14px var(--mono); outline: 0; }
  .dialog input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .dialog .err-msg { color: var(--bad); font-size: 13px; margin: 8px 0 0; }
  .dialog footer { display: flex; justify-content: flex-end; gap: 8px; padding: 0 16px 16px; }

  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  @media (max-width: 860px) {
    .app { grid-template-columns: 1fr; grid-template-rows: auto auto 1fr; }
    aside { border-right: 0; border-bottom: 1px solid var(--line); max-height: 34vh; padding: 10px 8px; }
    .summary { display: flex; gap: 16px; flex-wrap: wrap; padding: 2px 8px 10px; margin-bottom: 6px; }
    .summary .state { margin: 0; }
    .summary .row { gap: 6px; }
    .svc .acts { opacity: 1; }
    .search { margin-left: 0; width: 100%; }
    .hint { display: none; }
    .bar .btn .lbl { display: none; }
    .crumbs .owner, .crumbs .sl { display: none; }
  }
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-ok" viewBox="0 0 16 16"><path fill="currentColor" d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.75.75 0 0 0-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5Z"/></symbol>
  <symbol id="i-bad" viewBox="0 0 16 16"><path fill="currentColor" d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.06 1.06L6.94 8 4.97 9.97a.749.749 0 0 0 1.06 1.06L8 9.06l1.97 1.97a.749.749 0 0 0 1.06-1.06L9.06 8l1.97-1.97a.749.749 0 0 0-1.06-1.06L8 6.94Z"/></symbol>
  <symbol id="i-warn" viewBox="0 0 16 16"><path fill="currentColor" d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575ZM8 5a.75.75 0 0 0-.75.75v2.5a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8 5Zm1 6a1 1 0 1 0-2 0 1 1 0 0 0 2 0Z"/></symbol>
  <symbol id="i-off" viewBox="0 0 16 16"><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4-2.25h5a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-.75.75h-5a.75.75 0 0 1-.75-.75v-3a.75.75 0 0 1 .75-.75Z"/></symbol>
  <symbol id="i-spin" viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M8 1.5a6.5 6.5 0 1 1-6.5 6.5"/></symbol>
  <symbol id="i-chev" viewBox="0 0 16 16"><path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/></symbol>
  <symbol id="i-key" viewBox="0 0 16 16"><path fill="currentColor" d="M10.5 0a5.499 5.499 0 1 1-1.288 10.848l-.932.932a.749.749 0 0 1-.53.22H7v.75a.749.749 0 0 1-.22.53l-.5.5a.749.749 0 0 1-.53.22H5v.75a.749.749 0 0 1-.22.53l-.5.5a.749.749 0 0 1-.53.22h-2A1.75 1.75 0 0 1 0 14.25v-2c0-.199.079-.389.22-.53l4.932-4.932A5.5 5.5 0 0 1 10.5 0Zm-4 5.5c-.001.431.069.86.205 1.269a.75.75 0 0 1-.181.768L1.5 12.56v1.69c0 .138.112.25.25.25h1.69l.06-.06v-1.19a.75.75 0 0 1 .75-.75h1.19l.06-.06v-1.19a.75.75 0 0 1 .75-.75h1.19l1.023-1.025a.75.75 0 0 1 .768-.18A4 4 0 1 0 6.5 5.5ZM11 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></symbol>
  <symbol id="i-sync" viewBox="0 0 16 16"><path fill="currentColor" d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></symbol>
  <symbol id="i-trash" viewBox="0 0 16 16"><path fill="currentColor" d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></symbol>
  <symbol id="i-search" viewBox="0 0 16 16"><path fill="currentColor" d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></symbol>
  <symbol id="i-restart" viewBox="0 0 16 16"><path fill="currentColor" d="M5.029 2.217a6.5 6.5 0 0 1 9.437 5.11.75.75 0 1 0 1.492-.154 8 8 0 0 0-14.315-4.03L.427 1.927A.25.25 0 0 0 0 2.104V5.75A.25.25 0 0 0 .25 6h3.646a.25.25 0 0 0 .177-.427L2.715 4.215a6.491 6.491 0 0 1 2.314-1.998ZM1.262 8.675a.75.75 0 0 0-1.22.154 8 8 0 0 0 14.315 4.03l1.216 1.216a.25.25 0 0 0 .427-.177V10.25a.25.25 0 0 0-.25-.25h-3.646a.25.25 0 0 0-.177.427l1.358 1.358a6.501 6.501 0 0 1-11.751-3.11.75.75 0 0 0-.272-1.999Z"/></symbol>
  <symbol id="i-log" viewBox="0 0 16 16"><path fill="currentColor" d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></symbol>
</svg>

<div class="app">
  <div class="bar">
    <div class="crumbs"><span class="owner">hosting-manager</span><span class="sl">/</span><b>terminal</b></div>
    <div class="right">
      <button class="btn" id="b-key" title="Admin key"><svg width="16" height="16"><use href="#i-key"/></svg><span class="lbl">Admin key</span></button>
      <button class="btn" id="b-sync" title="Sync state"><svg width="16" height="16"><use href="#i-sync"/></svg><span class="lbl">Sync</span></button>
      <button class="btn" id="b-clear" title="Clear session (Ctrl+L)"><svg width="16" height="16"><use href="#i-trash"/></svg><span class="lbl">Clear</span></button>
    </div>
  </div>

  <aside>
    <div class="summary" id="summary"></div>
    <div class="rail-h">Services</div>
    <div id="svc"></div>
  </aside>

  <main>
    <div class="mhead">
      <div>
        <h1>Session</h1>
        <div class="sub" id="sess-sub"></div>
      </div>
      <label class="search">
        <svg width="16" height="16"><use href="#i-search"/></svg>
        <input id="q" type="text" placeholder="Search logs" aria-label="Search logs" spellcheck="false">
        <span class="count" id="q-count"></span>
      </label>
    </div>

    <div class="steps" id="steps"></div>

    <div class="composer">
      <div class="sugg" id="sugg"></div>
      <form class="box" id="cmd-form" autocomplete="off">
        <span class="ps">manager:~$</span>
        <input id="cmd" type="text" placeholder="restart &lt;service&gt;, logs &lt;service&gt;, exec . git status" aria-label="Command" spellcheck="false" autofocus>
        <button class="btn primary" id="run" type="submit">Run</button>
        <div class="ac" id="ac" role="listbox"></div>
      </form>
      <div class="hint"><span><kbd>Tab</kbd> complete</span><span><kbd>↑</kbd> <kbd>↓</kbd> history</span><span><kbd>Ctrl</kbd> <kbd>L</kbd> clear</span></div>
    </div>
  </main>
</div>

<div class="scrim" id="scrim">
  <form class="dialog" id="key-form" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
    <header><h2 id="dlg-t">Admin key</h2><button type="button" class="icon-btn" id="dlg-x" aria-label="Close"><svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg></button></header>
    <div class="body">
      <p>Commands and service state need <code>ADMIN_SECRET</code> or <code>ADMIN_KEY</code> from the host's <code>.env</code>. The key is kept in this browser.</p>
      <label for="key-input">Key</label>
      <input id="key-input" type="password" autocomplete="off">
      <p class="err-msg" id="key-err" hidden></p>
    </div>
    <footer><button type="button" class="btn" id="dlg-cancel">Cancel</button><button type="submit" class="btn primary">Connect</button></footer>
  </form>
</div>

<script>
(function () {
  "use strict";
  var TERMINAL_PATH = __TERMINAL_PATH__;
  var STORAGE_KEY = "hosting_admin_secret";
  var HISTORY_KEY = "terminal_cmd_history";
  var COMMANDS = ["status", "restart", "start", "stop", "logs", "reload", "install", "build", "exec", "ntfy", "clear", "help"];
  var QUICK = ["status", "restart all", "reload", "help", "exec . git status", "exec . pm2 list"];
  var ERR_RE = /\[ERROR\]|ERROR\]|\[EXECUTION EXCEPTION\]|Error \[|errored|exited with code|403 Forbidden/;

  function $(id) { return document.getElementById(id); }
  var stepsEl = $("steps"), cmd = $("cmd"), runBtn = $("run"), ac = $("ac"), q = $("q");

  var state = null;          // last /api/state payload, null when not connected
  var steps = [];            // { id, command, out, kind, time, ms, open, fresh, hits }
  var cmdHistory = [];
  try { cmdHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { cmdHistory = []; }
  var startedAt = new Date();
  var hIdx = -1, acItems = [], acOn = 0, seq = 0, flashName = null;

  /* ---------- helpers ---------- */
  function esc(t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtUp(s) {
    if (s == null) return "";
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 48) return h + "h " + (m % 60) + "m";
    return Math.floor(h / 24) + "d " + (h % 24) + "h";
  }
  function fmtMs(ms) { return ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(1) + "s"; }
  var ICON = { ok: ["i-ok", "ic-ok"], warn: ["i-warn", "ic-warn"], fail: ["i-bad", "ic-bad"], run: ["i-spin", "spin"], off: ["i-off", "ic-off"] };
  function icon(k) { return '<svg width="16" height="16" class="' + ICON[k][1] + '"><use href="#' + ICON[k][0] + '"/></svg>'; }
  function svcKind(s) {
    if (s.status === "RUNNING") return "ok";
    if (s.status === "STARTING") return "run";
    if (s.status === "CRASHED" || s.status === "SUSPENDED" || s.status === "ERRORED") return "fail";
    return "off";
  }
  function serviceNames() { return state ? state.services.map(function (s) { return s.name; }) : []; }
  function findSvc(n) {
    if (!state || !n) return null;
    n = String(n).toLowerCase();
    return state.services.filter(function (s) { return s.name.toLowerCase() === n; })[0] || null;
  }

  /* ---------- auth ---------- */
  function getAdminKey() {
    var urlKey = new URLSearchParams(location.search).get("key");
    if (urlKey) {
      localStorage.setItem(STORAGE_KEY, urlKey);
      // drop the key from the address bar so it doesn't linger in browser history
      var u = new URL(location.href); u.searchParams.delete("key");
      window.history.replaceState(null, "", u.pathname + u.search + u.hash);
      return urlKey;
    }
    return localStorage.getItem(STORAGE_KEY) || "";
  }

  /* ---------- rendering ---------- */
  function renderSummary() {
    if (!state) {
      $("summary").innerHTML = '<div class="state">' + icon("fail") + ' Not connected</div>' +
        '<div class="row"><span>Admin key missing or rejected</span></div>';
      return;
    }
    var all = state.runningCount === state.serviceCount;
    $("summary").innerHTML =
      '<div class="state">' + icon(all ? "ok" : "warn") + " " + state.runningCount + " of " + state.serviceCount + " running</div>" +
      '<div class="row"><span>Gateway</span><b>:' + esc(state.publicPort) + "</b></div>" +
      '<div class="row"><span>Manager uptime</span><b>' + fmtUp(state.uptimeSeconds) + "</b></div>" +
      '<div class="row"><span>Last sync</span><b>' + esc(state.serverTime) + "</b></div>";
  }
  function renderServices() {
    if (!state) { $("svc").innerHTML = '<div class="rail-empty">Connect with the admin key to load services.</div>'; return; }
    if (!state.services.length) { $("svc").innerHTML = '<div class="rail-empty">No services registered in services.json.</div>'; return; }
    $("svc").innerHTML = state.services.map(function (s) {
      var on = s.status === "RUNNING";
      var meta = [s.runner, s.port ? ":" + s.port : null, on ? fmtUp(s.uptimeSeconds) || "running" : String(s.status || "STOPPED").toLowerCase(), s.restarts ? s.restarts + (s.restarts === 1 ? " crash" : " crashes") : null]
        .filter(Boolean).join(" · ");
      var n = esc(s.name);
      return '<div class="svc' + (flashName === s.name ? " flash" : "") + '">' + icon(svcKind(s)) +
        '<button class="nm" data-run="logs ' + n + '" title="logs ' + n + '">' + n + "<small>" + esc(meta) + "</small></button>" +
        '<span class="acts">' +
        '<button class="icon-btn" data-run="restart ' + n + '" aria-label="Restart ' + n + '" title="restart ' + n + '"><svg width="16" height="16"><use href="#i-restart"/></svg></button>' +
        '<button class="icon-btn" data-run="logs ' + n + '" aria-label="Logs for ' + n + '" title="logs ' + n + '"><svg width="16" height="16"><use href="#i-log"/></svg></button>' +
        "</span></div>";
    }).join("");
    flashName = null;
  }
  function renderSugg() {
    $("sugg").innerHTML = QUICK.map(function (c) { return '<button class="btn sm" data-run="' + esc(c) + '">' + esc(c) + "</button>"; }).join("");
  }
  function renderSub() {
    var n = steps.length;
    $("sess-sub").textContent = "Started " + startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " + n + " command" + (n === 1 ? "" : "s");
  }
  function hl(text, term) {
    var e = esc(text);
    if (!term) return e;
    var t = esc(term).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    return e.replace(new RegExp(t, "gi"), function (m) { return "<mark>" + m + "</mark>"; });
  }
  function stepHtml(s, term) {
    var lines = s.kind === "run" ? [] : String(s.out).replace(/^\s*\n|\n\s*$/g, "").split("\n");
    var hits = 0;
    var body = lines.map(function (l, i) {
      if (term && l.toLowerCase().indexOf(term.toLowerCase()) !== -1) hits++;
      var cls = ERR_RE.test(l) ? "err" : /^\[(Directory|Running)\]/.test(l) ? "dir" : "";
      return '<div class="ln ' + cls + '"><span class="n">' + (i + 1) + '</span><span class="x">' + (hl(l, term) || " ") + "</span></div>";
    }).join("");
    s.hits = hits;
    return '<div class="step' + (s.open ? " open" : "") + (term && !hits ? " dim" : "") + (s.fresh ? " new" : "") + '">' +
      '<button class="step-h" data-toggle="' + s.id + '" aria-expanded="' + s.open + '">' +
      '<svg width="16" height="16" class="chev"><use href="#i-chev"/></svg>' + icon(s.kind) +
      '<span class="c">' + hl(s.command, term) + "</span>" +
      '<span class="t">' + esc(s.time) + '</span><span class="d">' + (s.kind === "run" ? "" : fmtMs(s.ms)) + "</span>" +
      '</button><div class="lines">' + body + "</div></div>";
  }
  function renderSteps() {
    var term = q.value.trim();
    if (!steps.length) {
      stepsEl.innerHTML = '<div class="rail-empty" style="padding:16px 8px">No commands in this session yet. Type <code>help</code> to see what the manager can do.</div>';
      $("q-count").textContent = "";
    } else {
      stepsEl.innerHTML = steps.map(function (s) { return stepHtml(s, term); }).join("");
      steps.forEach(function (s) { s.fresh = false; });
      $("q-count").textContent = term ? steps.reduce(function (a, s) { return a + (s.hits || 0); }, 0) + " results" : "";
    }
    renderSub();
  }
  function scrollEnd() { stepsEl.scrollTop = stepsEl.scrollHeight; }
  function clearAll() { steps.length = 0; renderSteps(); cmd.focus(); }

  /* ---------- API ---------- */
  async function fetchState() {
    var key = getAdminKey();
    if (!key) { state = null; renderSummary(); renderServices(); return false; }
    try {
      var res = await fetch(TERMINAL_PATH + "/api/state", { headers: { "x-admin-key": key } });
      state = res.ok ? await res.json() : null;
    } catch (e) {
      state = null;
    }
    renderSummary(); renderServices();
    return !!state;
  }

  async function submit(command) {
    command = String(command || "").trim();
    if (!command) return;
    closeAc();
    if (/^(clear|cls)$/i.test(command)) { cmd.value = ""; clearAll(); return; }

    cmdHistory.push(command);
    if (cmdHistory.length > 100) cmdHistory.shift();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(cmdHistory));
    hIdx = -1;

    cmd.value = ""; cmd.disabled = runBtn.disabled = true;
    var s = { id: ++seq, command: command, out: "", kind: "run", time: new Date().toLocaleTimeString(), ms: 0, open: true, fresh: true };
    steps.forEach(function (x) { if (x.kind === "ok") x.open = false; });   // collapse passing steps, keep problems open
    steps.push(s); renderSteps(); scrollEnd();

    var t0 = performance.now();
    var showKey = false;
    try {
      var res = await fetch(TERMINAL_PATH + "/api/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": getAdminKey() },
        body: JSON.stringify({ command: command })
      });
      if (res.status === 403) {
        s.out = "403 Forbidden: Invalid or missing admin key."; s.kind = "fail"; showKey = true;
      } else {
        var data = await res.json();
        if (!res.ok) { s.out = data.error || ("HTTP " + res.status); s.kind = "fail"; }
        else {
          s.out = data.output;
          s.kind = data.success ? (ERR_RE.test(s.out) ? "warn" : "ok") : "fail";
        }
      }
    } catch (err) {
      s.out = "Network / Execution Error: " + err.message; s.kind = "fail";
    }
    s.ms = performance.now() - t0;

    if (s.out === "__CLEAR__") { steps.length = 0; }
    var target = findSvc(command.split(/\s+/)[1]);
    if (target) flashName = target.name;

    renderSteps(); scrollEnd();
    cmd.disabled = runBtn.disabled = false;
    await fetchState();
    if (showKey) openDlg("That key was rejected by the server.");
    else if (!$("scrim").classList.contains("open")) cmd.focus();
  }

  /* ---------- autocomplete ---------- */
  function suggestions(v) {
    var parts = v.replace(/^\s+/, "").split(/\s+/);
    if (parts.length <= 1) {
      var p = parts[0].toLowerCase();
      return COMMANDS.filter(function (c) { return c.indexOf(p) === 0 && c !== p; });
    }
    if (parts.length === 2 && /^(restart|start|stop|logs|log|install|build|exec|cmd)$/i.test(parts[0])) {
      var pool = serviceNames()
        .concat(/^(restart|start|stop)$/i.test(parts[0]) ? ["all"] : [])
        .concat(/^(exec|cmd)$/i.test(parts[0]) ? ["."] : []);
      var w = parts[1].toLowerCase();
      return pool.filter(function (n) { return n.toLowerCase().indexOf(w) === 0 && n !== parts[1]; })
        .map(function (n) { return parts[0] + " " + n; });
    }
    return [];
  }
  function openAc(list) {
    acItems = list; acOn = 0;
    if (!list.length) return closeAc();
    ac.innerHTML = list.map(function (s, i) { return '<div role="option" class="' + (i === 0 ? "on" : "") + '" data-v="' + esc(s) + '">' + esc(s) + "</div>"; }).join("");
    ac.classList.add("open");
  }
  function closeAc() { ac.classList.remove("open"); acItems = []; }
  function moveAc(d) {
    acOn = (acOn + d + acItems.length) % acItems.length;
    Array.prototype.forEach.call(ac.children, function (n, i) { n.classList.toggle("on", i === acOn); });
  }

  cmd.addEventListener("input", function () { cmd.value.trim() ? openAc(suggestions(cmd.value)) : closeAc(); });
  cmd.addEventListener("keydown", function (e) {
    if (e.key === "Tab") {
      e.preventDefault();
      var list = acItems.length ? acItems : suggestions(cmd.value);
      if (list.length) { cmd.value = list[acItems.length ? acOn : 0] + " "; openAc(suggestions(cmd.value)); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (acItems.length) return moveAc(-1);
      if (!cmdHistory.length) return;
      hIdx = hIdx === -1 ? cmdHistory.length - 1 : Math.max(0, hIdx - 1);
      cmd.value = cmdHistory[hIdx];
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (acItems.length) return moveAc(1);
      if (hIdx === -1) return;
      hIdx++;
      if (hIdx >= cmdHistory.length) { hIdx = -1; cmd.value = ""; } else cmd.value = cmdHistory[hIdx];
    } else if (e.key === "Escape") closeAc();
  });
  ac.addEventListener("mousedown", function (e) {
    var d = e.target.closest("[data-v]");
    if (d) { e.preventDefault(); cmd.value = d.dataset.v + " "; closeAc(); cmd.focus(); }
  });
  $("cmd-form").addEventListener("submit", function (e) { e.preventDefault(); submit(cmd.value); });

  document.addEventListener("click", function (e) {
    var tg = e.target.closest("[data-toggle]");
    if (tg) {
      var s = steps.filter(function (x) { return String(x.id) === tg.dataset.toggle; })[0];
      if (s) { s.open = !s.open; renderSteps(); }
      return;
    }
    var b = e.target.closest("[data-run]");
    if (b && !b.disabled && !runBtn.disabled) submit(b.dataset.run);
  });
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey && e.key.toLowerCase() === "l") { e.preventDefault(); clearAll(); }
    if (e.key === "Escape" && $("scrim").classList.contains("open")) closeDlg();
  });
  q.addEventListener("input", function () {
    if (q.value.trim()) steps.forEach(function (s) { s.open = true; });
    renderSteps();
  });

  /* ---------- dialog ---------- */
  function openDlg(msg) {
    $("key-input").value = getAdminKey();
    $("key-err").hidden = !msg;
    $("key-err").textContent = msg || "";
    $("scrim").classList.add("open");
    $("key-input").focus();
    $("key-input").select();
  }
  function closeDlg() { $("scrim").classList.remove("open"); cmd.focus(); }
  $("b-key").onclick = function () { openDlg(); };
  $("dlg-x").onclick = closeDlg;
  $("dlg-cancel").onclick = closeDlg;
  $("scrim").addEventListener("mousedown", function (e) { if (e.target === $("scrim")) closeDlg(); });
  $("key-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var key = $("key-input").value.trim();
    if (key) localStorage.setItem(STORAGE_KEY, key); else localStorage.removeItem(STORAGE_KEY);
    var ok = await fetchState();
    if (ok) closeDlg();
    else openDlg(key ? "That key was rejected by the server." : "Enter a key to connect.");
  });
  $("b-clear").onclick = clearAll;
  $("b-sync").onclick = function () { fetchState(); };

  /* ---------- init ---------- */
  renderSugg(); renderSteps();
  $("summary").innerHTML = '<div class="state">' + icon("run") + " Connecting…</div>";
  fetchState().then(function (ok) {
    if (!ok) setTimeout(function () { openDlg(getAdminKey() ? "That key was rejected by the server." : ""); }, 300);
  });
  setInterval(fetchState, 10000);
})();
</script>
</body>
</html>`;
