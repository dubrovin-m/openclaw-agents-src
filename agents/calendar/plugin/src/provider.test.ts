import { describe, expect, it, vi } from "vitest";
import { createGoogleCalendarProvider } from "./provider.js";
import { VALID_CONFIG } from "./test-fixture.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Google Calendar provider", () => {
  it("lists events only from the designated calendar and paginates", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        items: [{
          id: "a",
          summary: "A",
          start: { dateTime: "2026-09-22T10:00:00+03:00" },
          end: { dateTime: "2026-09-22T11:00:00+03:00" },
          attendees: [{ self: true, responseStatus: "accepted" }],
        }],
        nextPageToken: "next",
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{
          id: "b",
          summary: "B",
          start: { date: "2026-09-22" },
          end: { date: "2026-09-23" },
        }],
      }));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    const result = await provider.listEvents(VALID_CONFIG, {
      time_min: "2026-09-22T00:00:00+03:00",
      time_max: "2026-09-23T00:00:00+03:00",
    });

    expect(result.events.map((event) => event.id)).toEqual(["a", "b"]);
    expect(result.events[0]).toMatchObject({
      start: "2026-09-22T10:00:00+03:00",
      end: "2026-09-22T11:00:00+03:00",
      allDay: false,
      myResponseStatus: "accepted",
    });
    expect(result.events[1]).toMatchObject({
      start: "2026-09-22",
      end: "2026-09-23",
      allDay: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(firstUrl.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(firstUrl.searchParams.get("singleEvents")).toBe("true");
    expect(firstUrl.searchParams.get("showDeleted")).toBe("false");
    const secondUrl = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(secondUrl.searchParams.get("pageToken")).toBe("next");
  });

  it("reads custom labels from calendar metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      id: "primary",
      labelProperties: {
        eventLabels: [
          { id: "label-strategy", name: "Strategy", backgroundColor: "#336699" },
          { id: "broken" },
        ],
      },
    }));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.getLabels(VALID_CONFIG)).resolves.toEqual({
      calendarId: "primary",
      labels: [{ id: "label-strategy", name: "Strategy", backgroundColor: "#336699" }],
    });
  });

  it("is idempotent when the requested label is already present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      id: "event-1",
      etag: "\"v1\"",
      eventLabelId: "label-strategy",
    }));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.setLabel(VALID_CONFIG, {
      event_id: "event-1",
      label_id: "label-strategy",
    })).resolves.toMatchObject({
      changed: false,
      event_id: "event-1",
      label_id: "label-strategy",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sets only eventLabelId with conditional PATCH and no guest updates", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: "event-1",
        etag: "\"v1\"",
        eventLabelId: "label-delivery",
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: "event-1",
        etag: "\"v2\"",
        eventLabelId: "label-strategy",
      }));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.setLabel(VALID_CONFIG, {
      event_id: "event-1",
      label_id: "label-strategy",
    })).resolves.toMatchObject({
      changed: true,
      label_id: "label-strategy",
    });

    const [rawUrl, init] = fetchImpl.mock.calls[1];
    const url = new URL(String(rawUrl));
    expect(url.searchParams.get("eventLabelVersion")).toBe("1");
    expect(url.searchParams.get("sendUpdates")).toBe("none");
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("if-match")).toBe("\"v1\"");
    expect(JSON.parse(String(init?.body))).toEqual({ eventLabelId: "label-strategy" });
  });

  it("rejects labels outside writable configured categories, including technical Unclassified", async () => {
    const fetchImpl = vi.fn();
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.setLabel(VALID_CONFIG, {
      event_id: "event-1",
      label_id: "not-configured",
    })).rejects.toThrow(/not part of the effective analytical configuration/u);
    await expect(provider.setLabel(VALID_CONFIG, {
      event_id: "event-1",
      label_id: "label-unclassified",
    })).rejects.toThrow(/not part of the effective analytical configuration/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("synchronizes configured analytical labels while preserving unrelated Calendar state", async () => {
    const currentCalendar = {
      id: "calendar@example.com",
      etag: "\"c1\"",
      summary: "AI Calendar",
      description: "keep me",
      timeZone: "Europe/Moscow",
      labelProperties: {
        eventLabels: [
          { id: "label-strategy", backgroundColor: "#336699" },
          { id: "unrelated-label", name: "Personal", backgroundColor: "#123456" },
        ],
      },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(currentCalendar))
      .mockResolvedValueOnce(jsonResponse({
        ...currentCalendar,
        labelProperties: {
          eventLabels: [
            { id: "label-strategy", name: "Strategy", backgroundColor: "#336699" },
            { id: "unrelated-label", name: "Personal", backgroundColor: "#123456" },
            { id: "label-delivery", name: "Delivery", backgroundColor: "#669933" },
            { id: "label-service", name: "Service", backgroundColor: "#999999" },
            { id: "label-unclassified", name: "Unclassified", backgroundColor: "#CCCCCC" },
          ],
        },
      }));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.syncLabels(VALID_CONFIG)).resolves.toMatchObject({
      changed: true,
      calendar_id: "calendar@example.com",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [rawUrl, init] = fetchImpl.mock.calls[1];
    expect(new URL(String(rawUrl)).pathname).toBe("/calendar/v3/calendars/calendar%40example.com");
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("if-match")).toBe("\"c1\"");
    const body = JSON.parse(String(init?.body));
    expect(body.summary).toBe("AI Calendar");
    expect(body.description).toBe("keep me");
    expect(body.timeZone).toBe("Europe/Moscow");
    expect(body.labelProperties.eventLabels).toContainEqual(
      { id: "unrelated-label", name: "Personal", backgroundColor: "#123456" },
    );
    expect(body.labelProperties.eventLabels).toContainEqual(
      { id: "label-strategy", name: "Strategy", backgroundColor: "#336699" },
    );
  });
  it("re-reads and re-merges labels after a concurrent Calendar update", async () => {
    const first = {
      id: "calendar@example.com",
      etag: "\"c1\"",
      summary: "AI Calendar",
      labelProperties: {
        eventLabels: [{ id: "unrelated-a", name: "A", backgroundColor: "#111111" }],
      },
    };
    const latest = {
      id: "calendar@example.com",
      etag: "\"c2\"",
      summary: "AI Calendar",
      labelProperties: {
        eventLabels: [
          { id: "unrelated-a", name: "A", backgroundColor: "#111111" },
          { id: "unrelated-b", name: "B", backgroundColor: "#222222" },
        ],
      },
    };
    const persistedLabels = [
      ...latest.labelProperties.eventLabels,
      { id: "label-strategy", name: "Strategy", backgroundColor: "#336699" },
      { id: "label-delivery", name: "Delivery", backgroundColor: "#669933" },
      { id: "label-service", name: "Service", backgroundColor: "#999999" },
      { id: "label-unclassified", name: "Unclassified", backgroundColor: "#CCCCCC" },
    ];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse({ error: "precondition" }, 412))
      .mockResolvedValueOnce(jsonResponse(latest))
      .mockResolvedValueOnce(jsonResponse({
        ...latest,
        etag: "\"c3\"",
        labelProperties: { eventLabels: persistedLabels },
      }));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.syncLabels(VALID_CONFIG)).resolves.toMatchObject({ changed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(new URL(String(fetchImpl.mock.calls[1][0])).pathname).toBe("/calendar/v3/calendars/calendar%40example.com");
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get("if-match")).toBe("\"c1\"");
    expect(new URL(String(fetchImpl.mock.calls[3][0])).pathname).toBe("/calendar/v3/calendars/calendar%40example.com");
    expect(new Headers(fetchImpl.mock.calls[3][1]?.headers).get("if-match")).toBe("\"c2\"");
    const retriedBody = JSON.parse(String(fetchImpl.mock.calls[3][1]?.body));
    expect(retriedBody.labelProperties.eventLabels).toContainEqual(
      { id: "unrelated-b", name: "B", backgroundColor: "#222222" },
    );
  });


});
