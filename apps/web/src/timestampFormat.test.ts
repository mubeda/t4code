import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatElapsedDurationLabel,
  formatExpiresInLabel,
  formatRelativeTime,
  formatRelativeTimeLabel,
  formatRelativeTimeUntilLabel,
  formatChatTimestampTooltip,
  formatShortTimestamp,
  formatTimestamp,
  getTimestampFormatOptions,
} from "./timestampFormat";

describe("getTimestampFormatOptions", () => {
  it("omits hour12 when locale formatting is requested", () => {
    expect(getTimestampFormatOptions("locale", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  });

  it("builds a 12-hour formatter with seconds when requested", () => {
    expect(getTimestampFormatOptions("12-hour", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  });

  it("builds a 24-hour formatter without seconds when requested", () => {
    expect(getTimestampFormatOptions("24-hour", false)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  });
});

describe("formatRelativeTimeUntilLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Expired when the instant is in the past", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T11:59:00.000Z")).toBe("Expired");
  });

  it("formats seconds remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T12:00:45.000Z")).toBe("45s left");
  });

  it("formats minutes remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T12:15:00.000Z")).toBe("15m left");
  });

  it("formats hours remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T18:00:00.000Z")).toBe("6h left");
  });
});

describe("formatExpiresInLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Expired when the instant is in the past", () => {
    expect(formatExpiresInLabel("2026-04-07T11:59:00.000Z")).toBe("Expired");
    expect(formatExpiresInLabel("2026-04-07T12:00:03.000Z")).toBe("Expires in a moment");
  });

  it("uses sub-minute second count", () => {
    expect(formatExpiresInLabel("2026-04-07T12:00:45.000Z")).toBe("Expires in 45s");
  });

  it("uses minutes and seconds under one hour", () => {
    expect(formatExpiresInLabel("2026-04-07T12:04:12.000Z")).toBe("Expires in 4m 12s");
    expect(formatExpiresInLabel("2026-04-07T12:15:00.000Z")).toBe("Expires in 15m");
  });

  it("uses hours with minute and second remainder", () => {
    expect(formatExpiresInLabel("2026-04-07T14:02:03.000Z")).toBe("Expires in 2h 2m 3s");
    expect(formatExpiresInLabel("2026-04-07T18:00:00.000Z")).toBe("Expires in 6h");
  });

  it("uses days with optional remainder parts", () => {
    expect(formatExpiresInLabel("2026-04-09T12:00:00.000Z")).toBe("Expires in 2d");
    expect(formatExpiresInLabel("2026-04-09T15:04:05.000Z")).toBe("Expires in 2d 3h 4m 5s");
    expect(formatExpiresInLabel("2026-04-09T12:04:00.000Z")).toBe("Expires in 2d 4m");
    expect(formatExpiresInLabel("2026-04-09T12:00:05.000Z")).toBe("Expires in 2d 5s");
  });
});

describe("formatElapsedDurationLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns just now when the instant is current or in the future", () => {
    expect(formatElapsedDurationLabel("2026-04-07T12:00:00.000Z")).toBe("just now");
    expect(formatElapsedDurationLabel("2026-04-07T12:01:00.000Z")).toBe("just now");
  });

  it("formats seconds, minutes, hours, and days", () => {
    expect(formatElapsedDurationLabel("2026-04-07T11:59:45.000Z")).toBe("15s");
    expect(formatElapsedDurationLabel("2026-04-07T11:45:00.000Z")).toBe("15m");
    expect(formatElapsedDurationLabel("2026-04-07T06:00:00.000Z")).toBe("6h");
    expect(formatElapsedDurationLabel("2026-04-03T12:00:00.000Z")).toBe("4d");
  });
});

describe("timestamp display", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats absolute timestamps and caches formatters", () => {
    const isoDate = "2026-04-07T10:04:05.000Z";
    expect(formatTimestamp(isoDate, "24-hour")).toBe(formatTimestamp(isoDate, "24-hour"));
    expect(formatShortTimestamp(isoDate, "12-hour")).not.toBe("");
  });

  it("formats ordinal tooltip dates and rejects invalid dates", () => {
    expect(formatChatTimestampTooltip("invalid", "24-hour")).toBe("");
    expect(formatChatTimestampTooltip("2026-01-01T10:00:00.000Z", "24-hour")).toContain(
      "1st January 2026",
    );
    expect(formatChatTimestampTooltip("2026-01-02T10:00:00.000Z", "24-hour")).toContain(
      "2nd January 2026",
    );
    expect(formatChatTimestampTooltip("2026-01-03T10:00:00.000Z", "24-hour")).toContain(
      "3rd January 2026",
    );
    expect(formatChatTimestampTooltip("2026-01-04T10:00:00.000Z", "24-hour")).toContain(
      "4th January 2026",
    );
    expect(formatChatTimestampTooltip("2026-01-11T10:00:00.000Z", "24-hour")).toContain(
      "11th January 2026",
    );
    expect(formatChatTimestampTooltip("2026-01-12T10:00:00.000Z", "24-hour")).toContain(
      "12th January 2026",
    );
    expect(formatChatTimestampTooltip("2026-01-13T10:00:00.000Z", "24-hour")).toContain(
      "13th January 2026",
    );
    expect(formatChatTimestampTooltip("2026-01-21T10:00:00.000Z", "24-hour")).toContain(
      "21st January 2026",
    );
  });

  it("formats relative past and future boundaries", () => {
    expect(formatRelativeTime("2026-04-07T12:01:00.000Z")).toEqual({
      value: "just now",
      suffix: null,
    });
    expect(formatRelativeTime("2026-04-07T11:59:30.000Z")).toEqual({
      value: "just now",
      suffix: null,
    });
    expect(formatRelativeTimeLabel("2026-04-07T11:45:00.000Z")).toBe("15m ago");
    expect(formatRelativeTimeLabel("2026-04-07T06:00:00.000Z")).toBe("6h ago");
    expect(formatRelativeTimeLabel("2026-04-03T12:00:00.000Z")).toBe("4d ago");
    expect(formatRelativeTimeUntilLabel("2026-04-07T12:00:03.000Z")).toBe("Soon");
    expect(formatRelativeTimeUntilLabel("2026-04-09T12:00:00.000Z")).toBe("2d left");
  });
});
