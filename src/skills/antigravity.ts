import { openMacApp } from "./mac-actions.js";

const normalizeMissionUrl = (raw: string): string | null => {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  if (value.startsWith("antigravity://")) {
    return value;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  return `antigravity://${value.replace(/^\//, "")}`;
};

export const openAntigravity = async () => {
  return openMacApp("antigravity");
};

export const openAntigravityMissionUrl = async (rawMissionUrl: string) => {
  const missionUrl = normalizeMissionUrl(rawMissionUrl);
  if (!missionUrl) {
    return {
      ok: false,
      message: "missionUrl is required",
    };
  }
  return openMacApp("antigravity", { url: missionUrl });
};
