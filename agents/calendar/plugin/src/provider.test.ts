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
        items: [{ id: "a", summary: "A" }],
        nextPageToken: "next",
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{ id: "b", summary: "B" }],
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

  it("rejects labels outside the effective analytical configuration before writing", async () => {
    const fetchImpl = vi.fn();
    const provider = createGoogleCalendarProvider({
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await expect(provider.setLabel(VALID_CONFIG, {
      event_id: "event-1",
      label_id: "not-configured",
    })).rejects.toThrow(/not part of the effective analytical configuration/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
