import { GoogleAuth } from "google-auth-library";
import { parseCalendarConfig, type CalendarConfig } from "./core.js";

const CALENDAR_API_ROOT = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.calendars",
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
    id: event.id,
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
    const error = new Error(`Google Calendar API ${response.status}: ${text || response.statusText}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return await response.json() as T;
}

function eventPath(config: CalendarConfig, eventId: string) {
  return `/calendars/${encodePath(config.designatedCalendar)}/events/${encodePath(bounded(eventId, "event_id", 1024))}`;
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
      return {
        calendarId: config.designatedCalendar,
        events: items.map(normalizeProviderEvent),
      };
    },

    async getEvent(configValue: unknown, params: { event_id: string }) {
      const config = parseCalendarConfig(configValue);
      const url = apiUrl(eventPath(config, params.event_id));
      const event = await requestJson<ProviderEvent>(deps, url);
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

    async syncLabels(configValue: unknown) {
      const config = parseCalendarConfig(configValue);
      const readUrl = apiUrl(`/calendars/${encodePath(config.designatedCalendar)}`);
      const configured = [...config.leaves.map((leaf) => leaf.providerLabel), config.unclassifiedLabel];
      const configuredById = new Map(configured.map((label) => [label.id, label]));

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await requestJson<Record<string, unknown> & {
          id?: string;
          etag?: string;
          labelProperties?: {
            eventLabels?: Array<{ id?: string; name?: string; backgroundColor?: string }>;
          };
        }>(deps, readUrl);

        const existing = current.labelProperties?.eventLabels ?? [];
        const merged = existing.map((label) => {
          const replacement = label.id ? configuredById.get(label.id) : undefined;
          return replacement ?? label;
        });
        const existingIds = new Set(existing.flatMap((label) => label.id ? [label.id] : []));
        for (const label of configured) {
          if (!existingIds.has(label.id)) merged.push(label);
        }

        const unchanged = existing.length === merged.length && existing.every((label, index) => {
          const next = merged[index];
          return label.id === next.id
            && label.name === next.name
            && label.backgroundColor === next.backgroundColor;
        });
        if (unchanged) {
          return { changed: false, calendar_id: current.id ?? config.designatedCalendar, labels: configured };
        }

        const updatedBody = {
          ...current,
          labelProperties: {
            ...(record(current.labelProperties) ?? {}),
            eventLabels: merged,
          },
        };
        const headers = new Headers();
        if (current.etag) headers.set("if-match", current.etag);

        try {
          const writeUrl = apiUrl(`/calendars/${encodePath(current.id ?? config.designatedCalendar)}`);
          const updated = await requestJson<Record<string, unknown> & {
            id?: string;
            labelProperties?: {
              eventLabels?: Array<{ id?: string; name?: string; backgroundColor?: string }>;
            };
          }>(deps, writeUrl, {
            method: "PUT",
            headers,
            body: JSON.stringify(updatedBody),
          });

          const updatedLabels = updated.labelProperties?.eventLabels ?? [];
          for (const expected of configured) {
            const actual = updatedLabels.find((label) => label.id === expected.id);
            if (!actual || actual.name !== expected.name || actual.backgroundColor !== expected.backgroundColor) {
              throw new Error(`Google Calendar analytical label sync did not persist configured label ${expected.id}.`);
            }
          }
          return { changed: true, calendar_id: updated.id ?? config.designatedCalendar, labels: configured };
        } catch (error) {
          if ((error as Error & { status?: number }).status === 412 && attempt === 0) continue;
          throw error;
        }
      }

      throw new Error("Google Calendar analytical label sync could not resolve a concurrent Calendar update.");
    },

    async setLabel(configValue: unknown, params: { event_id: string; label_id: string }) {
      const config = parseCalendarConfig(configValue);
      const labelId = validateConfiguredLabel(config, params.label_id);
      const path = eventPath(config, params.event_id);
      const current = await requestJson<ProviderEvent>(deps, apiUrl(path));
      if (current.eventLabelId === labelId) {
        return {
          changed: false,
          event_id: current.id,
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
        event_id: updated.id,
        label_id: updated.eventLabelId ?? labelId,
        etag: updated.etag,
      };
    },
  };
}
