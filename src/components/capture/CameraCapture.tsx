'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CAPTURE_JPEG_QUALITY,
  CAPTURE_MAX_BYTES,
  buildWatermarkLines,
  computeCaptureSize,
  computeWatermarkBandHeight,
  type CaptureLocation,
} from './watermark.ts';

/**
 * Real camera capture for attendance selfies (decisions.md #5, PRD §4):
 * getUserMedia preview → capture to canvas → draw the watermark band
 * (timestamp, display name, GPS coords, matched-location label) → resize the
 * longest edge to <=1280px → export JPEG (~q80, stepped down until <=1MB).
 *
 * The client does the pixel re-encode; the server only validates the bytes
 * (see `src/lib/images/selfie.ts` for the validation boundary).
 *
 * Camera permission is requested IN CONTEXT: getUserMedia runs only when this
 * component mounts (the member opened the capture dialog), never on page load.
 */

export interface CapturedSelfie {
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
}

export interface CameraCaptureProps {
  /** Called when the member confirms ("Gunakan foto") the captured frame. */
  onCapture: (selfie: CapturedSelfie) => void;
  /** Called when the member dismisses the camera without capturing. */
  onCancel: () => void;
  displayName: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  locations: CaptureLocation[];
  /** IANA timezone for the watermark timestamp; defaults to the device zone. */
  timeZone?: string;
}

type CameraStatus = 'starting' | 'ready' | 'permission_denied' | 'unavailable';

/** Quality ladder for the <=1MB re-encode loop. */
const QUALITY_STEPS = [CAPTURE_JPEG_QUALITY, 0.72, 0.62, 0.52, 0.42, 0.32];

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * Draws the video frame + watermark band onto an offscreen canvas sized via
 * `computeCaptureSize`, then exports a JPEG at or under the 1MB ceiling by
 * stepping the encoder quality down. Throws when the browser cannot encode.
 */
export async function renderSelfieBlob(args: {
  video: HTMLVideoElement;
  displayName: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  locations: CaptureLocation[];
  timeZone?: string;
  now?: Date;
}): Promise<CapturedSelfie> {
  const sourceWidth = args.video.videoWidth;
  const sourceHeight = args.video.videoHeight;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('camera stream has no frame yet');
  }

  const { width, height } = computeCaptureSize(sourceWidth, sourceHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');

  ctx.drawImage(args.video, 0, 0, width, height);

  // Watermark band at the bottom: translucent dark strip + four text lines.
  const lines = buildWatermarkLines({
    displayName: args.displayName,
    timestamp: args.now ?? new Date(),
    latitude: args.latitude,
    longitude: args.longitude,
    accuracyM: args.accuracyM,
    locations: args.locations,
    timeZone: args.timeZone,
  });
  const bandHeight = computeWatermarkBandHeight(height);
  const padding = Math.max(8, Math.round(bandHeight * 0.14));
  const fontSize = Math.max(11, Math.round((bandHeight - padding * 2) / (lines.length + 1.2)));
  ctx.fillStyle = 'rgba(20, 22, 19, 0.62)';
  ctx.fillRect(0, height - bandHeight, width, bandHeight);
  ctx.fillStyle = '#f8f2e8';
  ctx.font = `600 ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  lines.forEach((line, index) => {
    const y = height - padding - (lines.length - 1 - index) * Math.round(fontSize * 1.18);
    ctx.fillText(line, padding, y);
  });

  for (const quality of QUALITY_STEPS) {
    const blob = await canvasToJpeg(canvas, quality);
    if (blob && blob.size <= CAPTURE_MAX_BYTES) {
      return { blob, width, height, bytes: blob.size };
    }
  }
  throw new Error('unable to encode selfie within the 1MB limit');
}

export function CameraCapture(props: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('starting');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  // Acquire the camera on mount (the dialog opening IS the in-context ask) and
  // release every track on unmount so the indicator light never lingers.
  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable');
        setError('Kamera tidak tersedia di peramban ini. Gunakan peramban modern dengan HTTPS.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        setStatus('ready');
      } catch (cause) {
        const name = cause instanceof DOMException ? cause.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setStatus('permission_denied');
          setError('Izin kamera ditolak. Aktifkan izin kamera untuk situs ini, lalu coba lagi.');
        } else {
          setStatus('unavailable');
          setError('Kamera tidak dapat diakses. Pastikan tidak dipakai aplikasi lain.');
        }
      }
    }
    void start();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [stopStream]);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || busy) return;
    setBusy(true);
    setError('');
    try {
      const selfie = await renderSelfieBlob({
        video,
        displayName: props.displayName,
        latitude: props.latitude,
        longitude: props.longitude,
        accuracyM: props.accuracyM,
        locations: props.locations,
        timeZone: props.timeZone,
      });
      stopStream();
      props.onCapture(selfie);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gagal mengambil foto. Coba lagi.');
      setBusy(false);
    }
  }, [busy, props, stopStream]);

  const cancel = useCallback(() => {
    stopStream();
    props.onCancel();
  }, [props, stopStream]);

  return (
    <div className="camera-capture">
      <div className="fake-camera camera-preview">
        <video
          ref={videoRef}
          className="camera-video"
          playsInline
          muted
          autoPlay
          aria-label="Pratinjau kamera"
        />
        {status === 'starting' ? <span>Menyalakan kamera…</span> : null}
        {status === 'permission_denied' || status === 'unavailable' ? <span>KAMERA TIDAK AKTIF</span> : null}
      </div>
      {error ? (
        <div className="capture-error" role="alert">
          <strong>Kamera bermasalah</strong>
          <span>{error}</span>
        </div>
      ) : null}
      <div className="capture-actions">
        <button className="button-secondary" onClick={cancel} type="button">
          Batal
        </button>
        <button className="button-primary" disabled={status !== 'ready' || busy} onClick={() => void capture()} type="button">
          {busy ? 'Memproses foto…' : 'Ambil foto'}
        </button>
      </div>
    </div>
  );
}
