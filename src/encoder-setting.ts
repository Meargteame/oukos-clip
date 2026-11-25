/**
 * Video encoder choice. Hardware encoders (Intel QuickSync, NVIDIA NVENC, AMD AMF) move encoding off
 * the CPU, which on a 2-core laptop leaves the cores for decoding, scaling and face tracking.
 * libx264 is always available and is the fallback.
 */
export type EncoderName = "libx264" | "h264_qsv" | "h264_nvenc" | "h264_amf";

export const HARDWARE_ENCODERS: readonly EncoderName[] = ["h264_nvenc", "h264_qsv", "h264_amf"];

/**
 * Encoders "auto" may pick. Only NVENC: on the dev laptop (2-core Intel, Nov 2026) QuickSync rendered a
 * 60s clip no faster than x264 (32-43s vs 32-38s; decoding and scaling dominate) and was ~3s slower per
 * short clip because of start-up cost. QSV and AMF stay available via ENCODER=qsv / ENCODER=amf.
 */
export const AUTO_ENCODERS: readonly EncoderName[] = ["h264_nvenc"];

/** ffmpeg output args for one encoder, tuned for roughly the same visual quality as x264 CRF 22. */
export function encoderArgs(name: EncoderName): string[] {
  switch (name) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p"];
    case "h264_qsv":
      // QSV takes NV12 frames (same 4:2:0 layout as yuv420p, so players treat the result the same).
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23", "-pix_fmt", "nv12"];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-pix_fmt", "nv12"];
    default:
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p"];
  }
}

/** Parse the ENCODER setting: auto (default), x264/cpu, or an ffmpeg encoder name. */
export function encoderSetting(raw: string): "auto" | EncoderName {
  const value = raw.trim().toLowerCase();
  if (value === "x264" || value === "cpu" || value === "libx264") return "libx264";
  if ((HARDWARE_ENCODERS as readonly string[]).includes(value)) return value as EncoderName;
  if (value === "qsv" || value === "quicksync") return "h264_qsv";
  if (value === "nvenc" || value === "nvidia") return "h264_nvenc";
  if (value === "amf" || value === "amd") return "h264_amf";
  return "auto";
}
