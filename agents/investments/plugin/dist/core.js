import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);
export function parseInvestmentConfig(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Investment plugin configuration must be an object");
    }
    const raw = value;
    if (typeof raw.portfolioHubRoot !== "string" || !path.isAbsolute(raw.portfolioHubRoot)) {
        throw new Error("portfolioHubRoot must be an absolute path");
    }
    if (typeof raw.pythonPath !== "string" || !path.isAbsolute(raw.pythonPath)) {
        throw new Error("pythonPath must be an absolute path");
    }
    return { portfolioHubRoot: raw.portfolioHubRoot, pythonPath: raw.pythonPath };
}
export function currentMoscowDate(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Moscow",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    const year = get("year");
    const month = get("month");
    const day = get("day");
    if (!year || !month || !day)
        throw new Error("failed to resolve Europe/Moscow date");
    return `${year}-${month}-${day}`;
}
export function weeklyReviewArgs(endDate, days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate))
        throw new Error("end_date must be YYYY-MM-DD");
    if (!Number.isInteger(days) || days < 1 || days > 31)
        throw new Error("days must be an integer from 1 to 31");
    return ["-m", "portfolio_hub.weekly_review", "--end-date", endDate, "--days", String(days), "--json"];
}
export function holdingsArgs(top) {
    if (!Number.isInteger(top) || top < 1 || top > 100)
        throw new Error("top must be an integer from 1 to 100");
    return ["-m", "portfolio_hub.holdings", "--top", String(top), "--json"];
}
export function portfolioHubEnvironment(config) {
    return {
        HOME: process.env.HOME ?? path.dirname(config.portfolioHubRoot),
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PYTHONPATH: path.join(config.portfolioHubRoot, "src"),
    };
}
export async function runPortfolioHubJson(configValue, args) {
    const config = parseInvestmentConfig(configValue);
    const env = portfolioHubEnvironment(config);
    let stdout;
    try {
        const result = await execFile(config.pythonPath, args, {
            cwd: config.portfolioHubRoot,
            env,
            timeout: 60_000,
            maxBuffer: 8 * 1024 * 1024,
            encoding: "utf8",
        });
        stdout = result.stdout;
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Portfolio Hub read failed: ${detail}`);
    }
    try {
        return JSON.parse(stdout);
    }
    catch {
        throw new Error("Portfolio Hub returned invalid JSON");
    }
}
