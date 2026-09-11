export function getTimestamp() {
    return new Date().toLocaleTimeString();
}

export function log(type, name, message) {
    console.log(`[${getTimestamp()}] [${type}] [${name}] ${message}`);
}

export function logError(type, name, message) {
    console.error(`[${getTimestamp()}] [ERROR: ${type}] [${name}] ${message}`);
}
