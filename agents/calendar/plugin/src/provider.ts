import { GoogleAuth } from "google-auth-library";
import { parseCalendarConfig, type CalendarConfig } from "./core.js";

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
  return `/calendars/${encodePath(config.designatedCalendar)}/events/${encodePath(bounded(eventId, "event_id", 1024))}`;
}

function validateConfiguredLabel(config: CalendarConfig, labelId: string) {
  const allowed = new Set([
    ...config.leaves.map((leaf) => leaf.providerLabel.id),
    config.unclassifiedLabel.id,
  ]);
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
      return { calendarId: config.designatedCalendar, events: items };
    },

    async getEvent(configValue: unknown, params: { event_id: string }) {
      const config = parseCalendarConfig(configValue);
      const url = apiUrl(eventPath(config, params.event_id));
      return await requestJson<ProviderEvent>(deps, url);
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
