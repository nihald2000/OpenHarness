import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { client } from "@/lib/client";

type Props = { onTranscript: (text: string) => void; disabled?: boolean; compact?: boolean };

export function VoiceMicButton({ onTranscript, disabled = false, compact = false }: Props) {
  const [recording, setRecording] = useState(false);
  const [working, setWorking] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognition = useRef<any>(null);
  const recognizedText = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopResources = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    recognition.current?.stop?.();
    recognition.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(() => () => stopResources(), []);

  const start = async () => {
    setError("");
    setInterim("");
    recognizedText.current = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const supportedType = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus");
      const media = supportedType
        ? new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32_000 })
        : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      media.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      media.onstop = async () => {
        setRecording(false);
        setWorking(true);
        stopResources();
        try {
          const blob = new Blob(chunks, { type: media.mimeType || "audio/webm" });
          const result = await client.transcribeAudio(blob, `voice-note.${blob.type.includes("mp4") ? "mp4" : "webm"}`);
          const text = result.text.trim() || recognizedText.current.trim();
          if (text) onTranscript(text);
          else setError("No speech was recognized.");
        } catch {
          const fallback = recognizedText.current.trim();
          if (fallback) onTranscript(fallback);
          else setError("Transcription failed. Try again or type your note.");
        } finally {
          setWorking(false);
          setInterim("");
        }
      };
      recorder.current = media;
      media.start(250);
      setRecording(true);

      const Speech = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
      if (Speech) {
        const speech = new Speech();
        speech.continuous = true;
        speech.interimResults = true;
        speech.onresult = (event: any) => {
          let final = "";
          let partial = "";
          for (let i = event.resultIndex ?? 0; i < event.results.length; i++) {
            const result = event.results[i];
            const value = String(result?.[0]?.transcript ?? "");
            if (result?.isFinal) final += value;
            else partial += value;
          }
          if (final) recognizedText.current = `${recognizedText.current} ${final}`.trim();
          setInterim(partial || recognizedText.current);
        };
        speech.onerror = () => {};
        recognition.current = speech;
        try { speech.start(); } catch {}
      }
      timer.current = setTimeout(() => { if (media.state === "recording") media.stop(); }, 45_000);
    } catch {
      stopResources();
      setError("Microphone access is unavailable.");
    }
  };

  const stop = () => {
    const media = recorder.current;
    recorder.current = null;
    if (media?.state === "recording") media.stop();
  };

  return <span className="inline-flex items-center gap-1">
    <button type="button" disabled={disabled || working} onClick={() => recording ? stop() : void start()} aria-label={recording ? "Stop voice note" : "Record voice note"} title={recording ? "Stop voice note" : "Muse Voice · Record a note"} className={`touch-target inline-flex items-center justify-center rounded-lg border border-border ${compact ? "h-8 gap-1 px-2 text-[11px]" : "size-9"} ${recording ? "border-danger/40 bg-danger/10 text-danger" : "text-muted hover:bg-hover hover:text-fg"}`}>
      {working ? <span className="animate-pulse">…</span> : recording ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      {compact && <span>{recording ? "Stop" : working ? "Transcribing" : "Voice note"}</span>}
    </button>
    {(error || interim) && <span role="status" className={`max-w-40 truncate text-[10px] ${error ? "text-danger" : "text-muted"}`} title={error || interim}>{error || interim}</span>}
  </span>;
}
