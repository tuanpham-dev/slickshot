import type { ImgPoint, StampShape, Style } from "../types";

/** Curated emoji set for the stamp picker, grouped the way someone
 * annotating a screenshot would look for them (verdicts and pointers first,
 * decoration last) rather than by Unicode block. */
export const EMOJI_CATEGORIES: { name: string; emoji: string[] }[] = [
  {
    name: "Verdict",
    emoji: ["✅", "❌", "⚠️", "❓", "❗", "🚫", "✔️", "✖️", "💯", "🆗", "🆕", "🔒"],
  },
  {
    name: "Pointers",
    emoji: ["👉", "👈", "👆", "👇", "☝️", "🫵", "🔍", "🔎", "📌", "📍", "🎯", "⭐"],
  },
  {
    name: "Reactions",
    emoji: ["👍", "👎", "👏", "🙌", "🤔", "😀", "😅", "😍", "😐", "😕", "😬", "🤯"],
  },
  {
    name: "Status",
    emoji: ["🔥", "💥", "🐛", "🚧", "⏳", "⌛", "🔄", "🔔", "💤", "🧪", "🩹", "🧹"],
  },
  {
    name: "Symbols",
    emoji: ["❤️", "💔", "💡", "📝", "📎", "🔗", "💬", "🗯️", "📢", "🏁", "🥇", "🏆"],
  },
  {
    name: "Objects",
    emoji: ["💻", "🖥️", "📱", "⌨️", "🖱️", "🗂️", "📦", "🔧", "⚙️", "🔑", "📊", "📈"],
  },
];

const RECENT_KEY = "slickshot:recentStamps";
const MAX_RECENT = 10;

export function loadRecentStamps(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // Corrupt or unavailable storage is not worth failing the tool over.
    return [];
  }
}

/** Most-recent-first, deduplicated, capped. */
export function pushRecentStamp(emoji: string): string[] {
  const next = [emoji, ...loadRecentStamps().filter((e) => e !== emoji)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: the stamp still gets placed, it just isn't remembered.
  }
  return next;
}

/** Stamps are placed by a click, centered on the pointer, sized from the
 * marker slider so the two "badge" tools stay visually consistent. */
export function createStamp(id: string, point: ImgPoint, style: Style): StampShape {
  return {
    id,
    kind: "stamp",
    x: point.x,
    y: point.y,
    size: Math.max(12, style.markerSize * 4),
    emoji: style.stampEmoji,
  };
}
