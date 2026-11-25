import { config } from "./config.ts";
import { AUTO_ENCODERS, encoderArgs, type EncoderName } from "./encoder-setting.ts";
import { run } from "./exec.ts";

export type { EncoderName };

/** Encode a tenth of a second of black frames; succeeds only if the driver and hardware really work. */
async function works(name: EncoderName): Promise<boolean> {
  try {
    await run(config.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1",
      ...encoderArgs(name),
      "-f", "null", "-",
    ]);
    return true;
  } catch {
    return false;
  }
}

let chosen: Promise<EncoderName> | undefined;

/** The encoder to use, probed once per run. */
export function pickEncoder(): Promise<EncoderName> {
  chosen ??= (async () => {
    const setting = config.encoder;
    if (setting === "libx264") return "libx264";
    const candidates = setting === "auto" ? AUTO_ENCODERS : [setting];
    for (const name of candidates) {
      if (await works(name)) return name;
    }
    if (setting !== "auto") console.warn(`Encoder ${setting} is not usable here; using libx264.`);
    return "libx264";
  })();
  return chosen;
}

/** Stop using a hardware encoder that failed on a real clip (driver hiccup, unsupported size, ...). */
export function disableEncoder(name: EncoderName): void {
  if (name === "libx264") return;
  console.warn(`Encoder ${name} failed on a clip; using libx264 from now on.`);
  chosen = Promise.resolve("libx264");
}
