import { describe, expect, it } from "vitest";
import { confirmRoute } from "./confirm";

describe("confirmRoute", () => {
  it("leaves an un-annotated capture on the original path", () => {
    for (const dest of ["default", "copy", "save"] as const) {
      for (const post of ["editor", "thumbnail", "none"] as const) {
        expect(confirmRoute(dest, post, false)).toBe("plain");
      }
    }
  });

  // The regression this exists for: Confirm with `post_capture: editor` used
  // to flatten, so the editor opened on pixels nothing could select.
  it("keeps annotations editable when Confirm is heading for the editor", () => {
    expect(confirmRoute("default", "editor", true)).toBe("editor");
  });

  it("flattens when the capture is not going to the editor", () => {
    expect(confirmRoute("default", "thumbnail", true)).toBe("flattened");
    expect(confirmRoute("default", "none", true)).toBe("flattened");
  });

  it("flattens for Copy and Save whatever post-capture says", () => {
    // Both name their own destination, and neither can carry a shape list.
    for (const post of ["editor", "thumbnail", "none"] as const) {
      expect(confirmRoute("copy", post, true)).toBe("flattened");
      expect(confirmRoute("save", post, true)).toBe("flattened");
    }
  });
});
