import { useCallback, useEffect, useRef, useState } from "react";
import { Segmented } from "../ui/Segmented";
import { Canvas } from "../editor/Canvas";
import { useEditorStore } from "../editor/store";
import { flattenToPng } from "../editor/export";
import { VideoToolbar } from "./VideoToolbar";
import { extractCensors, shapesForOverlay } from "./videoTools";
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
import { VideoExportBar } from "./VideoExportBar";
import { clampTrim, formatTimecode, outputDuration, type Trim } from "./trim";

const FORMATS = [
  { value: "mp4", label: "MP4" },
  { value: "gif", label: "GIF" },
];

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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // State, not just a ref: the <video> is rendered *inside* Canvas, which only
  // mounts once there is a base image, so every effect that wants to attach a
  // listener runs before the element exists. Re-running them when it appears
  // is the whole point -- without this the frame grabs never armed, the base
  // canvas stayed a 1x1 stand-in, and censors previewed as flat blocks.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideoEl(el);
  }, []);
  const toast = useToast();

  // The id also arrives by event, for a window being reused by a second
  // recording -- the hash param only covers a freshly built one.
  const [videoId, setVideoId] = useState<string | null>(params.get("video"));
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [trim, setTrim] = useState<Trim>({ start: 0, end: 0 });
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("1");
  const [format, setFormat] = useState<"mp4" | "gif">("mp4");
  const [baseImage, setBaseImage] = useState<ImageBitmap | null>(null);

  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const shapes = useEditorStore((s) => s.shapes);
  const cropRect = useEditorStore((s) => s.cropRect);
  const setCropRect = useEditorStore((s) => s.setCropRect);
  const resize = useEditorStore((s) => s.resize);
  const setImage = useEditorStore((s) => s.setImage);
  const setZoom = useEditorStore((s) => s.setZoom);
  const canvasAreaRef = useRef<HTMLDivElement>(null);

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
        // The store drives the annotation canvas's coordinate space, so it
        // has to be the *clip's* size, not the element's on-screen size.
        setImage(videoId, probed.width, probed.height);
        // A crop left over from the previous clip would silently apply to
        // this one -- the window is reused for a second recording.
        setCropRect(null);
        // A 1x1 stand-in until the first frame is grabbed; Canvas needs a
        // bitmap to exist before the video has decoded anything.
        createImageBitmap(new ImageData(1, 1)).then(setBaseImage).catch(() => {});
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
  }, [trim, videoEl]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = Number(speed);
  }, [speed, videoId, videoEl]);

  // The base canvas under the annotations holds the frame currently shown.
  // It stays hidden (the live <video> shows through) but has to exist and be
  // the right size, because the flatten step measures the overlay from it.
  const grabFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    try {
      setBaseImage(await createImageBitmap(video));
    } catch {
      // A frame that isn't decoded yet simply isn't grabbed; the next
      // seek or pause tries again.
    }
  }, []);

  // A recording is its display's full pixel size, which is larger than the
  // editor window on any Retina screen -- without this the clip opens at 1:1
  // and overflows, and the first thing anyone has to do is scroll.
  useEffect(() => {
    if (!info) return;
    const container = canvasAreaRef.current;
    if (!container) return;
    const fit = () =>
      setZoom(
        Math.max(
          0.05,
          Math.min(
            (container.clientWidth - 48) / info.width,
            (container.clientHeight - 48) / info.height,
            1,
          ),
        ),
      );
    fit();
    // The window is built hidden and shown once the clip is ready, so this
    // can run before layout has settled; re-fit once it has.
    const ro = new ResizeObserver(() => {
      fit();
      ro.disconnect();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [info, setZoom]);

  // Refreshed whenever the picture settles, not per frame: this decodes a
  // whole bitmap, and doing it 30 times a second would compete with playback.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onSettled = () => {
      void grabFrame();
    };
    video.addEventListener("seeked", onSettled);
    video.addEventListener("pause", onSettled);
    video.addEventListener("loadeddata", onSettled);
    return () => {
      video.removeEventListener("seeked", onSettled);
      video.removeEventListener("pause", onSettled);
      video.removeEventListener("loadeddata", onSettled);
    };
  }, [grabFrame, videoId, videoEl]);

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
  }, [trim, videoEl]);

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

  // The crop decides the export's natural size; an explicit Resize overrides
  // it. Both are even-rounded because H.264 refuses odd dimensions.
  const even = (n: number) => Math.max(2, Math.round(n) - (Math.round(n) % 2));
  const cropped = cropRect
    ? { w: cropRect.w, h: cropRect.h }
    : { w: info.width, h: info.height };
  const outputSize: [number, number] = resize
    ? [even(resize.w), even(resize.h)]
    : [even(cropped.w), even(cropped.h)];

  /** Flattens the annotations alone, at the clip's full size. The backend
   * crops it in step with each frame, so it must not be cropped here. */
  async function buildOverlay(): Promise<Uint8Array> {
    const drawn = shapesForOverlay(shapes);
    if (drawn.length === 0) return new Uint8Array(0);
    const canvas = document.createElement("canvas");
    canvas.width = info!.width;
    canvas.height = info!.height;
    return flattenToPng(canvas, drawn, { transparent: true });
  }

  return (
    <div className="flex flex-col h-screen bg-[var(--bg)] text-[var(--fg)]">
      <div className="flex items-center gap-3 px-3 h-12 border-b border-[var(--border)] bg-[var(--surface)]">
        <VideoToolbar tool={tool} onToolChange={setTool} />
        <div className="w-px h-5 bg-[var(--border)]" />
        <span className="text-xs text-[var(--fg-muted)]">Speed</span>
        <Segmented
          options={SPEEDS}
          value={speed}
          onChange={setSpeed}
          aria-label="Playback speed"
        />
        <div className="w-px h-5 bg-[var(--border)]" />
        <Segmented
          options={FORMATS}
          value={format}
          onChange={(v) => setFormat(v as "mp4" | "gif")}
          aria-label="Export format"
        />
        {info.has_audio && format === "gif" && (
          <span className="text-[11px] text-[var(--fg-muted)]">GIFs have no sound.</span>
        )}
      </div>

      <div ref={canvasAreaRef} className="flex-1 min-h-0 overflow-auto flex bg-black/30 p-4">
        {baseImage && (
          <Canvas
            baseImage={baseImage}
            hideBase
            onConfirmCrop={() => {
              // Unlike the image editor, the crop is not baked here: doing so
              // would mean re-encoding the whole clip just to preview it. It
              // stays as the export's crop and the tool hands back to select.
              setTool("select");
            }}
            underlay={
              <video
                ref={attachVideo}
                src={videoUrl(videoId)}
                className="w-full h-full"
                preload="auto"
                onEnded={() => setPlaying(false)}
                onLoadedMetadata={(e) => {
                  const video = e.currentTarget;
                  // The probe is authoritative for duration -- a fragmented
                  // MP4 can report Infinity here until it has buffered.
                  if (!Number.isFinite(video.duration) && info) {
                    setTrim((t) => clampTrim(t, info.duration_ms));
                  }
                }}
              />
            }
          />
        )}
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

      <div className="flex items-center gap-3 px-3 h-8 border-t border-[var(--border)] bg-[var(--surface)]">
        <span className="text-[11px] font-mono text-[var(--fg-muted)] tabular-nums">
          {info.width} × {info.height} · {formatTimecode(outMs)}
          {info.has_audio ? " · audio" : ""}
        </span>
      </div>

      <VideoExportBar
        request={{
          id: videoId,
          range: { start_ms: Math.round(trim.start), end_ms: Math.round(trim.end) },
          speed: Number(speed),
          crop: cropRect,
          output_size: outputSize,
          format,
          // A GIF has no audio track to keep.
          keep_audio: info.has_audio && format === "mp4",
          censors: extractCensors(shapes),
        }}
        buildOverlay={buildOverlay}
        onDiscard={handleDiscard}
        onReveal={handleReveal}
      />
    </div>
  );
}
