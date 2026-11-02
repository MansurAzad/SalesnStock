import { useEffect, useRef, useState } from "react";
import { Camera, Flashlight, ScanLine, ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { extractImei } from "@/lib/imei";

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };

const FORMATS = ["code_128", "code_39", "code_93", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "codabar", "qr_code", "data_matrix"];

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = 1800;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.08);
    navigator.vibrate?.(60);
  } catch { /* ignore */ }
}

/**
 * Camera barcode scanner tuned for tiny IMEI barcodes:
 * high-resolution stream, continuous focus, torch + zoom, and an
 * upscaled centre-crop pass so thin 1D bars are still decoded.
 */
export function ScanButton({
  onScan,
  continuous = false,
  imeiOnly = true,
  label = "Camera",
}: {
  onScan: (code: string) => void;
  continuous?: boolean;
  imeiOnly?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} title="Scan with camera">
        <Camera className="mr-1 h-4 w-4" /> {label}
      </Button>
      {open && (
        <ScannerDialog
          onClose={() => setOpen(false)}
          continuous={continuous}
          imeiOnly={imeiOnly}
          onScan={(c) => {
            onScan(c);
            if (!continuous) setOpen(false);
          }}
        />
      )}
    </>
  );
}

function ScannerDialog({ onScan, onClose, continuous, imeiOnly }: { onScan: (c: string) => void; onClose: () => void; continuous: boolean; imeiOnly: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState("");
  const [last, setLast] = useState<string[]>([]);
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState<{ min: number; max: number; v: number } | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    let stop = false;
    let stream: MediaStream | null = null;
    const seen = new Map<string, number>();
    (async () => {
      try {
        const native = (globalThis as unknown as { BarcodeDetector?: new (o: object) => Detector }).BarcodeDetector;
        let Det = native;
        if (!Det) Det = (await import("barcode-detector/ponyfill")).BarcodeDetector as unknown as new (o: object) => Detector;
        const detector = new Det({ formats: FORMATS });
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error("No camera found");
        trackRef.current = track;
        const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[]; zoom?: { min: number; max: number }; torch?: boolean };
        const adv: Record<string, unknown> = {};
        if (caps.focusMode?.includes("continuous")) adv["focusMode"] = "continuous";
        if (caps.zoom) {
          const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, 2));
          adv["zoom"] = z;
          setZoom({ min: caps.zoom.min, max: caps.zoom.max, v: z });
        }
        if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] }).catch(() => {});
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const crop = document.createElement("canvas");
        const cctx = crop.getContext("2d", { willReadFrequently: true })!;
        let pass = 0;
        const loop = async () => {
          if (stop) return;
          if (v.readyState >= 2) {
            let found: { rawValue: string }[] = [];
            try {
              if (pass++ % 2 === 0) {
                found = await detector.detect(v);
              } else {
                // centre band, upscaled 2x — helps tiny barcodes
                const w = v.videoWidth * 0.7, h = v.videoHeight * 0.35;
                crop.width = w * 2; crop.height = h * 2;
                cctx.imageSmoothingEnabled = false;
                cctx.drawImage(v, (v.videoWidth - w) / 2, (v.videoHeight - h) / 2, w, h, 0, 0, crop.width, crop.height);
                found = await detector.detect(crop);
              }
            } catch { /* frame not ready */ }
            for (const f of found) {
              const code = imeiOnly ? extractImei(f.rawValue) : f.rawValue.trim();
              if (!code) continue;
              const now = Date.now();
              if ((seen.get(code) ?? 0) > now - 2500) continue;
              seen.set(code, now);
              beep();
              setLast((l) => [code, ...l.filter((x) => x !== code)].slice(0, 6));
              cb.current(code);
              if (!continuous) { stop = true; return; }
            }
          }
          requestAnimationFrame(loop);
        };
        loop();
      } catch (e) {
        setErr((e as Error).name === "NotAllowedError" ? "Camera permission denied. Allow camera access and try again." : (e as Error).message);
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [continuous, imeiOnly]);

  const toggleTorch = async () => {
    const t = !torch;
    await trackRef.current?.applyConstraints({ advanced: [{ torch: t } as MediaTrackConstraintSet] }).catch(() => {});
    setTorch(t);
  };
  const setZ = async (z: number) => {
    await trackRef.current?.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] }).catch(() => {});
    setZoom((o) => (o ? { ...o, v: z } : o));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><ScanLine className="h-4 w-4" /> Scan {imeiOnly ? "IMEI" : "barcode"}</DialogTitle></DialogHeader>
        {err ? (
          <p className="text-sm text-destructive">{err}</p>
        ) : (
          <div className="relative overflow-hidden rounded-md bg-foreground">
            <video ref={video} playsInline muted className="aspect-video w-full object-cover" />
            <div className="pointer-events-none absolute inset-x-[15%] top-[32.5%] h-[35%] rounded border-2 border-primary">
              <div className="absolute inset-x-0 top-1/2 h-0.5 animate-pulse bg-destructive" />
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant={torch ? "default" : "outline"} onClick={toggleTorch}><Flashlight className="mr-1 h-4 w-4" /> Light</Button>
          {zoom && (
            <label className="flex flex-1 items-center gap-2 text-xs">
              <ZoomIn className="h-4 w-4" />
              <input type="range" className="flex-1" min={zoom.min} max={zoom.max} step={0.1} value={zoom.v} onChange={(e) => setZ(Number(e.target.value))} />
            </label>
          )}
          <Button type="button" size="sm" onClick={onClose}>{continuous ? "Done" : "Close"}</Button>
        </div>
        <p className="text-xs text-muted-foreground">Hold the barcode inside the box, 8–15 cm away. Use zoom for very small IMEI stickers. {continuous && "Keeps scanning until you press Done."}</p>
        {last.length > 0 && <div className="font-mono text-xs">{last.map((c) => <div key={c}>✓ {c}</div>)}</div>}
      </DialogContent>
    </Dialog>
  );
}
