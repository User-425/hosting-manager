export let shuttingDown = false;

export function setShuttingDown(val) {
    shuttingDown = val;
}

export let appConfig = {
    settings: {
        publicPort: 25575,
        restartDelayMs: 3000,
        maxCrashCount: 5,
        crashWindowMs: 60000,
        autoWatchConfig: true
    },
    services: {}
};

export function setAppConfig(config) {
    appConfig = config;
}

export const serviceRegistry = new Map();

export function getAdminSecret() {
    return process.env.ADMIN_SECRET || process.env.ADMIN_KEY || "hosting_admin_key";
}
