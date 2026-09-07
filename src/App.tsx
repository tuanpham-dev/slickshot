import { useEffect, useState } from "react";
import { parseHashRoute } from "./lib/ipc";
import { ToastProvider } from "./ui/Toast";
import { TooltipProvider } from "./ui/Tooltip";
import { Kit } from "./ui/__preview__/Kit";
import { MainWindow } from "./main/MainWindow";
import { Editor } from "./editor/Editor";
import { Overlay } from "./overlay/Overlay";
import { PinWindow } from "./pin/PinWindow";
import { Thumbnail } from "./thumbnail/Thumbnail";
import { ScrollControl } from "./scroll/ScrollControl";
import { RecordControl } from "./record/RecordControl";
import { VideoEditor } from "./video/VideoEditor";

function Router() {
  const [{ route, params }, setState] = useState(parseHashRoute());

  useEffect(() => {
    const onHashChange = () => setState(parseHashRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  switch (route) {
    case "editor":
      return <Editor params={params} />;
    case "overlay":
      return <Overlay params={params} />;
    case "pin":
      return <PinWindow params={params} />;
    case "scroll":
      return <ScrollControl />;
    case "record":
      return <RecordControl params={params} />;
    case "video-editor":
      return <VideoEditor params={params} />;
    case "thumbnail":
      return <Thumbnail params={params} />;
    case "kit":
      return <Kit />;
    case "main":
    default:
      return <MainWindow />;
  }
}

export default function App() {
  return (
    <ToastProvider>
      <TooltipProvider>
        <Router />
      </TooltipProvider>
    </ToastProvider>
  );
}
