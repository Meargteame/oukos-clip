import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseJson3, type Word } from "./captions.ts";
import { config } from "./config.ts";
import { run } from "./exec.ts";

export interface StreamInput {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface SubtitleTrack {
  readonly lang: string;
  readonly auto: boolean;
  /** Direct json3 URL from the info call, when YouTube provided one. */
  readonly url?: string;
}

export interface VideoInfo {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly video: StreamInput;
  /** Separate audio stream; absent when the video stream already has audio. */
  readonly audio?: StreamInput;
  /** Small (~360p) video-only stream used for face analysis. */
  readonly analysis: StreamInput;
  readonly subtitleTrack?: SubtitleTrack;
}

interface RawFormat {
  readonly url?: string;
  readonly protocol?: string;
  readonly vcodec?: string;
  readonly acodec?: string;
  readonly width?: number;
  readonly height?: number;
  readonly http_headers?: Record<string, string>;
}

type TrackMap = Record<string, unknown[] | undefined>;

/** Highest resolution up to the cap first; H.264/AAC only as a tie-breaker. */
function formatArgs(maxHeight: number): string[] {
  return ["-f", "bv*+ba/b", "-S", `res:${maxHeight},vcodec:h264,acodec:aac`];
}

/** Pick a small progressive-download video stream (~360p) for cheap face analysis. */
export function pickAnalysisFormat(formats: readonly RawFormat[] | undefined): RawFormat | undefined {
  const candidates = (formats ?? []).filter(
    (f) => f.url && f.height && f.vcodec && f.vcodec !== "none" && (f.protocol ?? "https").startsWith("http") && !f.protocol?.includes("m3u8"),
  );
  const score = (f: RawFormat) => Math.abs((f.height ?? 0) - 360) + (f.vcodec?.startsWith("avc1") ? 0 : 30);
  return candidates.sort((a, b) => score(a) - score(b))[0];
}

/** Pick the best caption track: manual > auto original-language > any manual > any auto original. */
export function pickSubtitleTrack(
  subtitles: TrackMap | undefined,
  automatic: TrackMap | undefined,
  preferredLang: string,
): SubtitleTrack | undefined {
  const manual = Object.keys(subtitles ?? {}).filter((key) => key !== "live_chat");
  const auto = Object.keys(automatic ?? {});
  const base = preferredLang.toLowerCase().split("-")[0];
  const matches = (key: string) => key.toLowerCase().split("-")[0] === base;

  const manualMatch = manual.find(matches);
  if (manualMatch) return { lang: manualMatch, auto: false };
  // YouTube auto-captions list the spoken language as "<lang>-orig" next to machine translations.
  const autoOrig = auto.find((key) => key.endsWith("-orig") && matches(key));
  if (autoOrig) return { lang: autoOrig, auto: true };
  if (auto.includes(base)) return { lang: base, auto: true };
  if (manual.length) return { lang: manual[0], auto: false };
  const anyOrig = auto.find((key) => key.endsWith("-orig"));
  if (anyOrig) return { lang: anyOrig, auto: true };
  return undefined;
}

export function parseVideoInfo(info: Record<string, unknown>, preferredLang = ""): VideoInfo {
  const requested = (info.requested_formats as RawFormat[] | undefined) ?? [info as RawFormat];
  const video = requested.find((f) => f.vcodec && f.vcodec !== "none") ?? requested[0];
  const audio = requested.find((f) => f !== video && f.acodec && f.acodec !== "none");
  if (!video?.url) throw new Error("yt-dlp did not return a playable video stream.");

  const lang = preferredLang || (typeof info.language === "string" ? info.language : "") || "en";
  const picked = pickSubtitleTrack(
    info.subtitles as TrackMap | undefined,
    info.automatic_captions as TrackMap | undefined,
    lang,
  );
  const trackFormats = picked
    ? ((picked.auto ? info.automatic_captions : info.subtitles) as TrackMap)[picked.lang]
    : undefined;
  const json3 = (trackFormats as { ext?: string; url?: string }[] | undefined)?.find((f) => f.ext === "json3" && f.url);
  const subtitleTrack = picked && json3?.url ? { ...picked, url: json3.url } : picked;

  const toInput = (format: RawFormat): StreamInput => ({
    url: format.url ?? "",
    headers: format.http_headers ?? (info.http_headers as Record<string, string>) ?? {},
  });

  return {
    id: String(info.id ?? ""),
    title: String(info.title ?? "Untitled"),
    channel: String(info.channel ?? info.uploader ?? ""),
    duration: Number(info.duration ?? 0),
    width: Number(video.width ?? info.width ?? 0),
    height: Number(video.height ?? info.height ?? 0),
    video: toInput(video),
    ...(audio?.url ? { audio: toInput(audio) } : {}),
    analysis: toInput(pickAnalysisFormat(info.formats as RawFormat[] | undefined) ?? video),
    ...(subtitleTrack ? { subtitleTrack } : {}),
  };
}

/** Fetch metadata, stream URLs and caption availability in one yt-dlp call (no download). */
export async function fetchVideoInfo(url: string, signal?: AbortSignal): Promise<VideoInfo> {
  const { stdout } = await run(
    config.ytDlp,
    ["-J", "--no-playlist", "--no-warnings", ...formatArgs(config.maxSourceHeight), url],
    { signal },
  );
  return parseVideoInfo(JSON.parse(stdout) as Record<string, unknown>, config.captionLanguage);
}

/**
 * Get one caption track as words. Tries the direct URL from the info call first
 * (one small HTTP request), then falls back to a full yt-dlp subtitle download.
 */
export async function downloadCaptions(
  url: string,
  track: SubtitleTrack,
  dir: string,
  signal?: AbortSignal,
): Promise<Word[]> {
  if (track.url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(track.url, { signal });
        if (response.ok) {
          const words = parseJson3(await response.json());
          if (words.length) return words;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
  }
  return downloadCaptionsWithYtDlp(url, track, dir, signal);
}

async function downloadCaptionsWithYtDlp(
  url: string,
  track: SubtitleTrack,
  dir: string,
  signal?: AbortSignal,
): Promise<Word[]> {
  await run(
    config.ytDlp,
    [
      "--skip-download",
      "--no-playlist",
      "--no-warnings",
      track.auto ? "--write-auto-subs" : "--write-subs",
      "--sub-langs",
      track.lang,
      "--sub-format",
      "json3",
      "-o",
      path.join(dir, "captions.%(ext)s"),
      url,
    ],
    { signal },
  );
  const file = (await readdir(dir)).find((name) => name.startsWith("captions.") && name.endsWith(".json3"));
  if (!file) throw new Error(`yt-dlp did not save the "${track.lang}" captions.`);
  return parseJson3(JSON.parse(await readFile(path.join(dir, file), "utf8")));
}

export function isYouTubeUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\.|^m\./, "");
    return host === "youtube.com" || host === "youtu.be" || host === "music.youtube.com";
  } catch {
    return false;
  }
}
