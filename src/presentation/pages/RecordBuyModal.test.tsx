// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecordBuyModal } from "./TradesPage";

describe("RecordBuyModal — sector auto-suggestion", () => {
  it("suggests a sector for a known ticker while the field is still blank", async () => {
    const user = userEvent.setup();
    render(<RecordBuyModal portfolioId="p1" open onClose={() => {}} />);

    await user.type(screen.getByLabelText("Ticker"), "COMI");
    expect(screen.getByLabelText("Sector (optional)")).toHaveValue("Banking");
  });

  it("leaves the sector blank for a ticker outside the known-sector map", async () => {
    const user = userEvent.setup();
    render(<RecordBuyModal portfolioId="p1" open onClose={() => {}} />);

    await user.type(screen.getByLabelText("Ticker"), "ZZZZ");
    expect(screen.getByLabelText("Sector (optional)")).toHaveValue("");
  });

  it("never overwrites a sector the user already typed themselves", async () => {
    const user = userEvent.setup();
    render(<RecordBuyModal portfolioId="p1" open onClose={() => {}} />);

    const sectorInput = screen.getByLabelText("Sector (optional)");
    await user.type(sectorInput, "Custom Sector");
    await user.type(screen.getByLabelText("Ticker"), "COMI");

    expect(sectorInput).toHaveValue("Custom Sector");
  });
});
