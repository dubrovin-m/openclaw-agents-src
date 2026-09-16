import { spawn } from "node:child_process";
export const CONTACTCTL_EXECUTABLE = "/home/dubrovin/.local/bin/contactctl";
export const CONTACTCTL_TIMEOUT_MS = 10_000;
export const CONTACTCTL_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const ACTIONS = {
    contact_search: "search",
    contact_resolve: "resolve",
    contact_get: "get",
    contact_create: "create",
    contact_update: "update",
    contact_rename: "rename",
    contact_alias_add: "alias_add",
    contact_alias_remove: "alias_remove",
    contact_merge: "merge",
};
const structuredError = (code, message, details = {}) => ({ ok: false, error: { code, message, ...details } });
const buildInvocation = (action, payload) => ({
    executable: CONTACTCTL_EXECUTABLE,
    argv: [ACTIONS[action]],
    options: { shell: false, env: { HOME: "/home/dubrovin", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "Europe/Moscow", CONTACTCTL_PAYLOAD: JSON.stringify(payload) }, stdio: ["ignore", "pipe", "pipe"] },
});
export async function executeContactctl(action, payload, options = {}) {
    const invocation = buildInvocation(action, payload), timeoutMs = options.timeoutMs ?? CONTACTCTL_TIMEOUT_MS, spawnImpl = options.spawnImpl ?? spawn;
    const result = await new Promise((resolve) => {
        let child;
        try {
            child = spawnImpl(invocation.executable, invocation.argv, invocation.options);
        }
        catch (error) {
            resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, spawnError: error instanceof Error ? error.message : String(error) });
            return;
        }
        const stdout = [], stderr = [];
        let outBytes = 0, errBytes = 0, timedOut = false, aborted = false, settled = false;
        const kill = () => { if (!child.killed)
            child.kill("SIGKILL"); };
        const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
        timer.unref?.();
        const onAbort = () => { aborted = true; kill(); };
        if (options.signal?.aborted)
            onAbort();
        else
            options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", chunk => { outBytes += chunk.length; if (outBytes <= CONTACTCTL_OUTPUT_LIMIT_BYTES)
            stdout.push(chunk);
        else
            kill(); });
        child.stderr.on("data", chunk => { errBytes += chunk.length; if (errBytes <= CONTACTCTL_OUTPUT_LIMIT_BYTES)
            stderr.push(chunk);
        else
            kill(); });
        const finish = (code, signal, spawnError) => { if (settled)
            return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut, aborted, ...(spawnError ? { spawnError } : {}) }); };
        child.on("error", error => finish(null, null, error.message));
        child.on("close", (code, signal) => finish(code, signal));
    });
    if (result.spawnError)
        return structuredError("CONTACTCTL_SPAWN_ERROR", "Failed to start contactctl", { detail: result.spawnError });
    if (result.aborted)
        return structuredError("CONTACTCTL_ABORTED", "contactctl call was aborted");
    if (result.timedOut)
        return structuredError("CONTACTCTL_TIMEOUT", "contactctl call timed out", { timeout_ms: timeoutMs });
    if (Buffer.byteLength(result.stdout) > CONTACTCTL_OUTPUT_LIMIT_BYTES || Buffer.byteLength(result.stderr) > CONTACTCTL_OUTPUT_LIMIT_BYTES)
        return structuredError("CONTACTCTL_OUTPUT_LIMIT", "contactctl output exceeded the configured limit");
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        return structuredError("CONTACTCTL_INVALID_JSON", "contactctl stdout was not valid JSON", { exit_code: result.code, stderr: result.stderr.slice(0, 4096) });
    }
    if (result.code !== 0 || result.signal !== null || result.stderr.length > 0)
        return structuredError("CONTACTCTL_PROCESS_ERROR", "contactctl reported a process error", { exit_code: result.code, signal: result.signal, stderr: result.stderr.slice(0, 4096), contactctl: parsed });
    return parsed;
}
