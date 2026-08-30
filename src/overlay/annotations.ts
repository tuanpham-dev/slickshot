import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PhysRect } from "../lib/geometry";
import type { Shape } from "../editor/types";
import { moveShape } from "../editor/tools/select";

/** Shapes drawn on the overlay live in virtual-screen coordinates, matching
 * the selection rect they are drawn inside. Two translations get them where
 * they need to be, and both live here so the conversion never happens
 * ad hoc at a call site. */

/** Virtual-screen -> image space, for handing shapes to the editor: the
 * captured image's origin is the selection's top-left. */
export function rebaseToRegion(shapes: Shape[], region: PhysRect): Shape[] {
  return shapes.map((s) => moveShape(s, -region.x, -region.y));
}

/** Virtual-screen -> this monitor's canvas, for drawing. Each overlay window
 * covers one monitor and its canvas starts at that monitor's origin. */
export function shapesForMonitor(shapes: Shape[], monitor: PhysRect): Shape[] {
  return shapes.map((s) => moveShape(s, -monitor.x, -monitor.y));
}

/** Undo depth. Deep enough for a run of quick marks, shallow enough that a
 * long freehand session cannot grow without bound -- the editor is where a
 * full history belongs. */
const MAX_HISTORY = 30;

export interface Annotations {
  shapes: Shape[];
  draft: Shape | null;
  setDraft: Dispatch<SetStateAction<Shape | null>>;
  /** Commits a shape and pushes the previous list onto the undo stack. */
  commit: (shape: Shape) => Shape[];
  /** Replaces one shape in place -- editing a selected shape's style or
   * dragging it. Undoable as one step. */
  update: (shape: Shape) => Shape[];
  /** Drops one shape by id. */
  remove: (id: string) => Shape[];
  /** Replaces the committed list wholesale, without touching history --
   * for shapes arriving from another monitor's overlay window. */
  replace: (shapes: Shape[]) => void;
  undo: () => Shape[];
  redo: () => Shape[];
  clear: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useAnnotations(): Annotations {
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [history, setHistory] = useState<Shape[][]>([]);
  const [future, setFuture] = useState<Shape[][]>([]);

  // `commit` and `undo` return the resulting list so the caller can broadcast
  // it in the same handler; reading `shapes` there would still see the value
  // from the render that is being replaced. A ref keeps that return correct
  // without depending on when React evaluates a state updater.
  const live = useRef<Shape[]>(shapes);
  live.current = shapes;
  const past = useRef<Shape[][]>(history);
  past.current = history;
  const ahead = useRef<Shape[][]>(future);
  ahead.current = future;

  const apply = useCallback((next: Shape[]) => {
    live.current = next;
    setShapes(next);
    return next;
  }, []);

  const remember = useCallback((next: Shape[][]) => {
    past.current = next;
    setHistory(next);
  }, []);

  const lookAhead = useCallback((next: Shape[][]) => {
    ahead.current = next;
    setFuture(next);
  }, []);

  /** Pushes the current list onto the undo stack. Any redo branch is dropped:
   * a new edit after undoing makes the undone future unreachable, which is
   * what every editor does. */
  const step = useCallback(() => {
    remember([...past.current, live.current].slice(-MAX_HISTORY));
    lookAhead([]);
  }, [lookAhead, remember]);

  const commit = useCallback(
    (shape: Shape) => {
      step();
      setDraft(null);
      return apply([...live.current, shape]);
    },
    [apply, step],
  );

  const update = useCallback(
    (shape: Shape) => {
      step();
      return apply(live.current.map((s) => (s.id === shape.id ? shape : s)));
    },
    [apply, step],
  );

  const remove = useCallback(
    (id: string) => {
      step();
      return apply(live.current.filter((s) => s.id !== id));
    },
    [apply, step],
  );

  // Broadcast arrivals are not undoable by this window: the shape belongs to
  // whichever overlay drew it, and that window holds the step that made it.
  const replace = useCallback(
    (incoming: Shape[]) => {
      apply(incoming);
    },
    [apply],
  );

  const undo = useCallback(() => {
    const h = past.current;
    if (h.length === 0) return live.current;
    lookAhead([...ahead.current, live.current].slice(-MAX_HISTORY));
    remember(h.slice(0, -1));
    return apply(h[h.length - 1]);
  }, [apply, lookAhead, remember]);

  const redo = useCallback(() => {
    const f = ahead.current;
    if (f.length === 0) return live.current;
    remember([...past.current, live.current].slice(-MAX_HISTORY));
    lookAhead(f.slice(0, -1));
    return apply(f[f.length - 1]);
  }, [apply, lookAhead, remember]);

  const clear = useCallback(() => {
    apply([]);
    setDraft(null);
    remember([]);
    lookAhead([]);
  }, [apply, lookAhead, remember]);

  return {
    shapes,
    draft,
    setDraft,
    commit,
    update,
    remove,
    replace,
    undo,
    redo,
    clear,
    canUndo: history.length > 0,
    canRedo: future.length > 0,
  };
}
