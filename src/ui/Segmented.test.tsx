import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented";

afterEach(cleanup);

const OPTIONS = [
  { value: "off", label: "Off" },
  { value: "3s", label: "3s" },
  { value: "5s", label: "5s" },
  { value: "10s", label: "10s" },
] as const;

function renderSegmented(value: (typeof OPTIONS)[number]["value"], onChange = vi.fn()) {
  render(<Segmented aria-label="Capture delay" value={value} onChange={onChange} options={[...OPTIONS]} />);
  return { onChange };
}

describe("Segmented keyboard navigation (WAI-ARIA radiogroup pattern)", () => {
  it("gives only the selected option tabIndex 0 -- the rest are -1 (roving tabindex, one Tab stop for the group)", () => {
    renderSegmented("5s");
    for (const opt of OPTIONS) {
      const btn = screen.getByRole("radio", { name: opt.label });
      expect(btn.tabIndex).toBe(opt.value === "5s" ? 0 : -1);
    }
  });

  it("moves the tab stop to the newly selected option when `value` changes", () => {
    const { rerender } = render(
      <Segmented aria-label="Capture delay" value="off" onChange={() => {}} options={[...OPTIONS]} />,
    );
    expect(screen.getByRole("radio", { name: "Off" }).tabIndex).toBe(0);
    rerender(<Segmented aria-label="Capture delay" value="10s" onChange={() => {}} options={[...OPTIONS]} />);
    expect(screen.getByRole("radio", { name: "10s" }).tabIndex).toBe(0);
    expect(screen.getByRole("radio", { name: "Off" }).tabIndex).toBe(-1);
  });

  it("falls back to the first option as the tab stop when `value` matches none of the options", () => {
    // @ts-expect-error -- deliberately an out-of-range value to exercise the fallback
    renderSegmented("does-not-exist");
    expect(screen.getByRole("radio", { name: "Off" }).tabIndex).toBe(0);
  });

  it("ArrowRight moves focus to and selects the next option", () => {
    const { onChange } = renderSegmented("off");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Off" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("3s");
  });

  it("ArrowLeft moves focus to and selects the previous option", () => {
    const { onChange } = renderSegmented("5s");
    fireEvent.keyDown(screen.getByRole("radio", { name: "5s" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("3s");
  });

  it("ArrowRight wraps from the last option to the first", () => {
    const { onChange } = renderSegmented("10s");
    fireEvent.keyDown(screen.getByRole("radio", { name: "10s" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("off");
  });

  it("ArrowLeft wraps from the first option to the last", () => {
    const { onChange } = renderSegmented("off");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Off" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("10s");
  });

  it("ArrowDown/ArrowUp behave the same as ArrowRight/ArrowLeft", () => {
    const { onChange } = renderSegmented("off");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Off" }), { key: "ArrowDown" });
    expect(onChange).toHaveBeenCalledWith("3s");
  });

  it("Home selects the first option from anywhere in the group", () => {
    const { onChange } = renderSegmented("10s");
    fireEvent.keyDown(screen.getByRole("radio", { name: "10s" }), { key: "Home" });
    expect(onChange).toHaveBeenCalledWith("off");
  });

  it("End selects the last option from anywhere in the group", () => {
    const { onChange } = renderSegmented("off");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Off" }), { key: "End" });
    expect(onChange).toHaveBeenCalledWith("10s");
  });

  it("moves DOM focus to the newly active option, not just calling onChange (roving tabindex requires an actual focus move)", () => {
    renderSegmented("off");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Off" }), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "3s" }));
  });

  it("a plain click still selects an option directly, without requiring focus first", () => {
    const { onChange } = renderSegmented("off");
    fireEvent.click(screen.getByRole("radio", { name: "5s" }));
    expect(onChange).toHaveBeenCalledWith("5s");
  });

  it("ignores unrelated keys (e.g. Tab, a letter) without calling onChange", () => {
    const { onChange } = renderSegmented("off");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Off" }), { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still marks exactly the selected option aria-checked=true", () => {
    renderSegmented("5s");
    expect(screen.getByRole("radio", { name: "5s" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Off" }).getAttribute("aria-checked")).toBe("false");
  });

  it("renders a single radiogroup with the given aria-label", () => {
    renderSegmented("off");
    expect(screen.getByRole("radiogroup", { name: "Capture delay" })).toBeTruthy();
  });
});
