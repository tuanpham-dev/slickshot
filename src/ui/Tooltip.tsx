import { Tooltip as RadixTooltip } from "radix-ui";
import type { ReactNode } from "react";
import { Kbd } from "./Kbd";

interface TooltipProps {
  label: string;
  shortcut?: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /** Forces the tooltip closed. For triggers that open something of their
   * own (a menu, a popover), where the tooltip would otherwise sit on top
   * of the thing the click just opened. */
  suppressed?: boolean;
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={400}>{children}</RadixTooltip.Provider>;
}

export function Tooltip({ label, shortcut, children, side = "top", suppressed }: TooltipProps) {
  return (
    <RadixTooltip.Root open={suppressed ? false : undefined}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--fg)] text-[var(--bg)] px-2 py-1 text-xs shadow-[var(--shadow-md)] data-[state=delayed-open]:animate-[fadeIn_var(--duration-fast)_var(--ease-out)]"
        >
          <span>{label}</span>
          {shortcut && <Kbd inverted>{shortcut}</Kbd>}
          <RadixTooltip.Arrow className="fill-[var(--fg)]" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
