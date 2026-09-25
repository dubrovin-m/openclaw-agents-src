export declare const GOOGLE_CALENDAR_SCOPES: readonly ["https://www.googleapis.com/auth/calendar.events.owned", "https://www.googleapis.com/auth/calendar.calendars"];
export type ProviderEvent = {
    id: string;
    etag?: string;
    status?: string;
    summary?: string;
    description?: string;
    location?: string;
    start?: unknown;
    end?: unknown;
    organizer?: unknown;
    creator?: unknown;
    attendees?: unknown[];
    transparency?: string;
    recurringEventId?: string;
    originalStartTime?: unknown;
    eventType?: string;
    eventLabelId?: string;
    extendedProperties?: unknown;
};
export type CalendarEventView = {
    id: string;
    etag?: string;
    status?: string;
    summary?: string;
    description?: string;
    location?: string;
    start?: string;
    end?: string;
    allDay: boolean;
    organizer?: unknown;
    creator?: unknown;
    attendees?: unknown[];
    myResponseStatus?: string;
    transparency?: string;
    recurringEventId?: string;
    originalStartTime?: string;
    eventType?: string;
    eventLabelId?: string;
};
export type CalendarLabels = {
    calendarId: string;
    labels: Array<{
        id: string;
        name?: string;
        backgroundColor: string;
    }>;
};
type TokenProvider = () => Promise<string>;
type FetchLike = typeof fetch;
export type GoogleCalendarProviderDeps = {
    getAccessToken?: TokenProvider;
    fetchImpl?: FetchLike;
};
export declare function eventReference(event: Pick<ProviderEvent, "id" | "start">): string;
export declare function createGoogleCalendarProvider(deps?: GoogleCalendarProviderDeps): {
    listEvents(configValue: unknown, params: {
        time_min: string;
        time_max: string;
    }): Promise<{
        calendarId: string;
        events: CalendarEventView[];
    }>;
    getEvent(configValue: unknown, params: {
        event_id: string;
    }): Promise<CalendarEventView>;
    getLabels(configValue: unknown): Promise<{
        calendarId: string;
        labels: {
            backgroundColor: string;
            name?: string | undefined;
            id: string;
        }[];
    }>;
    syncLabels(configValue: unknown): Promise<{
        changed: boolean;
        calendar_id: string;
        labels: import("./core.js").ProviderLabel[];
    }>;
    setLabel(configValue: unknown, params: {
        event_id: string;
        label_id: string;
    }): Promise<{
        changed: boolean;
        event_id: string;
        label_id: string;
        etag: string | undefined;
    }>;
};
export {};
