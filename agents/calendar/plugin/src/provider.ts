import { createHash } from "node:crypto";
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

const EVENT_REF_PATTERN = /^evt_(\d{8})_([0-9a-f]{16})$/u;
const DAY_MS = 86_400_000;

function eventReferenceDate(event: Pick<ProviderEvent, "start">) {
  const start = eventTime(event.start).value;
  const match = start?.match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!match) throw new Error("Google Calendar event is missing a resolvable start date.");
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function identityDigest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function eventReference(event: Pick<ProviderEvent, "id" | "start">) {
  const providerId = bounded(event.id, "provider_event_id", 4096);
  const date = eventReferenceDate(event).replaceAll("-", "");
  return `evt_${date}_${identityDigest(providerId)}`;
}

function recurringReference(providerRecurringEventId: string) {
  return `series_${identityDigest(bounded(providerRecurringEventId, "provider_recurring_event_id", 4096))}`;
}

function parseEventReference(value: string) {
  const ref = bounded(value, "event_id", 64);
  const match = EVENT_REF_PATTERN.exec(ref);
  if (!match) {
    throw new Error("event_id must be a Calendar event reference returned by the provider.");
  }
  const compact = match[1];
  const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const [year, month, day] = date.split("-").map(Number);
  const dayStart = Date.UTC(year, month - 1, day);
  if (new Date(dayStart).toISOString().slice(0, 10) !== date) {
    throw new Error("event_id contains an invalid Calendar event-reference date.");
  }
  return { ref, date, dayStart };
}

function eventReferenceWindow(value: string) {
  const parsed = parseEventReference(value);
  return {
    ref: parsed.ref,
    timeMin: new Date(parsed.dayStart - DAY_MS).toISOString(),
    timeMax: new Date(parsed.dayStart + 2 * DAY_MS).toISOString(),
  };
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
    id: eventReference(event),
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
    recurringEventId: event.recurringEventId ? recurringReference(event.recurringEventId) : undefined,
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

function eventPath(config: CalendarConfig, providerEventId: string) {
  return `/calendars/${encodePath(config.designatedCalendar)}/events/${encodePath(bounded(providerEventId, "provider_event_id", 4096))}`;
}

function validateConfiguredLabel(config: CalendarConfig, labelId: string) {
  const allowed = new Set(config.leaves.map((leaf) => leaf.providerLabel.id));
  const id = bounded(labelId, "label_id", 1024);
  if (!allowed.has(id)) throw new Error("label_id is not part of the effective analytical configuration.");
  return id;
}

async function listProviderEvents(
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

async function resolveEventReference(
  deps: GoogleCalendarProviderDeps,
  config: CalendarConfig,
  value: string,
) {
  const window = eventReferenceWindow(value);
  const events = await listProviderEvents(deps, config, window.timeMin, window.timeMax);
  const matches = events.filter((event) => eventReference(event) === window.ref);
  if (matches.length === 0) {
    throw new Error("Calendar event reference could not be resolved in its bounded provider window.");
  }
  if (matches.length > 1) {
    throw new Error("Calendar event reference resolved ambiguously; refusing provider mutation.");
  }
  return matches[0];
}

export function createGoogleCalendarProvider(deps: GoogleCalendarProviderDeps = {}) {
  return {
    async listEvents(configValue: unknown, params: { time_min: string; time_max: string }) {
      const config = parseCalendarConfig(configValue);
      const timeMin = bounded(params.time_min, "time_min");
      const timeMax = bounded(params.time_max, "time_max");
      const items = await listProviderEvents(deps, config, timeMin, timeMax);
      return {
        calendarId: config.designatedCalendar,
        events: items.map(normalizeProviderEvent),
      };
    },

    async getEvent(configValue: unknown, params: { event_id: string }) {
      const config = parseCalendarConfig(configValue);
      const resolved = await resolveEventReference(deps, config, params.event_id);
      const url = apiUrl(eventPath(config, resolved.id));
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
      let current = await requestJson<Record<string, unknown> & {
        id?: string;
        etag?: string;
        labelProperties?: {
          eventLabels?: Array<{ id?: string; name?: string; backgroundColor?: string }>;
        };
      }>(deps, readUrl);
      let changed = false;

      for (const expected of configured) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const existing = current.labelProperties?.eventLabels ?? [];
          const actual = existing.find((label) => label.id === expected.id);
          if (actual?.name === expected.name && actual.backgroundColor === expected.backgroundColor) break;

          const merged = actual
            ? existing.map((label) => label.id === expected.id ? expected : label)
            : [...existing, expected];
          const headers = new Headers();
          if (current.etag) headers.set("if-match", current.etag);
          const writeUrl = apiUrl(`/calendars/${encodePath(current.id ?? config.designatedCalendar)}`);

          try {
            const updated = await requestJson<Record<string, unknown> & {
              id?: string;
              etag?: string;
              labelProperties?: {
                eventLabels?: Array<{ id?: string; name?: string; backgroundColor?: string }>;
              };
            }>(deps, writeUrl, {
              method: "PATCH",
              headers,
              body: JSON.stringify({
                labelProperties: {
                  ...(record(current.labelProperties) ?? {}),
                  eventLabels: merged,
                },
              }),
            });
            const persisted = updated.labelProperties?.eventLabels?.find((label) => label.id === expected.id);
            if (!persisted || persisted.name !== expected.name || persisted.backgroundColor !== expected.backgroundColor) {
              throw new Error(`Google Calendar analytical label sync did not persist configured label ${expected.id}.`);
            }
            current = updated;
            changed = true;
            break;
          } catch (error) {
            if ((error as Error & { status?: number }).status === 412 && attempt === 0) {
              current = await requestJson(deps, readUrl);
              continue;
            }
            throw error;
          }
        }
      }

      const finalLabels = current.labelProperties?.eventLabels ?? [];
      for (const expected of configured) {
        const actual = finalLabels.find((label) => label.id === expected.id);
        if (!actual || actual.name !== expected.name || actual.backgroundColor !== expected.backgroundColor) {
          throw new Error(`Google Calendar analytical label sync did not converge for configured label ${expected.id}.`);
        }
      }
      return { changed, calendar_id: current.id ?? config.designatedCalendar, labels: configured };
    },

    async setLabel(configValue: unknown, params: { event_id: string; label_id: string }) {
      const config = parseCalendarConfig(configValue);
      const labelId = validateConfiguredLabel(config, params.label_id);
      const resolved = await resolveEventReference(deps, config, params.event_id);
      const path = eventPath(config, resolved.id);
      const current = await requestJson<ProviderEvent>(deps, apiUrl(path));
      if (current.eventLabelId === labelId) {
        return {
          changed: false,
          event_id: eventReference(current),
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
        event_id: eventReference(updated),
        label_id: updated.eventLabelId ?? labelId,
        etag: updated.etag,
      };
    },
  };
}
