import fs from "node:fs/promises";
import { swallowed } from "../logging/swallowed.js";

export async function unlinkIfExists(filePath: string | null | undefined): Promise<void> {
  if (!filePath) {
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    swallowed("Best-effort cleanup for temp files", err);
  }
}
