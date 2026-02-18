import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const ensureDirectoryForFile = async (filePath: string) => {
  await mkdir(path.dirname(filePath), { recursive: true });
};

export const readJsonFile = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export const writeJsonFile = async <T>(filePath: string, value: T): Promise<void> => {
  await ensureDirectoryForFile(filePath);
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
};
