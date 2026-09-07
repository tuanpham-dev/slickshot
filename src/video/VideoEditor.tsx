import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Segmented";
import { useToast } from "../ui/Toast";
import {
  frontendMounted,
  onVideoEditorOpen,
  videoDiscard,
  videoProbe,
  videoReveal,
  videoUrl,
  type VideoInfo,
} from "../lib/ipc";
import { Timeline } from "./Timeline";
import { clampTrim, formatTimecode, outputDuration, type Trim } from "./trim";

const SPEEDS = [
  { value: "0.5", label: "0.5x" },
  { value: "1", label: "1x" },
  { value: "1.5", label: "1.5x" },
  { value: "2", label: "2x" },
  { value: "4", label: "4x" },
];

interface VideoEditorProps {
  params: URLSearchParams;
}

/** Trim, speed and export for a finished recording.
 *
 * The clip streams over `slickshot-video://` rather than being loaded whole:
 * a few minutes of screen at 30fps is far too big to hold in the webview, and
 * seeking needs range requests anyway. */
export function VideoEditor({ params }: VideoEditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const toast = useToast();

  // The id also arrives by event, for a window being reused by a second
  // recording -- the hash param only covers a freshly built one.
  const [videoId, setVideoId] = useState<string | null>(params.get("video"));
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [trim, setTrim] = useState<Trim>({ start: 0, end: 0 });
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("1");

  useEffect(() => {
    const unlisten = onVideoEditorOpen((id) => setVideoId(id));
    frontendMounted();
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!videoId) return;
    videoProbe(videoId)
      .then((probed) => {
        setInfo(probed);
        setTrim({ start: 0, end: probed.duration_ms });
        setCurrent(0);
      })
      .catch((err) =>
        toast.show({
          kind: "error",
          title: "Couldn't read that recording",
          description: String(err),
        }),
      );
  }, [videoId, toast]);

  // Playback stops at the trim's end rather than running to the end of the
  // file: the trimmed range is what the user is working on, so previewing
  // past it is just confusing.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const ms = video.currentTime * 1000;
      if (ms >= trim.end) {
        video.pause();
        video.currentTime = trim.start / 1000;
        setCurrent(trim.start);
        setPlaying(false);
        return;
      }
      setCurrent(ms);
    };
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [trim]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = Number(speed);
  }, [speed, videoId]);

  const seek = useCallback((ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = ms / 1000;
    setCurrent(ms);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // Restart from the trim's start once it has run to the end, rather
      // than refusing to play from a playhead sitting on the out point.
      if (video.currentTime * 1000 >= trim.end - 10) video.currentTime = trim.start / 1000;
      video.play().catch(() => {});
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  }, [trim]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay]);

  async function handleDiscard() {
    if (!videoId) return;
    try {
      await videoDiscard(videoId);
      const w = (await import("@tauri-apps/api/window")).getCurrentWindow();
      await w.close();
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't discard", description: String(err) });
    }
  }

  async function handleReveal() {
    if (!videoId) return;
    try {
      await videoReveal(videoId);
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't show the file", description: String(err) });
    }
  }

  if (!videoId || !info) {
    return (
      <div className="flex items-center justify-center h-screen text-sm text-[var(--fg-muted)]">
        Loading the recording…
      </div>
    );
  }

  const outMs = outputDuration(trim, Number(speed));

  return (
    <div className="flex flex-col h-screen bg-[var(--bg)] text-[var(--fg)]">
      <div className="flex items-center gap-3 px-3 h-12 border-b border-[var(--border)] bg-[var(--surface)]">
        <span className="text-xs text-[var(--fg-muted)]">Speed</span>
        <Segmented
          options={SPEEDS}
          value={speed}
          onChange={setSpeed}
          aria-label="Playback speed"
        />
        {info.has_audio && Number(speed) !== 1 && (
          <span className="text-[11px] text-[var(--fg-muted)]">
            Audio follows the speed change.
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center bg-black/30 p-4">
        <video
          ref={videoRef}
          src={videoUrl(videoId)}
          className="max-w-full max-h-full"
          preload="auto"
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={(e) => {
            const video = e.currentTarget;
            // The probe is authoritative for duration -- a fragmented MP4 can
            // report Infinity here until it has buffered.
            if (!Number.isFinite(video.duration) && info) {
              setTrim((t) => clampTrim(t, info.duration_ms));
            }
          }}
        />
      </div>

      <Timeline
        duration={info.duration_ms}
        current={current}
        trim={trim}
        playing={playing}
        onTrimChange={setTrim}
        onSeek={seek}
        onTogglePlay={togglePlay}
      />

      <div className="flex items-center justify-between gap-3 px-3 h-12 border-t border-[var(--border)] bg-[var(--surface)]">
        <span className="text-[11px] font-mono text-[var(--fg-muted)] tabular-nums">
          {info.width} × {info.height} · {formatTimecode(outMs)}
          {info.has_audio ? " · audio" : ""}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<FolderOpen size={14} />}
            onClick={handleReveal}
          >
            Show in folder
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Trash2 size={14} />}
            onClick={handleDiscard}
          >
            Discard
          </Button>
        </div>
      </div>
    </div>
  );
}
