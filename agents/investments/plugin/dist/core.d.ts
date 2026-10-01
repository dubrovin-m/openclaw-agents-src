export type InvestmentPluginConfig = {
    portfolioHubRoot: string;
    pythonPath: string;
};
export declare function parseInvestmentConfig(value: unknown): InvestmentPluginConfig;
export declare function currentMoscowDate(now?: Date): string;
export declare function weeklyReviewArgs(endDate: string, days: number): string[];
export declare function holdingsArgs(top: number): string[];
export declare function portfolioHubEnvironment(config: InvestmentPluginConfig): NodeJS.ProcessEnv;
export declare function runPortfolioHubJson(configValue: unknown, args: string[]): Promise<unknown>;
