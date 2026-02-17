import OpenAI, { toFile } from "openai";
import { execFile } from "child_process";
import { writeFile, readFile, unlink, chmod, access } from "fs/promises";
import { createWriteStream } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { constants } from "fs";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const FFMPEG_PATH = "/tmp/ffmpeg";
const FFMPEG_URL =
  "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz";

/**
 * Download a static ffmpeg binary to /tmp if not already there.
 * Uses Node.js fetch + zlib — no shell tools required.
 */
async function ensureFfmpeg(): Promise<string> {
  try {
    await access(FFMPEG_PATH, constants.X_OK);
    return FFMPEG_PATH;
  } catch {
    // Download gzipped binary and decompress with Node.js
    const response = await fetch(FFMPEG_URL, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ffmpeg: ${response.status}`);
    }

    const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream);
    const gunzip = createGunzip();
    const output = createWriteStream(FFMPEG_PATH);

    await pipeline(nodeStream, gunzip, output);
    await chmod(FFMPEG_PATH, 0o755);
    return FFMPEG_PATH;
  }
}

/**
 * Extract audio from a video file using ffmpeg.
 * Returns an mp3 buffer that's much smaller than the original video.
 */
async function extractAudio(
  videoBuffer: Buffer,
  filename: string
): Promise<Buffer> {
  const ffmpeg = await ensureFfmpeg();
  const id = randomUUID();
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const inputPath = join("/tmp", `${id}_${safeFilename}`);
  const outputPath = join("/tmp", `${id}_audio.mp3`);

  try {
    await writeFile(inputPath, videoBuffer);

    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpeg,
        [
          "-i", inputPath,
          "-vn",
          "-acodec", "libmp3lame",
          "-q:a", "4",
          outputPath,
          "-y",
        ],
        { timeout: 55000 },
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`ffmpeg error: ${stderr || error.message}`));
          } else {
            resolve();
          }
        }
      );
    });

    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Transcribe a video/audio file using OpenAI Whisper.
 * Always extracts audio first — video files are huge, audio is tiny.
 */
export async function transcribeVideo(
  fileBuffer: Buffer,
  filename: string
): Promise<string> {
  const extension = filename.split(".").pop()?.toLowerCase() || "";
  const audioExtensions = ["mp3", "m4a", "wav", "ogg", "flac"];

  let audioBuffer: Buffer;
  let audioFilename: string;

  if (
    audioExtensions.includes(extension) &&
    fileBuffer.length <= 25 * 1024 * 1024
  ) {
    audioBuffer = fileBuffer;
    audioFilename = filename;
  } else {
    audioBuffer = await extractAudio(fileBuffer, filename);
    audioFilename = filename.replace(/\.[^.]+$/, ".mp3");
  }

  const file = await toFile(audioBuffer, audioFilename);

  // Use verbose_json to get segments with no_speech probability.
  // This lets us filter out hallucinated text over music/silence.
  const transcription = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
    response_format: "verbose_json",
    temperature: 0,
  });

  // Filter out segments where Whisper is likely hallucinating (no real speech)
  const segments = (transcription as unknown as VerboseTranscription).segments || [];
  const realSpeech = segments
    .filter((seg) => seg.no_speech_prob < 0.5)
    .map((seg) => seg.text.trim())
    .join(" ");

  return realSpeech || transcription.text;
}

interface VerboseTranscription {
  text: string;
  segments: Array<{
    text: string;
    start: number;
    end: number;
    no_speech_prob: number;
  }>;
}
