import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { NextRequest, NextResponse } from "next/server";
import ffmpegPath from "ffmpeg-static";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class TranscodeError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  if (!ffmpegPath) {
    throw new TranscodeError(500, "No se encontró ffmpeg en el servidor");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "44100",
      "-ac",
      "1",
      outputPath,
    ]);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new TranscodeError(500, stderr.trim() || "No se pudo convertir el audio"));
    });
  });
}

export async function POST(request: NextRequest) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "udelx-audio-"));

  try {
    const formData = await request.formData();
    const uploaded = formData.get("file");
    if (!(uploaded instanceof File)) {
      throw new TranscodeError(400, "Archivo no válido");
    }

    const rawBaseName = uploaded.name.replace(/\.[^./\\]+$/, "") || `audio-${randomUUID()}`;
    const baseName = rawBaseName.replace(/[^a-zA-Z0-9._-]+/g, "_") || `audio-${randomUUID()}`;
    const inputPath = path.join(tempDir, `${randomUUID()}-input`);
    const outputPath = path.join(tempDir, `${baseName}.wav`);

    const inputBuffer = Buffer.from(await uploaded.arrayBuffer());
    await fs.writeFile(inputPath, inputBuffer);

    await runFfmpeg(inputPath, outputPath);

    const outputBuffer = await fs.readFile(outputPath);
    return new NextResponse(outputBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "X-Output-Filename": baseName,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof TranscodeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }

    console.error("Error transcodificando audio:", error);
    return NextResponse.json({ success: false, error: "No se pudo convertir el audio" }, { status: 500 });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
