// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatTile } from "./StatTile";

describe("StatTile", () => {
  it("renders the label and value", () => {
    render(<StatTile label="Total Cash" value="1,000 EGP" />);
    expect(screen.getByText("Total Cash")).toBeInTheDocument();
    expect(screen.getByText("1,000 EGP")).toBeInTheDocument();
  });

  it("renders a sublabel and icon only when provided", () => {
    const { rerender } = render(<StatTile label="Return" value="5%" />);
    expect(screen.queryByText("since inception")).not.toBeInTheDocument();

    rerender(<StatTile label="Return" value="5%" sublabel="since inception" icon={<span data-testid="icon" />} />);
    expect(screen.getByText("since inception")).toBeInTheDocument();
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("applies a custom value className (e.g. for sign coloring)", () => {
    render(<StatTile label="P/L" value="-50" valueClassName="text-rose-400" />);
    expect(screen.getByText("-50")).toHaveClass("text-rose-400");
  });
});
