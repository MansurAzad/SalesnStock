import { useEffect, useRef, useState } from "react";
import { Camera, Flashlight, ScanLine, ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { extractImei } from "@/lib/imei";

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };

const FORMATS = [
  "code_128",
  "code_39",
  "code_93",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "itf",
  "codabar",
  "qr_code",
  "data_matrix",
];

/** Decoding a 1D barcode needs far less than 60fps — this keeps cheap phones cool. */
const DETECT_INTERVAL_MS = 180;

let audioCtx: AudioContext | null = null;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const o = audioCtx.createOscillator();
    o.frequency.value = 1800;
    o.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.08);
    navigator.vibrate?.(60);
  } catch {
    /* audio is a nicety, never a blocker */
  }
}

function cameraError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError")
    return "Camera permission denied. Allow camera access and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera found on this device.";
  if (name === "NotReadableError") return "Camera is busy in another app. Close it and try again.";
  if (name === "SecurityError") return "Camera needs a secure (https) connection on this device.";
  const msg = (e as { message?: string })?.message;
  return msg || "Could not start the camera.";
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
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        title="Scan with camera"
      >
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

function ScannerDialog({
  onScan,
  onClose,
  continuous,
  imeiOnly,
}: {
  onScan: (c: string) => void;
  onClose: () => void;
  continuous: boolean;
  imeiOnly: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState("");
  const [warn, setWarn] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [last, setLast] = useState<string[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState<{ min: number; max: number; v: number } | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cb = useRef(onScan);
  useEffect(() => {
    cb.current = onScan;
  }, [onScan]);

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const seen = new Map<string, number>();
    setErr("");
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      trackRef.current = null;
    };

    (async () => {
      try {
        const native = (globalThis as unknown as { BarcodeDetector?: new (o: object) => Detector })
          .BarcodeDetector;
        let Det = native;
        if (!Det) {
          const ponyfill = await import("barcode-detector/ponyfill");
          Det = ponyfill.BarcodeDetector as unknown as new (o: object) => Detector;
        }
        if (stop) return;
        const detector = new Det({ formats: FORMATS });
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        // Keep the stream on a ref so unmounting mid-permission-prompt still stops it.
        streamRef.current = stream;
        if (stop) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error("No camera found");
        trackRef.current = track;
        const caps = (track.getCapabilities?.() ?? {}) as {
          focusMode?: string[];
          zoom?: { min: number; max: number };
          torch?: boolean;
        };
        const adv: Record<string, unknown> = {};
        if (caps.focusMode?.includes("continuous")) adv["focusMode"] = "continuous";
        if (caps.zoom) {
          const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, 2));
          adv["zoom"] = z;
          setZoom({ min: caps.zoom.min, max: caps.zoom.max, v: z });
        }
        if (Object.keys(adv).length)
          await track
            .applyConstraints({ advanced: [adv as MediaTrackConstraintSet] })
            .catch(() => {});
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
                const w = v.videoWidth * 0.7,
                  h = v.videoHeight * 0.35;
                crop.width = w * 2;
                crop.height = h * 2;
                cctx.imageSmoothingEnabled = false;
                cctx.drawImage(
                  v,
                  (v.videoWidth - w) / 2,
                  (v.videoHeight - h) / 2,
                  w,
                  h,
                  0,
                  0,
                  crop.width,
                  crop.height,
                );
                found = await detector.detect(crop);
              }
            } catch {
              /* frame not ready */
            }
            for (const f of found) {
              const raw = f.rawValue.trim();
              if (!raw) continue;
              const code = imeiOnly ? extractImei(raw) : raw;
              if (!code) {
                // Show what was scanned so the staff member knows the shot was
                // taken — silently swallowing it looks like a broken scanner.
                const now = Date.now();
                if ((seen.get(raw) ?? 0) > now - 2500) continue;
                seen.set(raw, now);
                setRejected((l) => [raw, ...l.filter((x) => x !== raw)].slice(0, 4));
                continue;
              }
              const now = Date.now();
              if ((seen.get(code) ?? 0) > now - 2500) continue;
              seen.set(code, now);
              beep();
              setLast((l) => [code, ...l.filter((x) => x !== code)].slice(0, 6));
              cb.current(code);
              if (!continuous) {
                stop = true;
                cleanup();
                return;
              }
            }
          }
          if (!stop) timer = window.setTimeout(loop, DETECT_INTERVAL_MS);
        };
        void loop();
      } catch (e) {
        cleanup();
        setErr(cameraError(e));
      }
    })();

    return cleanup;
  }, [continuous, imeiOnly, attempt]);

  const toggleTorch = async () => {
    const next = !torch;
    const ok = await trackRef.current
      ?.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      .then(() => true)
      .catch(() => false);
    if (ok === false) {
      setWarn("This camera has no torch.");
      return;
    }
    setWarn("");
    setTorch(next);
  };
  const setZ = async (z: number) => {
    const ok = await trackRef.current
      ?.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] })
      .then(() => true)
      .catch(() => false);
    if (ok === false) {
      setWarn("This camera does not support zoom.");
      return;
    }
    setWarn("");
    setZoom((o) => (o ? { ...o, v: z } : o));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="h-4 w-4" /> Scan {imeiOnly ? "IMEI" : "barcode"}
          </DialogTitle>
          <DialogDescription>
            Hold the barcode inside the box, 8–15 cm away. Use zoom for very small IMEI stickers.
          </DialogDescription>
        </DialogHeader>
        {err ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {err}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setErr("");
                setAttempt((a) => a + 1);
              }}
            >
              Try again
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <>
            {warn && (
              <p className="mb-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-accent-foreground">
                {warn}
              </p>
            )}
            <div className="relative overflow-hidden rounded-md bg-foreground">
              <video ref={video} playsInline muted className="aspect-video w-full object-cover" />
              <div className="pointer-events-none absolute inset-x-[15%] top-[32.5%] h-[35%] rounded border-2 border-primary">
                <div className="absolute inset-x-0 top-1/2 h-0.5 animate-pulse bg-destructive" />
              </div>
            </div>
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={torch ? "default" : "outline"}
            onClick={toggleTorch}
          >
            <Flashlight className="mr-1 h-4 w-4" /> Light
          </Button>
          {zoom && (
            <label className="flex flex-1 items-center gap-2 text-xs">
              <ZoomIn className="h-4 w-4" />
              <span className="sr-only">Camera zoom</span>
              <input
                type="range"
                aria-label="Camera zoom"
                className="flex-1"
                min={zoom.min}
                max={zoom.max}
                step={0.1}
                value={zoom.v}
                onChange={(e) => setZ(Number(e.target.value))}
              />
            </label>
          )}
          <Button type="button" size="sm" onClick={onClose}>
            {continuous ? "Done" : "Close"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {continuous
            ? "Keeps scanning until you press Done."
            : "Scanning stops at the first code found."}
        </p>
        {last.length > 0 && (
          <div className="font-mono text-xs">
            {last.map((c) => (
              <div key={c}>✓ {c}</div>
            ))}
          </div>
        )}
        {rejected.length > 0 && (
          <div className="font-mono text-xs text-muted-foreground">
            {rejected.map((c) => (
              <div key={c}>✕ {c} — not an IMEI</div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
