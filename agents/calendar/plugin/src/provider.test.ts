import { describe, expect, it, vi } from "vitest";
import { createGoogleCalendarProvider, eventReference } from "./provider.js";
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
          recurringEventId: "provider-series-a",
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

    expect(result.events).toHaveLength(2);
    expect(result.events[0].id).toMatch(/^evt_20260922_[0-9a-f]{16}$/u);
    expect(result.events[1].id).toMatch(/^evt_20260922_[0-9a-f]{16}$/u);
    expect(result.events[0].id).not.toBe(result.events[1].id);
    expect(result.events[0]).toMatchObject({
      start: "2026-09-22T10:00:00+03:00",
      end: "2026-09-22T11:00:00+03:00",
      allDay: false,
      myResponseStatus: "accepted",
      recurringEventId: expect.stringMatching(/^series_[0-9a-f]{16}$/u),
    });
    expect(result.events[0].recurringEventId).not.toBe("provider-series-a");
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
      start: { dateTime: "2026-09-22T10:00:00+03:00" },
      etag: "\"v1\"",
      eventLabelId: "label-strategy",
    };
    const ref = eventReference(rawEvent);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [rawEvent] }))
      .mockResolvedValueOnce(jsonResponse(rawEvent));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.setLabel(VALID_CONFIG, {
      event_id: ref,
      label_id: "label-strategy",
    })).resolves.toMatchObject({
      changed: false,
      event_id: ref,
      label_id: "label-strategy",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps long provider identity inside the deterministic layer during label writes", async () => {
    const providerId = `opaque_${"60o30c1g".repeat(24)}`;
    const listedEvent = {
      id: providerId,
      start: { dateTime: "2026-09-22T10:00:00+03:00" },
      end: { dateTime: "2026-09-22T11:00:00+03:00" },
    };
    const currentEvent = {
      ...listedEvent,
      etag: "\"v1\"",
      eventLabelId: "label-delivery",
    };
    const updatedEvent = {
      ...listedEvent,
      etag: "\"v2\"",
      eventLabelId: "label-strategy",
    };
    const ref = eventReference(listedEvent);
    expect(ref).toMatch(/^evt_20260922_[0-9a-f]{16}$/u);
    expect(ref).not.toContain(providerId);

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [listedEvent] }))
      .mockResolvedValueOnce(jsonResponse(currentEvent))
      .mockResolvedValueOnce(jsonResponse(updatedEvent));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.setLabel(VALID_CONFIG, {
      event_id: ref,
      label_id: "label-strategy",
    })).resolves.toMatchObject({
      changed: true,
      event_id: ref,
      label_id: "label-strategy",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const resolutionUrl = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(resolutionUrl.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(resolutionUrl.searchParams.get("singleEvents")).toBe("true");

    const getUrl = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(getUrl.pathname).toBe(`/calendar/v3/calendars/primary/events/${providerId}`);

    const [rawUrl, init] = fetchImpl.mock.calls[2];
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe(`/calendar/v3/calendars/primary/events/${providerId}`);
    expect(url.searchParams.get("eventLabelVersion")).toBe("1");
    expect(url.searchParams.get("sendUpdates")).toBe("none");
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("if-match")).toBe("\"v1\"");
    expect(JSON.parse(String(init?.body))).toEqual({ eventLabelId: "label-strategy" });
  });

  it("fails closed when a model-visible event reference is corrupted", async () => {
    const listedEvent = {
      id: "provider-event-1",
      start: { dateTime: "2026-09-22T10:00:00+03:00" },
      end: { dateTime: "2026-09-22T11:00:00+03:00" },
    };
    const ref = eventReference(listedEvent);
    const corrupted = `${ref.slice(0, -1)}${ref.endsWith("a") ? "b" : "a"}`;
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ items: [listedEvent] }));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.setLabel(VALID_CONFIG, {
      event_id: corrupted,
      label_id: "label-strategy",
    })).rejects.toThrow(/could not be resolved/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it("synchronizes one configured analytical label while preserving unrelated Calendar state", async () => {
    const currentCalendar = {
      id: "calendar@example.com",
      etag: "\"c1\"",
      summary: "AI Calendar",
      description: "keep me",
      timeZone: "Europe/Moscow",
      labelProperties: {
        eventLabels: [
          { id: "label-strategy", backgroundColor: "#336699" },
          { id: "label-delivery", name: "Delivery", backgroundColor: "#669933" },
          { id: "label-service", name: "Service", backgroundColor: "#999999" },
          { id: "label-unclassified", name: "Unclassified", backgroundColor: "#CCCCCC" },
          { id: "unrelated-label", name: "Personal", backgroundColor: "#123456" },
        ],
      },
    };
    const updatedCalendar = {
      ...currentCalendar,
      etag: "\"c2\"",
      labelProperties: {
        eventLabels: [
          { id: "label-strategy", name: "Strategy", backgroundColor: "#336699" },
          ...currentCalendar.labelProperties.eventLabels.slice(1),
        ],
      },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(currentCalendar))
      .mockResolvedValueOnce(jsonResponse(updatedCalendar));
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
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("if-match")).toBe("\"c1\"");
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body)).toEqual(["labelProperties"]);
    expect(body.summary).toBeUndefined();
    expect(body.description).toBeUndefined();
    expect(body.timeZone).toBeUndefined();
    expect(body.labelProperties.eventLabels).toContainEqual(
      { id: "unrelated-label", name: "Personal", backgroundColor: "#123456" },
    );
    expect(body.labelProperties.eventLabels).toContainEqual(
      { id: "label-strategy", name: "Strategy", backgroundColor: "#336699" },
    );
  });

  it("patches multiple missing configured labels one at a time", async () => {
    const baseLabels = [
      { id: "label-service", name: "Service", backgroundColor: "#999999" },
      { id: "label-unclassified", name: "Unclassified", backgroundColor: "#CCCCCC" },
      { id: "unrelated-label", name: "Personal", backgroundColor: "#123456" },
    ];
    const first = {
      id: "calendar@example.com",
      etag: "\"c1\"",
      labelProperties: { eventLabels: baseLabels },
    };
    const afterStrategy = {
      ...first,
      etag: "\"c2\"",
      labelProperties: {
        eventLabels: [
          ...baseLabels,
          { id: "label-strategy", name: "Strategy", backgroundColor: "#336699" },
        ],
      },
    };
    const afterDelivery = {
      ...afterStrategy,
      etag: "\"c3\"",
      labelProperties: {
        eventLabels: [
          ...afterStrategy.labelProperties.eventLabels,
          { id: "label-delivery", name: "Delivery", backgroundColor: "#669933" },
        ],
      },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse(afterStrategy))
      .mockResolvedValueOnce(jsonResponse(afterDelivery));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.syncLabels(VALID_CONFIG)).resolves.toMatchObject({ changed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const firstPatch = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    const secondPatch = JSON.parse(String(fetchImpl.mock.calls[2][1]?.body));
    expect(firstPatch.labelProperties.eventLabels).toContainEqual(
      { id: "label-strategy", name: "Strategy", backgroundColor: "#336699" },
    );
    expect(firstPatch.labelProperties.eventLabels).not.toContainEqual(
      { id: "label-delivery", name: "Delivery", backgroundColor: "#669933" },
    );
    expect(secondPatch.labelProperties.eventLabels).toContainEqual(
      { id: "label-delivery", name: "Delivery", backgroundColor: "#669933" },
    );
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get("if-match")).toBe("\"c1\"");
    expect(new Headers(fetchImpl.mock.calls[2][1]?.headers).get("if-match")).toBe("\"c2\"");
  });

  it("re-reads and re-merges one label after a concurrent Calendar update", async () => {
    const correctTail = [
      { id: "label-delivery", name: "Delivery", backgroundColor: "#669933" },
      { id: "label-service", name: "Service", backgroundColor: "#999999" },
      { id: "label-unclassified", name: "Unclassified", backgroundColor: "#CCCCCC" },
    ];
    const first = {
      id: "calendar@example.com",
      etag: "\"c1\"",
      labelProperties: {
        eventLabels: [
          ...correctTail,
          { id: "unrelated-a", name: "A", backgroundColor: "#111111" },
        ],
      },
    };
    const latest = {
      id: "calendar@example.com",
      etag: "\"c2\"",
      labelProperties: {
        eventLabels: [
          ...correctTail,
          { id: "unrelated-a", name: "A", backgroundColor: "#111111" },
          { id: "unrelated-b", name: "B", backgroundColor: "#222222" },
        ],
      },
    };
    const persisted = {
      ...latest,
      etag: "\"c3\"",
      labelProperties: {
        eventLabels: [
          ...latest.labelProperties.eventLabels,
          { id: "label-strategy", name: "Strategy", backgroundColor: "#336699" },
        ],
      },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse({ error: "precondition" }, 412))
      .mockResolvedValueOnce(jsonResponse(latest))
      .mockResolvedValueOnce(jsonResponse(persisted));
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.syncLabels(VALID_CONFIG)).resolves.toMatchObject({ changed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get("if-match")).toBe("\"c1\"");
    expect(new Headers(fetchImpl.mock.calls[3][1]?.headers).get("if-match")).toBe("\"c2\"");
    const retriedBody = JSON.parse(String(fetchImpl.mock.calls[3][1]?.body));
    expect(retriedBody.labelProperties.eventLabels).toContainEqual(
      { id: "unrelated-b", name: "B", backgroundColor: "#222222" },
    );
  });

});
