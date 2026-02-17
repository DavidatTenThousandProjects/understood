import OpenAI, { toFile } from "openai";
import { execFile } from "child_process";
import { writeFile, readFile, unlink, chmod, access } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { constants } from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const FFMPEG_PATH = "/tmp/ffmpeg";
const FFMPEG_URL =
  "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";

/**
 * Download a static ffmpeg binary to /tmp if not already there.
 * Persists across warm invocations of the same serverless instance.
 */
async function ensureFfmpeg(): Promise<string> {
  try {
    await access(FFMPEG_PATH, constants.X_OK);
    return FFMPEG_PATH;
  } catch {
    // Download and extract
    await new Promise<void>((resolve, reject) => {
      execFile(
        "sh",
        [
          "-c",
          `curl -sL "${FFMPEG_URL}" | tar -xJ --strip-components=1 -C /tmp --wildcards "*/ffmpeg"`,
        ],
        { timeout: 30000 },
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`Failed to download ffmpeg: ${stderr || error.message}`));
          } else {
            resolve();
          }
        }
      );
    });

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

  const transcription = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });

  return transcription.text;
}
