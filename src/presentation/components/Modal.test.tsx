// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(
      <Modal title="Record Buy" open={false} onClose={() => {}}>
        <p>content</p>
      </Modal>,
    );
    expect(screen.queryByText("Record Buy")).not.toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("renders the title and children when open", () => {
    render(
      <Modal title="Record Buy" open onClose={() => {}}>
        <p>content</p>
      </Modal>,
    );
    expect(screen.getByText("Record Buy")).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal title="Record Buy" open onClose={onClose}>
        <p>content</p>
      </Modal>,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
