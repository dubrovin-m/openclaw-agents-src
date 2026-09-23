export declare const CALENDAR_TIME_ZONE = "Europe/Moscow";
export declare const BASELINE_START = "10:00";
export declare const BASELINE_END = "19:00";
export type ProviderLabel = {
    id: string;
    name: string;
    backgroundColor: string;
};
export type ParentCategory = {
    id: string;
    name: string;
};
export type LeafCategory = {
    id: string;
    name: string;
    kind: "management" | "service";
    parentId?: string;
    providerLabel: ProviderLabel;
    definition: string;
    includes: string[];
    excludes: string[];
    examples: string[];
};
export type CalendarConfig = {
    designatedCalendar: string;
    providerTools: {
        prefix: string;
        read: string[];
        classificationWrite: string;
    };
    parents: ParentCategory[];
    leaves: LeafCategory[];
    unclassifiedLabel: ProviderLabel;
    classificationRules: string[];
    targets: {
        parents: Record<string, number>;
        leaves: Record<string, number>;
    };
};
export declare function parseCalendarConfig(value: unknown): CalendarConfig;
export declare function localDateTimeMs(date: string, clock: string): number;
export declare function addCivilDays(date: string, days: number): string;
export declare function localDate(epochMs: number): string;
export declare function isWorkingDate(date: string): boolean;
export declare function previousWorkingDates(endDate: string, count: number): string[];
export type ReviewKind = "daily" | "biweekly";
export declare function reviewWindow(kind: ReviewKind, boundaryIso?: string): {
    kind: ReviewKind;
    timeZone: string;
    boundary: string;
    workDates: string[];
    queryStart: string;
    queryEnd: string;
    baselineStart: string;
    baselineEnd: string;
};
export type AnalyticalEvent = {
    id: string;
    start: string;
    end: string;
    allDay?: boolean;
    classification?: string | null;
};
export declare function analyzeCalendar(configValue: unknown, kind: ReviewKind, boundaryIso: string | undefined, eventsValue: unknown): {
    window: {
        kind: ReviewKind;
        timeZone: string;
        boundary: string;
        workDates: string[];
        queryStart: string;
        queryEnd: string;
        baselineStart: string;
        baselineEnd: string;
    };
    hours: {
        scheduledLoad: number;
        measuredWorkday: number;
        management: number;
        service: number;
        unclassified: number;
        overlapUnattributed: number;
        freeWithinBaseline: number;
        outsideBaselineLoad: number;
    };
    coverage: {
        classificationPct: number | null;
        basisHours: number;
        excludedAllDayEvents: number;
    };
    parentAllocation: {
        [k: string]: {
            hours: number;
            actualPct: number | null;
            targetPct: number;
            deltaPct: number | null;
        };
    };
    leafAllocation: {
        [k: string]: {
            hours: number;
            actualPct: number | null;
            targetPct: number;
            deltaPct: number | null;
        };
    };
};
