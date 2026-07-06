// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PriceFreshness } from "./PriceFreshness";

const getSnapshotInfo = vi.fn();

vi.mock("@presentation/lib/data", () => ({
  repos: {
    prices: {
      get getSnapshotInfo() {
        return getSnapshotInfo;
      },
    },
  },
}));

afterEach(() => {
  vi.useRealTimers();
  getSnapshotInfo.mockReset();
});

describe("PriceFreshness", () => {
  it("shows which market close the current prices represent, preferring the quote time over the pipeline run time", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-04T18:00:00.000Z"), shouldAdvanceTime: true });
    getSnapshotInfo.mockResolvedValue({ asOf: "2026-07-04T13:05:00.000Z", latestQuoteAt: "2026-07-04T12:30:00.000Z" });
    render(<PriceFreshness />);
    expect(await screen.findByText(/Prices as of .*(last market close)/)).toBeInTheDocument();
  });

  it("always shows EGX's actual 14:30 Cairo close time, ignoring the raw (unreliable) provider hour", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-04T18:00:00.000Z"), shouldAdvanceTime: true });
    // Upstream quote time is 07:00 UTC (a provider session marker, not the real close).
    getSnapshotInfo.mockResolvedValue({ asOf: "2026-07-04T13:05:00.000Z", latestQuoteAt: "2026-07-04T07:00:00.000Z" });
    render(<PriceFreshness />);
    expect(await screen.findByText(/14:30/)).toBeInTheDocument();
  });

  it("escalates to an explicit outdated warning when the snapshot is older than the EGX's longest normal quiet stretch", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-10T18:00:00.000Z"), shouldAdvanceTime: true });
    getSnapshotInfo.mockResolvedValue({ asOf: "2026-07-04T13:05:00.000Z", latestQuoteAt: "2026-07-04T12:30:00.000Z" });
    render(<PriceFreshness />);
    expect(await screen.findByText(/the feed hasn't updated since/)).toBeInTheDocument();
  });

  it("warns that values fall back to cost basis when no usable snapshot exists at all", async () => {
    getSnapshotInfo.mockResolvedValue(null);
    render(<PriceFreshness />);
    expect(await screen.findByText(/No market prices loaded yet/)).toBeInTheDocument();
  });
});
