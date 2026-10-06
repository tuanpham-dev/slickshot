import { useCallback, useEffect, useRef, useState } from "react";
import { Segmented } from "../ui/Segmented";
import { Canvas } from "../editor/Canvas";
import { useEditorStore } from "../editor/store";
import { flattenToPng } from "../editor/export";
import { VideoToolbar } from "./VideoToolbar";
import { EffectLanes } from "./EffectLanes";
import { buildPlan, isCut, zoomAt, type VideoEffect } from "./timelinePlan";
import {
  extractCensors,
  overlaySegments,
  packOverlays,
  visibleAt,
} from "./videoTools";
import { useToast } from "../ui/Toast";
import {
  frontendMounted,
  onVideoEditorOpen,
  videoDiscard,
  videoProbe,
  videoReveal,
  isLinux,
  isMac,
  videoThumbnails,
  playableVideoUrl,
  videoFrame,
  type VideoInfo,
} from "../lib/ipc";
import { Timeline } from "./Timeline";
import { VideoExportBar } from "./VideoExportBar";
import { clampTrim, formatTimecode, type Trim } from "./trim";

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
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [trim, setTrim] = useState<Trim>({ start: 0, end: 0 });
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("1");
  const [format, setFormat] = useState<"mp4" | "gif">("mp4");
  const [effects, setEffects] = useState<VideoEffect[]>([]);
  const [selectedEffect, setSelectedEffect] = useState<string | null>(null);
  const [strip, setStrip] = useState<string[]>([]);
  const [baseImage, setBaseImage] = useState<ImageBitmap | null>(null);

  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const shapes = useEditorStore((s) => s.shapes);
  const cropRect = useEditorStore((s) => s.cropRect);
  const setCropRect = useEditorStore((s) => s.setCropRect);
  const resize = useEditorStore((s) => s.resize);
  const setImage = useEditorStore((s) => s.setImage);
  const selectedId = useEditorStore((s) => s.selectedId);
  const updateShape = useEditorStore((s) => s.updateShape);
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
        setEffects([]);
        setSelectedEffect(null);
        setStrip([]);
        videoThumbnails(videoId, 14, 44)
          .then(setStrip)
          // A filmstrip is a nicety; a clip that will not decode stills is
          // still perfectly editable.
          .catch(() => setStrip([]));
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

  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    let url: string | null = null;
    setVideoSrc(null);
    playableVideoUrl(videoId)
      .then((u) => {
        url = u;
        if (cancelled) {
          if (u.startsWith("blob:")) URL.revokeObjectURL(u);
          return;
        }
        setVideoSrc(u);
      })
      .catch((err) =>
        toast.show({
          kind: "error",
          title: "Couldn't load that recording for playback",
          description: String(err),
        }),
      );
    return () => {
      cancelled = true;
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    };
  }, [videoId, toast]);

  // Playback stops at the trim's end rather than running to the end of the
  // file: the trimmed range is what the user is working on, so previewing
  // past it is just confusing.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const ms = video.currentTime * 1000;
      // A cut is removed from the export, so previewing through it would show
      // something the finished clip does not have.
      const cut = effects.find(
        (e) => e.kind === "cut" && ms >= e.startMs && ms < e.endMs,
      );
      if (cut) {
        video.currentTime = cut.endMs / 1000;
        setCurrent(cut.endMs);
        return;
      }
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
  }, [trim, videoEl, effects]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = Number(speed);
  }, [speed, videoId, videoEl]);

  // The base canvas under the annotations holds the frame currently shown.
  // It stays hidden (the live <video> shows through) but has to exist and be
  // the right size, because the flatten step measures the overlay from it.
  // Whether the frame under the annotations comes from the native decoder
  // rather than from drawing the <video>. Always on Linux: WebKitGTK's GL
  // video sink hands `createImageBitmap` either a transparent bitmap or
  // uninitialised texture memory, and the latter can't be told from a real
  // frame -- every censor and spotlight previewed against it. Elsewhere it
  // switches on the first time a grab comes back empty.
  const nativeFramesRef = useRef(isLinux);
  const grabFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !videoId) return;
    try {
      if (!nativeFramesRef.current) {
        const bitmap = await createImageBitmap(video);
        if (!isBlankBitmap(bitmap)) {
          setBaseImage(bitmap);
          return;
        }
        bitmap.close();
        nativeFramesRef.current = true;
      }
      const at = video.currentTime * 1000;
      const frame = await videoFrame(videoId, at);
      // A later seek may have landed while this one decoded.
      if (Math.abs(video.currentTime * 1000 - at) > 1) return;
      setBaseImage(await createImageBitmap(frame));
    } catch {
      // A frame that isn't decoded yet simply isn't grabbed; the next
      // seek or pause tries again.
    }
  }, [videoId]);

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
    // `canplay` matters: on the first open `loadeddata` can fire before the
    // decoder has a frame that `createImageBitmap` will accept, which left the
    // base canvas a 1x1 stand-in -- and a censor sampling that drew a flat
    // block instead of pixelating, until the first seek.
    const events = ["loadeddata", "canplay", "seeked", "pause"] as const;
    for (const name of events) video.addEventListener(name, onSettled);
    return () => {
      for (const name of events) video.removeEventListener(name, onSettled);
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
  }, [trim, videoEl, effects]);

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

  // One source of truth for how long the export will be: the same plan the
  // backend is handed, so the number under the clip cannot disagree with it.
  const plan = buildPlan(
    { start: trim.start, end: trim.end },
    effects,
    Number(speed),
  );
  const outMs = plan.outDurationMs;
  const activeZoom = zoomAt(effects, current);
  const atCut = isCut(effects, current);

  const selected = shapes.find((sh) => sh.id === selectedId) ?? null;
  // Only a shape that has actually been given bounds gets the bar; an
  // untimed one shows the "Limit to a time range" button instead, so the
  // timeline is not cluttered by every selection.
  const isTimed =
    selected !== null && (selected.startMs !== undefined || selected.endMs !== undefined);
  const elementRange = isTimed
    ? {
        start: selected!.startMs ?? 0,
        end: selected!.endMs ?? info.duration_ms,
      }
    : null;

  // The crop decides the export's natural size; an explicit Resize overrides
  // it. Both are even-rounded because H.264 refuses odd dimensions.
  const even = (n: number) => Math.max(2, Math.round(n) - (Math.round(n) % 2));
  const cropped = cropRect
    ? { w: cropRect.w, h: cropRect.h }
    : { w: info.width, h: info.height };
  const outputSize: [number, number] = resize
    ? [even(resize.w), even(resize.h)]
    : [even(cropped.w), even(cropped.h)];

  /** Adds an effect starting at the playhead.
   *
   * Two seconds long, or to the end if there is less left: long enough to
   * grab and drag, short enough not to swallow the whole clip. A freeze has
   * no source span at all -- it holds one moment. */
  function addEffect(kind: VideoEffect["kind"]) {
    const start = Math.round(current);
    const end = Math.min(info!.duration_ms, start + 2_000);
    const id = `${kind}-${Date.now().toString(36)}`;
    const base = { id, startMs: start, endMs: end };
    const effect: VideoEffect =
      kind === "cut"
        ? { ...base, kind: "cut" }
        : kind === "freeze"
          ? { ...base, kind: "freeze", endMs: start, holdMs: 1_000 }
          : kind === "speed"
            ? { ...base, kind: "speed", rate: 2 }
            : {
                ...base,
                kind: "zoom",
                // Centred, at half size: a punch-in you then drag and resize,
                // rather than making the user draw one before seeing anything.
                rect: {
                  x: Math.round(info!.width / 4),
                  y: Math.round(info!.height / 4),
                  w: Math.round(info!.width / 2),
                  h: Math.round(info!.height / 2),
                },
              };
    setEffects((all) => [...all, effect]);
    setSelectedEffect(id);
  }

  /** Flattens the annotations at the clip's full size -- one image per
   * stretch of the clip over which the visible set does not change. The
   * backend crops each in step with the frames, so nothing is cropped here.
   *
   * With no time ranges set this is a single segment, and it is sent as a
   * bare PNG rather than a bundle, which is exactly what the export path did
   * before time ranges existed. */
  async function buildOverlay(): Promise<Uint8Array> {
    const segments = overlaySegments(shapes, info!.duration_ms);
    const drawn = segments.filter((seg) => seg.shapes.length > 0);
    if (drawn.length === 0) return new Uint8Array(0);

    const flatten = async (segShapes: typeof shapes) => {
      const canvas = document.createElement("canvas");
      canvas.width = info!.width;
      canvas.height = info!.height;
      return flattenToPng(canvas, segShapes, { transparent: true });
    };

    if (segments.length === 1) return flatten(segments[0].shapes);

    const packed = [];
    for (const seg of drawn) {
      packed.push({
        startMs: seg.startMs,
        endMs: seg.endMs,
        png: await flatten(seg.shapes),
      });
    }
    return packOverlays(packed);
  }

  return (
    <div className="flex flex-col h-screen bg-[var(--bg)] text-[var(--fg)]">
      {/* Wraps rather than clipping: tools, speed, format and the effect
          buttons together are wider than a small or HiDPI-scaled window. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 min-h-12 border-b border-[var(--border)] bg-[var(--surface)]">
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
        <div className="w-px h-5 bg-[var(--border)]" />
        <div className="flex items-center gap-1">
          {(
            [
              ["cut", "Cut"],
              ["freeze", "Freeze"],
              ["speed", "Speed"],
              ["zoom", "Zoom"],
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              className="text-[11px] px-2 py-1 rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[var(--fg-muted)]"
              onClick={() => addEffect(kind)}
            >
              {label}
            </button>
          ))}
        </div>

        {info.has_audio && format === "gif" && (
          <span className="text-[11px] text-[var(--fg-muted)]">GIFs have no sound.</span>
        )}
        {info.has_audio && format === "mp4" && effects.length > 0 && !isMac && (
          <span className="text-[11px] text-[var(--fg-muted)]">
            Audio is dropped when the timeline is edited on this platform.
          </span>
        )}
      </div>

      <div ref={canvasAreaRef} className="flex-1 min-h-0 overflow-auto flex bg-black/30 p-4">
        {baseImage && (
          <Canvas
            baseImage={baseImage}
            hideBase
            isShapeVisible={(shape) => visibleAt(shape, current)}
            onConfirmCrop={() => {
              // Unlike the image editor, the crop is not baked here: doing so
              // would mean re-encoding the whole clip just to preview it. It
              // stays as the export's crop and the tool hands back to select.
              setTool("select");
            }}
            underlay={
              <video
                ref={attachVideo}
                src={videoSrc ?? undefined}
                className="w-full h-full"
                // Mirrors the export's punch-in, so the framing you set is
                // the framing you get.
                style={
                  activeZoom
                    ? {
                        transform: `scale(${info.width / activeZoom.w}) translate(${
                          (info.width / 2 - (activeZoom.x + activeZoom.w / 2)) /
                          info.width * 100
                        }%, ${
                          (info.height / 2 - (activeZoom.y + activeZoom.h / 2)) /
                          info.height * 100
                        }%)`,
                      }
                    : undefined
                }
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
        elementRange={elementRange}
        onElementRangeChange={(range) => {
          if (!selected) return;
          updateShape(selected.id, { startMs: range.start, endMs: range.end });
        }}
        filmstrip={strip}
        cuts={effects.filter((e) => e.kind === "cut")}
      />

      <EffectLanes
        duration={info.duration_ms}
        effects={effects}
        selectedId={selectedEffect}
        onSelect={setSelectedEffect}
        onChange={(next) =>
          setEffects((all) => all.map((e) => (e.id === next.id ? next : e)))
        }
        onRemove={(id) => {
          setEffects((all) => all.filter((e) => e.id !== id));
          setSelectedEffect(null);
        }}
      />

      <div className="flex items-center gap-3 px-3 h-8 border-t border-[var(--border)] bg-[var(--surface)]">
        <span className="text-[11px] font-mono text-[var(--fg-muted)] tabular-nums">
          {info.width} × {info.height} · {formatTimecode(outMs)}
          {info.has_audio ? " · audio" : ""}
        </span>
        {atCut && (
          <span className="text-[11px] text-[var(--danger)]">
            This moment is cut from the export
          </span>
        )}

        {selected && (
          <div className="flex items-center gap-2 ml-auto">
            {isTimed ? (
              <>
                <span className="text-[11px] font-mono text-[var(--fg-muted)] tabular-nums">
                  shows {formatTimecode(elementRange!.start)}–
                  {formatTimecode(elementRange!.end)}
                </span>
                <button
                  type="button"
                  className="text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)] underline underline-offset-2"
                  onClick={() =>
                    updateShape(selected.id, { startMs: undefined, endMs: undefined })
                  }
                >
                  Show for the whole clip
                </button>
              </>
            ) : (
              <button
                type="button"
                className="text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)] underline underline-offset-2"
                onClick={() => {
                  // Starts at the playhead and runs to the end, which is what
                  // "from here on" means and the most common thing wanted.
                  updateShape(selected.id, {
                    startMs: Math.round(current),
                    endMs: info.duration_ms,
                  });
                }}
              >
                Limit to a time range
              </button>
            )}
          </div>
        )}
      </div>

      <VideoExportBar
        request={{
          id: videoId,
          range: { start_ms: Math.round(trim.start), end_ms: Math.round(trim.end) },
          speed: Number(speed),
          crop: cropRect,
          output_size: outputSize,
          format,
          plan: plan.segments.map((seg) => ({
            src_start_ms: seg.srcStartMs,
            src_end_ms: seg.srcEndMs,
            out_start_ms: seg.outStartMs,
            out_end_ms: seg.outEndMs,
            rate: seg.rate,
          })),
          zooms: effects
            .filter((e) => e.kind === "zoom")
            .map((e) => ({
              start_ms: Math.round(e.startMs),
              end_ms: Math.round(e.endMs),
              rect: e.kind === "zoom" ? e.rect : { x: 0, y: 0, w: 0, h: 0 },
            })),
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

/** Whether a grabbed frame came back with nothing in it. A decoded video
 * frame is opaque everywhere, so a sparse sample that is entirely
 * transparent means the grab failed rather than the picture being empty. */
function isBlankBitmap(bitmap: ImageBitmap): boolean {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(bitmap, 0, 0, 8, 8);
  const data = ctx.getImageData(0, 0, 8, 8).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}
