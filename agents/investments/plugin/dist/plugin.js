import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { currentMoscowDate, holdingsArgs, runPortfolioHubJson, weeklyReviewArgs, } from "./core.js";
const configSchema = Type.Object({
    portfolioHubRoot: Type.String({ minLength: 1 }),
    pythonPath: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const weeklyReviewParameters = Type.Object({
    end_date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    days: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })),
}, { additionalProperties: false });
const holdingsParameters = Type.Object({
    top: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export default defineToolPlugin({
    id: "investment-analytics",
    name: "Investment Analytics",
    description: "Read-only Portfolio Hub access for the Investments Agent.",
    configSchema,
    tools: (tool) => [
        tool({
            name: "investment_weekly_review",
            label: "Weekly portfolio review inputs",
            description: "Read one consolidated cash-flow-adjusted portfolio review payload with current structure and deterministic risk metrics. This tool is read-only and does not make recommendations or execute trades.",
            parameters: weeklyReviewParameters,
            optional: true,
            execute: async (params, config) => {
                const endDate = params.end_date ?? currentMoscowDate();
                const days = params.days ?? 7;
                return runPortfolioHubJson(config, weeklyReviewArgs(endDate, days));
            },
        }),
        tool({
            name: "investment_holdings",
            label: "Portfolio holdings",
            description: "Read current normalized portfolio holdings and concentration from Portfolio Hub for instrument-level analysis. This tool is read-only.",
            parameters: holdingsParameters,
            optional: true,
            execute: async (params, config) => runPortfolioHubJson(config, holdingsArgs(params.top ?? 50)),
        }),
    ],
});
