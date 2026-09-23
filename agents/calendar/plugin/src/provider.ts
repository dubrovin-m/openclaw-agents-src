import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { addCivilDays, localDate, parseCalendarConfig, type CalendarConfig } from "./core.js";

const CALENDAR_API_ROOT = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.calendars.readonly",
] as const;

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
  eventRef: string;
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
  labels: Array<{ id: string; name?: string; backgroundColor: string }>;
};

type TokenProvider = () => Promise<string>;
type FetchLike = typeof fetch;

export type GoogleCalendarProviderDeps = {
  getAccessToken?: TokenProvider;
  fetchImpl?: FetchLike;
};

function bounded(value: string, field: string, max = 4096) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`${field} is missing or too long.`);
  return trimmed;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function eventTime(value: unknown) {
  const object = record(value);
  if (!object) return { value: undefined, allDay: false };
  if (typeof object.dateTime === "string" && object.dateTime.trim()) {
    return { value: object.dateTime, allDay: false };
  }
  if (typeof object.date === "string" && object.date.trim()) {
    return { value: object.date, allDay: true };
  }
  return { value: undefined, allDay: false };
}

function eventDateKey(event: ProviderEvent) {
  const start = eventTime(event.start);
  if (!start.value) throw new Error("Calendar event is missing start time.");
  if (start.allDay) return start.value.replaceAll("-", "");
  const epochMs = Date.parse(start.value);
  if (!Number.isFinite(epochMs)) throw new Error("Calendar event has invalid start time.");
  return localDate(epochMs).replaceAll("-", "");
}

export function providerEventRef(event: ProviderEvent) {
  const digest = createHash("sha256").update(event.id).digest("hex").slice(0, 16);
  return `ev_${eventDateKey(event)}_${digest}`;
}

function normalizeProviderEvent(event: ProviderEvent): CalendarEventView {
  const start = eventTime(event.start);
  const end = eventTime(event.end);
  const originalStart = eventTime(event.originalStartTime);
  const selfAttendee = event.attendees
    ?.map((value) => record(value))
    .find((value) => value?.self === true);
  const responseStatus = typeof selfAttendee?.responseStatus === "string"
    ? selfAttendee.responseStatus
    : undefined;
  return {
    eventRef: providerEventRef(event),
    etag: event.etag,
    status: event.status,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: start.value,
    end: end.value,
    allDay: start.allDay && end.allDay,
    organizer: event.organizer,
    creator: event.creator,
    attendees: event.attendees,
    myResponseStatus: responseStatus,
    transparency: event.transparency,
    recurringEventId: event.recurringEventId,
    originalStartTime: originalStart.value,
    eventType: event.eventType,
    eventLabelId: event.eventLabelId,
  };
}

function apiUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  const url = new URL(`${CALENDAR_API_ROOT}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function encodePath(value: string) {
  return encodeURIComponent(value);
}

async function defaultAccessToken() {
  const auth = new GoogleAuth({ scopes: [...GOOGLE_CALENDAR_SCOPES] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const accessToken = typeof token === "string" ? token : token?.token;
  if (!accessToken) throw new Error("Google Calendar ADC did not provide an access token.");
  return accessToken;
}

async function requestJson<T>(
  deps: GoogleCalendarProviderDeps,
  url: URL,
  init: RequestInit = {},
): Promise<T> {
  const getAccessToken = deps.getAccessToken ?? defaultAccessToken;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetchImpl(url, { ...init, headers });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 2000);
    throw new Error(`Google Calendar API ${response.status}: ${text || response.statusText}`);
  }
  return await response.json() as T;
}

function eventPath(config: CalendarConfig, eventId: string) {
  return `/calendars/${encodePath(config.designatedCalendar)}/events/${encodePath(bounded(eventId, "provider_event_id", 1024))}`;
}

function parseEventRef(value: string) {
  const eventRef = bounded(value, "event_ref", 64);
  const match = /^ev_(\d{8})_([0-9a-f]{16})$/u.exec(eventRef);
  if (!match) throw new Error("event_ref is invalid.");
  const date = `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}`;
  return { eventRef, date };
}

async function listRawEvents(
  deps: GoogleCalendarProviderDeps,
  config: CalendarConfig,
  timeMin: string,
  timeMax: string,
) {
  const items: ProviderEvent[] = [];
  let pageToken: string | undefined;
  do {
    const url = apiUrl(
      `/calendars/${encodePath(config.designatedCalendar)}/events`,
      {
        timeMin,
        timeMax,
        singleEvents: true,
        showDeleted: false,
        maxResults: 2500,
        pageToken,
      },
    );
    const page = await requestJson<{ items?: ProviderEvent[]; nextPageToken?: string }>(deps, url);
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

async function resolveEventRef(
  deps: GoogleCalendarProviderDeps,
  config: CalendarConfig,
  value: string,
) {
  const { eventRef, date } = parseEventRef(value);
  const next = addCivilDays(date, 1);
  const items = await listRawEvents(
    deps,
    config,
    `${date}T00:00:00+03:00`,
    `${next}T00:00:00+03:00`,
  );
  const matches = items.filter((event) => providerEventRef(event) === eventRef);
  if (matches.length === 0) throw new Error("event_ref no longer resolves to an event in the designated calendar.");
  if (matches.length > 1) throw new Error("event_ref is ambiguous in the designated calendar.");
  return matches[0];
}

function validateConfiguredLabel(config: CalendarConfig, labelId: string) {
  const allowed = new Set(config.leaves.map((leaf) => leaf.providerLabel.id));
  const id = bounded(labelId, "label_id", 1024);
  if (!allowed.has(id)) throw new Error("label_id is not part of the effective analytical configuration.");
  return id;
}

export function createGoogleCalendarProvider(deps: GoogleCalendarProviderDeps = {}) {
  return {
    async listEvents(configValue: unknown, params: { time_min: string; time_max: string }) {
      const config = parseCalendarConfig(configValue);
      const timeMin = bounded(params.time_min, "time_min");
      const timeMax = bounded(params.time_max, "time_max");
      const items = await listRawEvents(deps, config, timeMin, timeMax);
      return {
        calendarId: config.designatedCalendar,
        events: items.map(normalizeProviderEvent),
      };
    },

    async getEvent(configValue: unknown, params: { event_ref: string }) {
      const config = parseCalendarConfig(configValue);
      const event = await resolveEventRef(deps, config, params.event_ref);
      return normalizeProviderEvent(event);
    },

    async getLabels(configValue: unknown) {
      const config = parseCalendarConfig(configValue);
      const url = apiUrl(`/calendars/${encodePath(config.designatedCalendar)}`);
      const calendar = await requestJson<{
        id?: string;
        labelProperties?: {
          eventLabels?: Array<{ id?: string; name?: string; backgroundColor?: string }>;
        };
      }>(deps, url);
      const labels = (calendar.labelProperties?.eventLabels ?? []).flatMap((label) => {
        if (!label.id || !label.backgroundColor) return [];
        return [{
          id: label.id,
          ...(label.name ? { name: label.name } : {}),
          backgroundColor: label.backgroundColor,
        }];
      });
      return { calendarId: calendar.id ?? config.designatedCalendar, labels } satisfies CalendarLabels;
    },

    async setLabel(configValue: unknown, params: { event_ref: string; label_id: string }) {
      const config = parseCalendarConfig(configValue);
      const labelId = validateConfiguredLabel(config, params.label_id);
      const current = await resolveEventRef(deps, config, params.event_ref);
      const eventRef = providerEventRef(current);
      const path = eventPath(config, current.id);
      if (current.eventLabelId === labelId) {
        return {
          changed: false,
          event_ref: eventRef,
          label_id: labelId,
          etag: current.etag,
        };
      }
      const headers = new Headers();
      if (current.etag) headers.set("if-match", current.etag);
      const updated = await requestJson<ProviderEvent>(
        deps,
        apiUrl(path, { eventLabelVersion: 1, sendUpdates: "none" }),
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ eventLabelId: labelId }),
        },
      );
      return {
        changed: true,
        event_ref: eventRef,
        label_id: updated.eventLabelId ?? labelId,
        etag: updated.etag,
      };
    },
  };
}
