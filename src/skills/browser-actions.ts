import { openMacApp } from "./mac-actions.js";

const normalizeUrl = (raw: string): string | null => {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  if (value.startsWith("antigravity://")) {
    return value;
  }
  return `https://${value}`;
};

export const openEmbeddedBrowserTab = async (rawUrl: string) => {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return { ok: false, message: "url is required" };
  }
  return {
    ok: true,
    message: "Embedded browser tab requested.",
    payload: {
      url,
    },
  };
};

export const openExternalChrome = async (rawUrl: string) => {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return { ok: false, message: "url is required" };
  }
  const result = await openMacApp("chrome", { url });
  return {
    ok: result.ok,
    message: result.message,
    payload: {
      url,
    },
  };
};
