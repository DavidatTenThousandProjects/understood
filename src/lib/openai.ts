import OpenAI, { toFile } from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/**
 * Transcribe a video/audio file using OpenAI Whisper.
 * Accepts a Buffer and filename (Whisper needs the extension to detect format).
 */
export async function transcribeVideo(
  fileBuffer: Buffer,
  filename: string
): Promise<string> {
  const file = await toFile(fileBuffer, filename);

  const transcription = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });

  return transcription.text;
}
