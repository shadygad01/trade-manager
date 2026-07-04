// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders the title and, when given, the description and action", () => {
    render(
      <EmptyState
        title="No portfolios yet"
        description="Create one to get started."
        action={<button>Create</button>}
      />,
    );
    expect(screen.getByText("No portfolios yet")).toBeInTheDocument();
    expect(screen.getByText("Create one to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("omits the description and action when not provided", () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
