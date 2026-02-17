import OpenAI, { toFile } from "openai";
import { execFile } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath = require("ffmpeg-static") as string;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/**
 * Extract audio from a video file using ffmpeg.
 * Returns an mp3 buffer that's much smaller than the original video.
 */
async function extractAudio(videoBuffer: Buffer, filename: string): Promise<Buffer> {
  const id = randomUUID();
  const inputPath = join("/tmp", `${id}_${filename}`);
  const outputPath = join("/tmp", `${id}_audio.mp3`);

  try {
    // Write video to temp file
    await writeFile(inputPath, videoBuffer);

    // Extract audio with ffmpeg
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegPath as string,
        ["-i", inputPath, "-vn", "-acodec", "libmp3lame", "-q:a", "4", outputPath, "-y"],
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

    // Read the extracted audio
    return await readFile(outputPath);
  } finally {
    // Clean up temp files
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

  if (audioExtensions.includes(extension) && fileBuffer.length <= 25 * 1024 * 1024) {
    // Already an audio file and under 25MB — send directly
    audioBuffer = fileBuffer;
    audioFilename = filename;
  } else {
    // Video file or large audio — extract audio first
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
