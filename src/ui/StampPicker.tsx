import { EMOJI_CATEGORIES, loadRecentStamps } from "../editor/tools/stamp";

/** Recents row plus the categorised grid. Recents are read once per mount:
 * both callers remount this whenever the stamp tool is re-opened, which is
 * the only moment the list could have grown since it was last shown.
 *
 * Shared by the editor's properties panel and the capture overlay's settings
 * dropdown so the same tool does not offer a different set of emoji
 * depending on which window you reach for it from. */
export function StampPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (emoji: string) => void;
}) {
  const recents = loadRecentStamps();
  const groups =
    recents.length > 0 ? [{ name: "Recent", emoji: recents }, ...EMOJI_CATEGORIES] : EMOJI_CATEGORIES;
  // Recents duplicate emoji that also live in a category, so the selected one
  // would light up in both places -- one choice reading as two. Only the first
  // group holding it is marked: Recent when it is there, otherwise its
  // category.
  const selectedGroup = groups.findIndex((group) => group.emoji.includes(value));
  return (
    <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
      {groups.map((group, groupIndex) => (
        <div key={group.name} className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
            {group.name}
          </span>
          <div className="grid grid-cols-6 gap-0.5">
            {group.emoji.map((emoji) => {
              const selected = value === emoji && groupIndex === selectedGroup;
              return (
              <button
                key={`${group.name}-${emoji}`}
                type="button"
                aria-label={`Stamp ${emoji}`}
                aria-pressed={selected}
                onClick={() => onChange(emoji)}
                className={`flex items-center justify-center h-7 text-base rounded-[var(--radius-sm)] ${
                  selected
                    ? "bg-[var(--accent)]/20 ring-1 ring-[var(--accent)]"
                    : "hover:bg-[var(--surface-hover)]"
                }`}
              >
                {emoji}
              </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
