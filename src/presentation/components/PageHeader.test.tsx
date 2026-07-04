// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("renders the title, description, and actions", () => {
    render(<PageHeader title="Portfolios" description="Every book you track." actions={<button>New</button>} />);
    expect(screen.getByRole("heading", { name: "Portfolios" })).toBeInTheDocument();
    expect(screen.getByText("Every book you track.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("renders without a description or actions", () => {
    render(<PageHeader title="Data" />);
    expect(screen.getByRole("heading", { name: "Data" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
