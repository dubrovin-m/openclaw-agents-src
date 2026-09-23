import { describe, expect, it, vi } from "vitest";
import { createGoogleCalendarProvider, providerEventRef } from "./provider.js";
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

    expect(result.events.map((event) => event.eventRef)).toEqual([
      providerEventRef({ id: "a", start: { dateTime: "2026-09-22T10:00:00+03:00" } }),
      providerEventRef({ id: "b", start: { date: "2026-09-22" } }),
    ]);
    expect(result.events[0]).not.toHaveProperty("id");
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
    const rawEvent = {
      id: "event-1",
      etag: "\"v1\"",
      eventLabelId: "label-strategy",
      start: { dateTime: "2026-09-22T10:00:00+03:00" },
      end: { dateTime: "2026-09-22T11:00:00+03:00" },
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [rawEvent] }));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });
    const eventRef = providerEventRef(rawEvent);

    await expect(provider.setLabel(VALID_CONFIG, {
      event_ref: eventRef,
      label_id: "label-strategy",
    })).resolves.toMatchObject({
      changed: false,
      event_ref: eventRef,
      label_id: "label-strategy",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sets only eventLabelId with conditional PATCH and no guest updates", async () => {
    const rawEvent = {
      id: "event-1",
      etag: "\"v1\"",
      eventLabelId: "label-delivery",
      start: { dateTime: "2026-09-22T10:00:00+03:00" },
      end: { dateTime: "2026-09-22T11:00:00+03:00" },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [rawEvent] }))
      .mockResolvedValueOnce(jsonResponse({
        ...rawEvent,
        etag: "\"v2\"",
        eventLabelId: "label-strategy",
      }));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });
    const eventRef = providerEventRef(rawEvent);

    await expect(provider.setLabel(VALID_CONFIG, {
      event_ref: eventRef,
      label_id: "label-strategy",
    })).resolves.toMatchObject({
      changed: true,
      event_ref: eventRef,
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
      event_ref: "ev_20260922_0123456789abcdef",
      label_id: "not-configured",
    })).rejects.toThrow(/not part of the effective analytical configuration/u);
    await expect(provider.setLabel(VALID_CONFIG, {
      event_ref: "ev_20260922_0123456789abcdef",
      label_id: "label-unclassified",
    })).rejects.toThrow(/not part of the effective analytical configuration/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
