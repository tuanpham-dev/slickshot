import { useState } from "react";
import { Camera, ImageIcon, Settings as SettingsIcon } from "lucide-react";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { Segmented } from "../Segmented";
import { Field, Input } from "../Field";
import { Select } from "../Select";
import { Slider } from "../Slider";
import { ColorPicker } from "../ColorPicker";
import { EmptyState } from "../EmptyState";
import { Dialog, ConfirmDialog } from "../Dialog";
import { useToast } from "../Toast";
import { Kbd } from "../Kbd";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
        {title}
      </h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

export function Kit() {
  const [delay, setDelay] = useState<"off" | "3" | "5" | "10">("off");
  const [color, setColor] = useState("#2f80ed");
  const [slider, setSlider] = useState(40);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const toast = useToast();

  return (
      <div className="p-6 flex flex-col gap-8 max-w-2xl mx-auto overflow-y-auto h-full">
        <h1 className="text-lg font-semibold">Component Kit</h1>

        <Section title="Buttons">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" loading>
            Loading
          </Button>
          <Button variant="secondary" size="sm">
            Small
          </Button>
        </Section>

        <Section title="Icon buttons">
          <IconButton label="Capture region" shortcut="R" icon={<Camera size={16} />} />
          <IconButton label="Open image" shortcut="⌘O" icon={<ImageIcon size={16} />} />
          <IconButton label="Settings" icon={<SettingsIcon size={16} />} active />
        </Section>

        <Section title="Segmented + Select">
          <Segmented
            aria-label="Delay"
            value={delay}
            onChange={setDelay}
            options={[
              { value: "off", label: "Off" },
              { value: "3", label: "3s" },
              { value: "5", label: "5s" },
              { value: "10", label: "10s" },
            ]}
          />
          <Select
            aria-label="Format"
            value="png"
            onChange={() => {}}
            options={[
              { value: "png", label: "PNG" },
              { value: "jpg", label: "JPG" },
            ]}
          />
        </Section>

        <Section title="Field + Slider + Color">
          <Field label="Save folder" hint="~/Pictures/Screenshots">
            <Input placeholder="Choose a folder…" />
          </Field>
          <div className="w-40">
            <Slider aria-label="Stroke width" value={slider} min={1} max={100} onChange={setSlider} />
          </div>
          <ColorPicker value={color} onChange={setColor} />
        </Section>

        <Section title="Kbd">
          <Kbd>Enter</Kbd>
          <Kbd>Esc</Kbd>
          <Kbd>Ctrl+Shift+S</Kbd>
        </Section>

        <Section title="Toast + Dialog">
          <Button onClick={() => toast.show({ kind: "success", title: "Copied to clipboard" })}>
            Show success toast
          </Button>
          <Button
            onClick={() =>
              toast.show({
                kind: "error",
                title: "Save failed",
                description: "Permission denied",
              })
            }
          >
            Show error toast
          </Button>
          <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Open confirm
          </Button>
        </Section>

        <Section title="Empty state">
          <div className="border border-[var(--border)] rounded-[var(--radius-lg)] w-full">
            <EmptyState
              icon={<ImageIcon size={32} />}
              title="No screenshot yet"
              description="Capture the screen or open an existing image to start annotating."
              action={<Button variant="primary">Capture screen</Button>}
            />
          </div>
        </Section>

        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="Example dialog"
          description="This is a description of what the dialog does."
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialogOpen(false)}>
                Save
              </Button>
            </>
          }
        >
          <p className="text-sm text-[var(--fg)]">Dialog body content goes here.</p>
        </Dialog>

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Discard changes?"
          description="Unsaved annotations will be lost."
          confirmLabel="Discard"
          danger
          onConfirm={() => toast.show({ kind: "info", title: "Discarded" })}
        />
      </div>
  );
}
