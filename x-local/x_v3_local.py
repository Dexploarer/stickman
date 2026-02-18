#!/usr/bin/env python3
"""Local X API parity CLI (no third-party API key).

Provides local equivalents for wrapper-style X endpoints:
- Auth/write: login, post, like/unlike, repost, profile updates, follow/unfollow, delete, DM, media post
- Read/search: user info/tweets/followers/followings, advanced search, tweet lookup, replies, quotes, retweeters, trends
- Feed/notifications: home timeline and notifications feed extraction
- Spaces: detail/listen/live listing
- Live streaming: start/status/stop RTMP streaming to X (via ffmpeg) and live tweet feed streaming
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


VALID_BROWSERS = {"chrome", "chromium", "edge"}
X_HOSTS = ("x.com", "twitter.com")


class CliError(Exception):
  """Expected failure with user-actionable message."""


@dataclass
class CommandResult:
  ok: bool
  endpoint: str
  data: dict[str, Any]
  error: str | None = None

  def to_payload(self) -> dict[str, Any]:
    payload: dict[str, Any] = {
      "ok": self.ok,
      "endpoint": self.endpoint,
      "data": self.data,
    }
    if self.error:
      payload["error"] = self.error
    return payload


def _normalize_handle(value: str | None) -> str:
  handle = (value or "").strip()
  return handle[1:] if handle.startswith("@") else handle


def _state_dir() -> Path:
  root = Path(__file__).resolve().parent / ".state"
  root.mkdir(parents=True, exist_ok=True)
  return root


def _stream_pid_file() -> Path:
  return _state_dir() / "x_stream.pid"


def _stream_meta_file() -> Path:
  return _state_dir() / "x_stream.json"


def _stream_log_file() -> Path:
  return _state_dir() / "x_stream.log"


def _session_cookie_file() -> Path:
  return _state_dir() / "x_session_cookies.json"


def _load_saved_session_cookies() -> list[dict[str, Any]]:
  path = _session_cookie_file()
  if not path.exists():
    return []
  try:
    raw = json.loads(path.read_text(encoding="utf-8"))
  except Exception:
    return []
  if not isinstance(raw, list):
    return []
  cookies: list[dict[str, Any]] = []
  for item in raw:
    if not isinstance(item, dict):
      continue
    domain = str(item.get("domain") or "")
    name = str(item.get("name") or "")
    value = str(item.get("value") or "")
    if not name or not value or not any(host in domain for host in X_HOSTS):
      continue
    cookies.append(item)
  return cookies


def _save_session_cookies(context: Any) -> int:
  try:
    raw = context.cookies()
  except Exception:
    return 0
  if not isinstance(raw, list):
    return 0
  out: list[dict[str, Any]] = []
  for item in raw:
    if not isinstance(item, dict):
      continue
    domain = str(item.get("domain") or "")
    if not any(host in domain for host in X_HOSTS):
      continue
    name = str(item.get("name") or "")
    value = str(item.get("value") or "")
    if not name or not value:
      continue
    out.append(item)
  _session_cookie_file().write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
  return len(out)


def _merge_cookie_sets(primary: list[dict[str, Any]], secondary: list[dict[str, Any]]) -> list[dict[str, Any]]:
  by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
  # Keep primary values authoritative (fresh browser cookies should override saved session cookies).
  for src in secondary + primary:
    domain = str(src.get("domain") or "")
    name = str(src.get("name") or "")
    path = str(src.get("path") or "/")
    if not domain or not name:
      continue
    by_key[(domain, name, path)] = src
  return list(by_key.values())


def _arg_value(args: argparse.Namespace, *names: str) -> str:
  for name in names:
    value = getattr(args, name, None)
    if isinstance(value, str) and value.strip():
      return value.strip()
  return ""


def _format_aisa_response(
  ok: bool,
  endpoint: str,
  data: dict[str, Any],
  error: str | None,
  args: argparse.Namespace,
) -> dict[str, Any]:
  if not ok:
    return {
      "error": {
        "code": "",
        "message": error or "Unknown error",
        "type": "new_api_error",
      }
    }

  request_echo: dict[str, Any] = {}
  user_name = _arg_value(args, "user_name", "username")
  if endpoint in {"user_login_v3", "refresh_login_v3", "get_my_x_account_detail_v3"} and user_name:
    request_echo["user_name"] = user_name
  if endpoint in {"send_tweet_v3", "create_tweet_v2"}:
    if user_name:
      request_echo["user_name"] = user_name
    text = _arg_value(args, "text")
    if text:
      request_echo["text"] = text
  if endpoint in {"like_tweet_v3", "like_tweet_v2", "unlike_tweet_v2", "retweet_v3", "retweet_tweet_v2", "delete_tweet_v2"}:
    if user_name:
      request_echo["user_name"] = user_name
    tweet_id = _arg_value(args, "tweet_id")
    if tweet_id:
      request_echo["tweet_id"] = tweet_id
  if endpoint in {"update_profile_v3", "update_profile_v2"}:
    if user_name:
      request_echo["user_name"] = user_name
    name = _arg_value(args, "name")
    bio = _arg_value(args, "bio")
    if name:
      request_echo["name"] = name
    if bio:
      request_echo["bio"] = bio

  response: dict[str, Any] = {
    "success": True,
    "endpoint": endpoint,
    "data": data,
  }
  if request_echo:
    response["request"] = request_echo
  return response


def _render_output(result: CommandResult, args: argparse.Namespace) -> str:
  compat = getattr(args, "compat_provider", "none")
  if compat == "aisa":
    payload = _format_aisa_response(
      ok=result.ok,
      endpoint=result.endpoint,
      data=result.data,
      error=result.error,
      args=args,
    )
  else:
    payload = result.to_payload()
  return json.dumps(payload, ensure_ascii=False)


def _resolve_cookie_file(
  browser: str,
  chrome_profile: str | None,
  profile_name: str,
) -> str | None:
  if not chrome_profile:
    return None
  root = Path(chrome_profile).expanduser()
  if root.is_file():
    return str(root)
  candidates = [
    root / profile_name / "Cookies",
    root / "Default" / "Cookies",
    root / "Cookies",
  ]
  for candidate in candidates:
    if candidate.exists():
      return str(candidate)
  raise CliError(f"Could not locate Cookies DB under {root} for browser={browser}.")


def _load_x_cookies(
  browser: str,
  chrome_profile: str | None,
  profile_name: str,
) -> list[dict[str, Any]]:
  try:
    import browser_cookie3 as bc3  # type: ignore
  except Exception as err:
    raise CliError("browser_cookie3 is required. Run setup_env.sh first.") from err

  loader = {
    "chrome": bc3.chrome,
    "chromium": bc3.chromium,
    "edge": bc3.edge,
  }.get(browser)
  if loader is None:
    raise CliError(f"Unsupported browser: {browser}")

  cookie_file = _resolve_cookie_file(browser, chrome_profile, profile_name)
  kwargs: dict[str, Any] = {"domain_name": "x.com"}
  if cookie_file:
    kwargs["cookie_file"] = cookie_file

  try:
    jar = loader(**kwargs)
  except Exception as err:
    raise CliError(f"Failed loading browser cookies ({browser}): {err}") from err

  cookies: list[dict[str, Any]] = []
  for cookie in jar:
    domain = getattr(cookie, "domain", "") or ""
    if not any(host in domain for host in X_HOSTS):
      continue
    name = getattr(cookie, "name", "") or ""
    value = getattr(cookie, "value", "") or ""
    if not name or not value:
      continue
    out: dict[str, Any] = {
      "name": name,
      "value": value,
      "domain": domain,
      "path": getattr(cookie, "path", "/") or "/",
      "secure": bool(getattr(cookie, "secure", True)),
      "httpOnly": False,
    }
    expires = getattr(cookie, "expires", None)
    if isinstance(expires, (int, float)) and expires > 0:
      out["expires"] = int(expires)
    cookies.append(out)

  if not cookies:
    raise CliError("No X/Twitter cookies found. Ensure browser profile is logged in.")
  return cookies


def _send_webhook_notification(webhook_url: str, payload: dict[str, Any]) -> None:
  req = urllib.request.Request(
    webhook_url,
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
  )
  with urllib.request.urlopen(req, timeout=10):
    return


def _send_local_notification(title: str, message: str) -> None:
  system = platform.system().lower()
  if system == "darwin":
    script = f'display notification "{message}" with title "{title}"'
    subprocess.run(["osascript", "-e", script], check=False)
    return
  if system == "linux":
    subprocess.run(["notify-send", title, message], check=False)
    return
  if system == "windows":
    ps = (
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;"
      "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;"
      '$xml.LoadXml("<toast><visual><binding template=\\"ToastGeneric\\"><text>'
      + title
      + "</text><text>"
      + message
      + "</text></binding></visual></toast>\");"
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml);"
      '$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("PromptOrDie");'
      "$notifier.Show($toast);"
    )
    subprocess.run(["powershell", "-Command", ps], check=False)


def _notify(args: argparse.Namespace, ok: bool, endpoint: str, detail: str) -> None:
  title = "Prompt or Die X Local"
  status = "OK" if ok else "FAIL"
  message = f"{endpoint}: {status} - {detail}"
  if args.notify:
    try:
      _send_local_notification(title, message)
    except Exception:
      pass
  if args.notify_webhook:
    payload = {
      "source": "prompt-or-die-social-composer",
      "endpoint": endpoint,
      "ok": ok,
      "detail": detail,
      "status": status,
    }
    try:
      _send_webhook_notification(args.notify_webhook, payload)
    except Exception:
      pass


def _visible_first(page: Any, selectors: list[str]) -> Any:
  for selector in selectors:
    locator = page.locator(selector)
    try:
      if locator.count() > 0 and locator.first.is_visible():
        return locator.first
    except Exception:
      continue
  return None


def _click_first(page: Any, selectors: list[str]) -> bool:
  element = _visible_first(page, selectors)
  if not element:
    return False
  try:
    if element.is_enabled():
      element.click()
      return True
  except Exception:
    return False
  return False


def _extract_handle_from_nav(page: Any) -> str | None:
  script = """
() => {
  const profileLink = document.querySelector("a[data-testid='AppTabBar_Profile_Link']");
  if (!profileLink) return null;
  const href = profileLink.getAttribute("href") || "";
  if (!href.startsWith("/")) return null;
  const handle = href.slice(1).split("/")[0];
  return handle || null;
}
"""
  try:
    result = page.evaluate(script)
  except Exception:
    return None
  if isinstance(result, str) and result.strip():
    return result.strip()
  return None


def _extract_profile_summary(page: Any, handle: str) -> dict[str, Any]:
  script = """
() => {
  const nameEl = document.querySelector("[data-testid='UserName'] span");
  const bioEl = document.querySelector("[data-testid='UserDescription']");
  const followersEl = document.querySelector("a[href*='/verified_followers'] span");
  const followingEl = document.querySelector("a[href*='/following'] span");
  return {
    display_name: nameEl?.textContent?.trim() || null,
    bio: bioEl?.textContent?.trim() || "",
    followers: followersEl?.textContent?.trim() || null,
    following: followingEl?.textContent?.trim() || null
  };
}
"""
  raw = page.evaluate(script)
  if not isinstance(raw, dict):
    raw = {}
  return {
    "handle": handle,
    "profile_url": f"https://x.com/{handle}",
    "display_name": raw.get("display_name"),
    "bio": raw.get("bio"),
    "followers": raw.get("followers"),
    "following": raw.get("following"),
  }


def _extract_tweets(page: Any) -> list[dict[str, Any]]:
  script = """
() => {
  const out = [];
  const cards = document.querySelectorAll("article[data-testid='tweet']");
  cards.forEach((card, idx) => {
    const link = card.querySelector("a[href*='/status/']");
    const href = link?.getAttribute("href") || "";
    const match = href.match(/status\\/(\\d+)/);
    const tweetId = match ? match[1] : null;
    const text = card.querySelector("[data-testid='tweetText']")?.innerText?.trim() || "";
    const userLink = card.querySelector("div[data-testid='User-Name'] a[href^='/']");
    const authorHref = userLink?.getAttribute("href") || "";
    const author = authorHref.startsWith("/") ? authorHref.slice(1).split("/")[0] : null;
    const time = card.querySelector("time")?.getAttribute("datetime") || null;
    const socialContext = card.querySelector("[data-testid='socialContext']")?.innerText?.trim() || "";
    const imageUrls = Array.from(card.querySelectorAll("img"))
      .map((img) => (img.getAttribute("src") || "").trim())
      .filter((src) => src.includes("twimg.com/media"));
    const videoPosters = Array.from(card.querySelectorAll("video"))
      .map((video) => (video.getAttribute("poster") || "").trim())
      .filter(Boolean);
    const mediaUrls = Array.from(new Set([...imageUrls, ...videoPosters]));
    const hasVideo = card.querySelectorAll("video").length > 0;
    const mediaCount = mediaUrls.length + (hasVideo ? 1 : 0);
    const isRepostHint =
      socialContext.toLowerCase().includes("reposted") ||
      socialContext.toLowerCase().includes("retweeted");
    out.push({
      key: tweetId || href || `idx-${idx}`,
      tweet_id: tweetId,
      text,
      author,
      url: href ? `https://x.com${href}` : null,
      timestamp: time,
      social_context: socialContext || null,
      image_urls: imageUrls,
      media_urls: mediaUrls,
      has_video: hasVideo,
      has_media: mediaCount > 0,
      media_count: mediaCount,
      is_repost_hint: isRepostHint
    });
  });
  return out;
}
"""
  raw = page.evaluate(script)
  if not isinstance(raw, list):
    return []
  return [row for row in raw if isinstance(row, dict)]


def _extract_notifications(page: Any) -> list[dict[str, Any]]:
  script = """
() => {
  const out = [];

  const tweets = Array.from(document.querySelectorAll("article[data-testid='tweet']"));
  tweets.forEach((card, idx) => {
    const text = card.querySelector("[data-testid='tweetText']")?.innerText?.trim() || "";
    const link = card.querySelector("a[href*='/status/']");
    const href = link?.getAttribute("href") || "";
    const match = href.match(/status\\/(\\d+)/);
    const tweetId = match ? match[1] : null;
    const actorLink = card.querySelector("div[data-testid='User-Name'] a[href^='/']");
    const actorHref = actorLink?.getAttribute("href") || "";
    const actor = actorHref.startsWith("/") ? actorHref.slice(1).split("/")[0] : null;
    const socialContext = card.querySelector("[data-testid='socialContext']")?.innerText?.trim() || "";
    const time = card.querySelector("time")?.getAttribute("datetime") || null;
    out.push({
      key: tweetId || href || `tweet-${idx}`,
      type: "tweet",
      actor,
      social_context: socialContext || null,
      tweet_id: tweetId,
      text,
      url: href ? `https://x.com${href}` : null,
      timestamp: time,
    });
  });

  const cards = Array.from(document.querySelectorAll("div[data-testid='cellInnerDiv']"));
  cards.forEach((node, idx) => {
    const text = (node.innerText || "").replace(/\\s+/g, " ").trim();
    if (!text) return;
    const link = node.querySelector("a[href^='/']");
    const href = link?.getAttribute("href") || "";
    const actor = href.startsWith("/") ? href.slice(1).split("/")[0] : null;
    out.push({
      key: `card-${idx}-${href || text.slice(0, 24)}`,
      type: "notification_card",
      actor,
      text: text.slice(0, 500),
      url: href ? `https://x.com${href}` : null,
      timestamp: null,
    });
  });

  return out;
}
"""
  raw = page.evaluate(script)
  if not isinstance(raw, list):
    return []
  unique: dict[str, dict[str, Any]] = {}
  for row in raw:
    if not isinstance(row, dict):
      continue
    key = str(row.get("key") or "")
    if not key:
      continue
    if key not in unique:
      unique[key] = row
  return list(unique.values())


def _extract_users(page: Any) -> list[dict[str, Any]]:
  script = """
() => {
  const out = [];
  const cards = document.querySelectorAll("div[data-testid='UserCell']");
  cards.forEach((card, idx) => {
    const links = Array.from(card.querySelectorAll("a[href^='/']"));
    let handle = null;
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (!href || href.startsWith("/i/")) continue;
      const candidate = href.slice(1).split("/")[0];
      if (candidate && !candidate.includes("?")) {
        handle = candidate;
        break;
      }
    }
    const display = card.querySelector("div[dir='ltr'] span")?.textContent?.trim() || null;
    const bio = card.querySelector("[data-testid='UserDescription']")?.innerText?.trim() || "";
    out.push({
      key: handle || `idx-${idx}`,
      handle,
      display_name: display,
      bio
    });
  });
  return out;
}
"""
  raw = page.evaluate(script)
  if not isinstance(raw, list):
    return []
  return [row for row in raw if isinstance(row, dict)]


def _extract_trends(page: Any) -> list[dict[str, Any]]:
  script = """
() => {
  const rows = [];
  const trendNodes = Array.from(document.querySelectorAll("div[data-testid='trend']"));
  trendNodes.forEach((node, idx) => {
    const lines = (node.innerText || "")
      .split("\\n")
      .map((v) => v.trim())
      .filter(Boolean);
    const topic = lines.find((x) => x.startsWith("#")) || lines[lines.length - 1] || null;
    rows.push({
      key: topic || `idx-${idx}`,
      rank: idx + 1,
      topic,
      lines
    });
  });
  return rows;
}
"""
  raw = page.evaluate(script)
  if not isinstance(raw, list):
    return []
  return [row for row in raw if isinstance(row, dict)]


def _extract_spaces(page: Any) -> list[dict[str, Any]]:
  script = """
() => {
  const out = [];
  const anchors = Array.from(document.querySelectorAll("a[href*='/i/spaces/']"));
  const seen = new Set();
  anchors.forEach((a, idx) => {
    const href = a.getAttribute("href") || "";
    const m = href.match(/\\/i\\/spaces\\/([a-zA-Z0-9]+)/);
    if (!m) return;
    const spaceId = m[1];
    if (seen.has(spaceId)) return;
    seen.add(spaceId);
    const card = a.closest("article,div");
    const text = (card?.innerText || a.innerText || "").split("\\n").map(v => v.trim()).filter(Boolean);
    out.push({
      key: spaceId,
      space_id: spaceId,
      url: `https://x.com/i/spaces/${spaceId}`,
      lines: text.slice(0, 8),
      title: text[0] || null
    });
  });
  return out;
}
"""
  raw = page.evaluate(script)
  if not isinstance(raw, list):
    return []
  return [row for row in raw if isinstance(row, dict)]


def _extract_space_detail(page: Any, space_id: str) -> dict[str, Any]:
  script = """
() => {
  const ogTitle = document.querySelector("meta[property='og:title']")?.getAttribute("content") || null;
  const ogDesc = document.querySelector("meta[property='og:description']")?.getAttribute("content") || null;
  const titleNode = document.querySelector("h1, h2");
  const title = titleNode?.textContent?.trim() || ogTitle;
  const body = (document.body?.innerText || "").split("\\n").map(v => v.trim()).filter(Boolean);
  return {
    title,
    description: ogDesc,
    lines: body.slice(0, 30)
  };
}
"""
  raw = page.evaluate(script)
  if not isinstance(raw, dict):
    raw = {}
  return {
    "space_id": space_id,
    "url": f"https://x.com/i/spaces/{space_id}",
    "title": raw.get("title"),
    "description": raw.get("description"),
    "lines": raw.get("lines") if isinstance(raw.get("lines"), list) else [],
  }


def _collect_with_scroll(
  page: Any,
  extractor,
  limit: int,
  max_scrolls: int = 14,
  pause_ms: int = 750,
) -> list[dict[str, Any]]:
  seen: dict[str, dict[str, Any]] = {}
  for _ in range(max_scrolls):
    rows = extractor(page)
    for row in rows:
      key = str(row.get("key") or "")
      if not key:
        continue
      if key not in seen:
        seen[key] = row
    if len(seen) >= limit:
      break
    page.mouse.wheel(0, 2200)
    page.wait_for_timeout(pause_ms)
  return list(seen.values())[:limit]


def _is_logged_in(page: Any) -> bool:
  page.goto("https://x.com/home", wait_until="domcontentloaded")
  url = (page.url or "").lower()
  if "login" in url or "/i/flow" in url:
    return False
  page.wait_for_timeout(1200)
  markers = [
    "[data-testid='SideNav_NewTweet_Button']",
    "a[data-testid='AppTabBar_Profile_Link']",
    "a[href='/home'][aria-label='Home']",
  ]
  if _visible_first(page, markers) is not None:
    return True
  try:
    names = {str(cookie.get("name") or "") for cookie in page.context.cookies("https://x.com")}
  except Exception:
    names = set()
  return "auth_token" in names and ("ct0" in names or "twid" in names)


def _require_logged_in(page: Any) -> None:
  if not _is_logged_in(page):
    raise CliError("Session is not logged in.")


def _attempt_flow_login(page: Any, username: str, password: str, email: str | None) -> dict[str, Any]:
  page.goto("https://x.com/i/flow/login", wait_until="domcontentloaded")
  user_input = _visible_first(page, ["input[name='text']", "input[autocomplete='username']"])
  if not user_input:
    raise CliError("Login input not found.")
  user_input.fill(username)
  user_input.press("Enter")
  page.wait_for_timeout(1200)

  pwd_input = _visible_first(page, ["input[name='password']", "input[type='password']"])
  if not pwd_input:
    challenge = _visible_first(page, ["input[name='text']", "input[autocomplete='username']"])
    if challenge and email:
      challenge.fill(email)
      challenge.press("Enter")
      page.wait_for_timeout(1200)
      pwd_input = _visible_first(page, ["input[name='password']", "input[type='password']"])

  if not pwd_input:
    return {
      "logged_in": False,
      "status": "pending_verification",
      "message": "Additional challenge detected. Complete it in browser and rerun.",
    }

  pwd_input.fill(password)
  pwd_input.press("Enter")
  page.wait_for_timeout(2200)
  return {"logged_in": _is_logged_in(page), "status": "ok"}


def _with_page(
  args: argparse.Namespace,
  require_session: bool = True,
  allow_browser_cookies: bool = True,
  allow_saved_session: bool = True,
):
  try:
    from playwright.sync_api import sync_playwright  # type: ignore
  except Exception as err:
    raise CliError("playwright is required. Run setup_env.sh first.") from err

  browser_cookies: list[dict[str, Any]] = []
  saved_cookies: list[dict[str, Any]] = []
  load_error: CliError | None = None

  if allow_browser_cookies:
    try:
      browser_cookies = _load_x_cookies(args.browser, args.chrome_profile, args.chrome_profile_name)
    except CliError as err:
      load_error = err

  if allow_saved_session:
    saved_cookies = _load_saved_session_cookies()

  # Prefer fresh browser cookies; only fall back to saved session cookies when browser cookies are unavailable.
  if browser_cookies:
    cookies = browser_cookies
  else:
    cookies = saved_cookies
  if require_session and not cookies:
    if load_error:
      raise load_error
    raise CliError("No local session cookies found. Run user_login_v3 --refresh first.")

  p = sync_playwright().start()
  browser = p.chromium.launch(headless=not args.visible)
  context = browser.new_context()
  if cookies:
    context.add_cookies(cookies)
  page = context.new_page()
  return p, browser, context, page


def _post_from_compose(page: Any, text: str, media_path: str | None = None) -> dict[str, Any]:
  page.goto("https://x.com/compose/post", wait_until="domcontentloaded")
  editor = _visible_first(
    page,
    [
      "div[contenteditable='true'][data-testid='tweetTextarea_0']",
      "div[contenteditable='true']",
      "[data-testid='tweetTextarea_0']",
    ],
  )
  if not editor:
    raise CliError("Could not find post editor.")
  if text:
    editor.fill(text)

  if media_path:
    file_input = _visible_first(page, ["input[data-testid='fileInput']", "input[type='file']"])
    if not file_input:
      raise CliError("Could not find media upload input.")
    resolved = str(Path(media_path).expanduser().resolve())
    if not Path(resolved).exists():
      raise CliError(f"Media file not found: {resolved}")
    file_input.set_input_files(resolved)
    page.wait_for_timeout(800)

  if not _click_first(
    page,
    [
      "button[data-testid='tweetButton']",
      "button[data-testid='tweetButtonInline']",
      "button:has-text('Post')",
    ],
  ):
    raise CliError("Could not press Post.")

  page.wait_for_timeout(1200)
  return {"submitted": True, "text": text, "media_path": media_path}


def _run_user_login_v3(args: argparse.Namespace) -> dict[str, Any]:
  refresh = bool(getattr(args, "refresh", False))
  username = _arg_value(args, "username", "user_name")
  password = _arg_value(args, "password")
  email = _arg_value(args, "email")
  p, browser, context, page = _with_page(
    args,
    require_session=False,
    allow_browser_cookies=not refresh,
    allow_saved_session=not refresh,
  )
  try:
    if refresh:
      if not username or not password:
        raise CliError("--refresh requires --username/--user-name and --password.")
      login_result = _attempt_flow_login(page, username, password, email or None)
      logged_in = bool(login_result.get("logged_in"))
      saved = _save_session_cookies(context) if logged_in else 0
      login_result["refreshed"] = logged_in
      login_result["session_cookies_saved"] = saved
      if username:
        login_result["user_name"] = username
      return login_result

    if _is_logged_in(page):
      saved = _save_session_cookies(context)
      payload = {"logged_in": True, "status": "ok", "method": "cookies", "session_cookies_saved": saved}
      if username:
        payload["user_name"] = username
      return payload

    if not username or not password:
      return {
        "logged_in": False,
        "status": "needs_credentials",
        "message": "No active X session detected in local browser/profile. Set browser/profile args to your logged-in Chrome profile or provide username/password for refresh login.",
      }
    login_result = _attempt_flow_login(page, username, password, email or None)
    logged_in = bool(login_result.get("logged_in"))
    saved = _save_session_cookies(context) if logged_in else 0
    login_result["session_cookies_saved"] = saved
    login_result["user_name"] = username
    return login_result
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_get_my_x_account_detail_v3(args: argparse.Namespace) -> dict[str, Any]:
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    handle = _normalize_handle(_arg_value(args, "user_name", "username")) or _extract_handle_from_nav(page)
    if not handle:
      raise CliError("Could not resolve account handle from current session.")
    page.goto(f"https://x.com/{handle}", wait_until="domcontentloaded")
    page.wait_for_timeout(700)
    return _extract_profile_summary(page, handle)
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_send_tweet_v3(args: argparse.Namespace) -> dict[str, Any]:
  text = (args.text or "").strip()
  if not text:
    raise CliError("--text is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    return _post_from_compose(page, text)
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_create_tweet_v2(args: argparse.Namespace) -> dict[str, Any]:
  return _run_send_tweet_v3(args)


def _run_upload_media_v2(args: argparse.Namespace) -> dict[str, Any]:
  media_path = (args.media_path or "").strip()
  text = (args.text or "").strip()
  if not media_path:
    raise CliError("--media-path is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    return _post_from_compose(page, text=text, media_path=media_path)
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_like_tweet_v3(args: argparse.Namespace) -> dict[str, Any]:
  tweet_id = (args.tweet_id or "").strip()
  if not tweet_id:
    raise CliError("--tweet-id is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/i/web/status/{tweet_id}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    if _visible_first(page, ["button[data-testid='unlike']"]):
      return {"tweet_id": tweet_id, "liked": True, "already_liked": True}
    if not _click_first(page, ["button[data-testid='like']"]):
      raise CliError("Could not find Like button.")
    page.wait_for_timeout(650)
    return {
      "tweet_id": tweet_id,
      "liked": _visible_first(page, ["button[data-testid='unlike']"]) is not None,
      "already_liked": False,
    }
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_unlike_tweet_v2(args: argparse.Namespace) -> dict[str, Any]:
  tweet_id = (args.tweet_id or "").strip()
  if not tweet_id:
    raise CliError("--tweet-id is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/i/web/status/{tweet_id}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    if _visible_first(page, ["button[data-testid='like']"]):
      return {"tweet_id": tweet_id, "liked": False, "already_unliked": True}
    if not _click_first(page, ["button[data-testid='unlike']"]):
      raise CliError("Could not find Unlike button.")
    page.wait_for_timeout(650)
    return {
      "tweet_id": tweet_id,
      "liked": _visible_first(page, ["button[data-testid='unlike']"]) is not None,
      "already_unliked": False,
    }
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_retweet_v3(args: argparse.Namespace) -> dict[str, Any]:
  tweet_id = (args.tweet_id or "").strip()
  if not tweet_id:
    raise CliError("--tweet-id is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/i/web/status/{tweet_id}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    if _visible_first(page, ["button[data-testid='unretweet']"]):
      return {"tweet_id": tweet_id, "retweeted": True, "already_retweeted": True}
    if not _click_first(page, ["button[data-testid='retweet']"]):
      raise CliError("Could not find Repost button.")
    page.wait_for_timeout(300)
    if not _click_first(page, ["div[data-testid='retweetConfirm']", "button:has-text('Repost')"]):
      raise CliError("Could not confirm repost.")
    page.wait_for_timeout(650)
    return {
      "tweet_id": tweet_id,
      "retweeted": _visible_first(page, ["button[data-testid='unretweet']"]) is not None,
      "already_retweeted": False,
    }
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_delete_tweet_v2(args: argparse.Namespace) -> dict[str, Any]:
  tweet_id = (args.tweet_id or "").strip()
  if not tweet_id:
    raise CliError("--tweet-id is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/i/web/status/{tweet_id}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    if not _click_first(page, ["button[data-testid='caret']", "button:has-text('More')"]):
      raise CliError("Could not open tweet menu.")
    page.wait_for_timeout(350)
    if not _click_first(page, ["div[role='menuitem']:has-text('Delete')", "div[role='menuitem']:has-text('Delete post')"]):
      raise CliError("Could not find Delete in menu.")
    page.wait_for_timeout(300)
    if not _click_first(page, ["button:has-text('Delete')", "div[role='button']:has-text('Delete')"]):
      raise CliError("Could not confirm delete.")
    page.wait_for_timeout(900)
    return {"tweet_id": tweet_id, "deleted": True}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_follow_user_v2(args: argparse.Namespace) -> dict[str, Any]:
  username = _normalize_handle(args.username)
  if not username:
    raise CliError("--username is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/{username}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    if _visible_first(page, ["button:has-text('Following')", "button:has-text('Unfollow')"]):
      return {"username": username, "following": True, "already_following": True}
    if not _click_first(page, ["button:has-text('Follow')", "div[role='button']:has-text('Follow')"]):
      raise CliError("Could not find Follow button.")
    page.wait_for_timeout(750)
    return {
      "username": username,
      "following": _visible_first(page, ["button:has-text('Following')", "button:has-text('Unfollow')"]) is not None,
      "already_following": False,
    }
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_unfollow_user_v2(args: argparse.Namespace) -> dict[str, Any]:
  username = _normalize_handle(args.username)
  if not username:
    raise CliError("--username is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/{username}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    if _visible_first(page, ["button:has-text('Follow')"]):
      return {"username": username, "following": False, "already_unfollowed": True}
    if not _click_first(page, ["button:has-text('Following')", "button:has-text('Unfollow')"]):
      raise CliError("Could not find Following button.")
    page.wait_for_timeout(300)
    _click_first(page, ["button:has-text('Unfollow')", "div[role='button']:has-text('Unfollow')"])
    page.wait_for_timeout(700)
    return {
      "username": username,
      "following": _visible_first(page, ["button:has-text('Following')", "button:has-text('Unfollow')"]) is not None,
      "already_unfollowed": False,
    }
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_send_dm_to_user(args: argparse.Namespace) -> dict[str, Any]:
  username = _normalize_handle(args.username)
  text = (args.text or "").strip()
  if not username:
    raise CliError("--username is required.")
  if not text:
    raise CliError("--text is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/{username}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    if not _click_first(page, ["button[data-testid='sendDMFromProfile']", "button:has-text('Message')"]):
      raise CliError("Could not find Message button on profile.")
    page.wait_for_timeout(800)
    editor = _visible_first(page, ["div[data-testid='dmComposerTextInput'] div[contenteditable='true']", "div[contenteditable='true']"])
    if not editor:
      raise CliError("Could not find DM input.")
    editor.fill(text)
    if not _click_first(page, ["button[data-testid='dmComposerSendButton']", "button:has-text('Send')"]):
      raise CliError("Could not send DM.")
    page.wait_for_timeout(600)
    return {"username": username, "sent": True, "text": text}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_update_profile_v3(args: argparse.Namespace) -> dict[str, Any]:
  if not args.name and not args.bio:
    raise CliError("Provide --name and/or --bio.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto("https://x.com/settings/profile", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    updated_fields: list[str] = []

    if args.name:
      name_input = _visible_first(
        page,
        [
          "input[name='displayName']",
          "input[aria-label='Name']",
          "input[data-testid='Profile_Name_Input']",
        ],
      )
      if not name_input:
        raise CliError("Could not find profile name field.")
      name_input.fill(args.name)
      updated_fields.append("name")

    if args.bio:
      bio_input = _visible_first(
        page,
        [
          "textarea[name='description']",
          "textarea[aria-label='Bio']",
          "textarea[data-testid='Profile_Bio_Input']",
        ],
      )
      if not bio_input:
        raise CliError("Could not find profile bio field.")
      bio_input.fill(args.bio)
      updated_fields.append("bio")

    if not _click_first(
      page,
      [
        "div[data-testid='Profile_Save_Button']",
        "button[data-testid='Profile_Save_Button']",
        "button:has-text('Save')",
      ],
    ):
      raise CliError("Could not find Save button on profile settings.")
    page.wait_for_timeout(1000)
    return {"updated": True, "fields": updated_fields}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_update_media_profile(args: argparse.Namespace, mode: str) -> dict[str, Any]:
  path_value = (args.file_path or "").strip()
  if not path_value:
    raise CliError("--file-path is required.")
  resolved = Path(path_value).expanduser().resolve()
  if not resolved.exists():
    raise CliError(f"File not found: {resolved}")

  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto("https://x.com/settings/profile", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    inputs = page.locator("input[type='file']")
    count = inputs.count()
    if count <= 0:
      raise CliError("Could not find profile file upload input.")
    target_idx = 0 if mode == "avatar" else (1 if count > 1 else 0)
    inputs.nth(target_idx).set_input_files(str(resolved))
    page.wait_for_timeout(900)
    _click_first(page, ["button:has-text('Apply')", "button:has-text('Save')", "div[data-testid='Profile_Save_Button']"])
    page.wait_for_timeout(900)
    return {"updated": True, "mode": mode, "file_path": str(resolved)}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_user_info(args: argparse.Namespace) -> dict[str, Any]:
  username = _normalize_handle(args.username)
  if not username:
    raise CliError("--username is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/{username}", wait_until="domcontentloaded")
    page.wait_for_timeout(700)
    return _extract_profile_summary(page, username)
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_user_last_tweets(args: argparse.Namespace) -> dict[str, Any]:
  username = _normalize_handle(args.username)
  if not username:
    raise CliError("--username is required.")
  limit = max(1, min(args.limit, 200))
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/{username}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    tweets = _collect_with_scroll(page, _extract_tweets, limit)
    return {"username": username, "count": len(tweets), "tweets": tweets}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_home_timeline(args: argparse.Namespace) -> dict[str, Any]:
  limit = max(1, min(args.limit, 200))
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto("https://x.com/home", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    tweets = _collect_with_scroll(page, _extract_tweets, limit, max_scrolls=20)
    return {"count": len(tweets), "tweets": tweets}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_notifications_list(args: argparse.Namespace) -> dict[str, Any]:
  limit = max(1, min(args.limit, 300))
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto("https://x.com/notifications", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    rows = _collect_with_scroll(page, _extract_notifications, limit, max_scrolls=16)
    return {"count": len(rows), "notifications": rows}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_user_connections(args: argparse.Namespace, mode: str) -> dict[str, Any]:
  username = _normalize_handle(args.username)
  if not username:
    raise CliError("--username is required.")
  limit = max(1, min(args.limit, 500))
  suffix = "followers" if mode == "followers" else "following"
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/{username}/{suffix}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    users = _collect_with_scroll(page, _extract_users, limit, max_scrolls=18)
    return {"username": username, "mode": mode, "count": len(users), "users": users}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_search_user(args: argparse.Namespace) -> dict[str, Any]:
  keyword = (args.keyword or "").strip()
  if not keyword:
    raise CliError("--keyword is required.")
  limit = max(1, min(args.limit, 200))
  encoded = urllib.parse.quote(keyword)
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/search?q={encoded}&src=typed_query&f=user", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    users = _collect_with_scroll(page, _extract_users, limit, max_scrolls=16)
    return {"keyword": keyword, "count": len(users), "users": users}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_advanced_search(args: argparse.Namespace) -> dict[str, Any]:
  query = (args.query or "").strip()
  if not query:
    raise CliError("--query is required.")
  limit = max(1, min(args.limit, 200))
  tab = (args.tab or "latest").strip().lower()
  if tab not in {"top", "latest"}:
    raise CliError("--tab must be one of: top, latest")
  encoded = urllib.parse.quote(query)
  f_param = "live" if tab == "latest" else "top"
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/search?q={encoded}&src=typed_query&f={f_param}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    tweets = _collect_with_scroll(page, _extract_tweets, limit, max_scrolls=18)
    return {"query": query, "tab": tab, "count": len(tweets), "tweets": tweets}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_get_tweet_by_ids(args: argparse.Namespace) -> dict[str, Any]:
  ids: list[str] = []
  if args.tweet_ids:
    ids.extend([item.strip() for item in args.tweet_ids.split(",") if item.strip()])
  if args.tweet_id:
    ids.extend([item.strip() for item in args.tweet_id if item.strip()])
  unique: list[str] = []
  seen = set()
  for item in ids:
    if item in seen:
      continue
    seen.add(item)
    unique.append(item)
  if not unique:
    raise CliError("Provide --tweet-ids or --tweet-id.")

  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    tweets: list[dict[str, Any]] = []
    for tweet_id in unique:
      page.goto(f"https://x.com/i/web/status/{tweet_id}", wait_until="domcontentloaded")
      page.wait_for_timeout(800)
      rows = _extract_tweets(page)
      exact = next((row for row in rows if str(row.get("tweet_id")) == tweet_id), None)
      tweets.append({"requested_tweet_id": tweet_id, "tweet": exact or (rows[0] if rows else None)})
    return {"count": len(tweets), "tweets": tweets}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_tweet_replies(args: argparse.Namespace) -> dict[str, Any]:
  tweet_id = (args.tweet_id or "").strip()
  if not tweet_id:
    raise CliError("--tweet-id is required.")
  limit = max(1, min(args.limit, 200))
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/i/web/status/{tweet_id}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    tweets = _collect_with_scroll(page, _extract_tweets, limit + 2, max_scrolls=18)
    replies = [row for row in tweets if str(row.get("tweet_id") or "") != tweet_id][:limit]
    return {"tweet_id": tweet_id, "count": len(replies), "replies": replies}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_tweet_quotes(args: argparse.Namespace) -> dict[str, Any]:
  tweet_id = (args.tweet_id or "").strip()
  if not tweet_id:
    raise CliError("--tweet-id is required.")
  limit = max(1, min(args.limit, 200))
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/i/web/status/{tweet_id}/quotes", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    quotes = _collect_with_scroll(page, _extract_tweets, limit, max_scrolls=18)
    return {"tweet_id": tweet_id, "count": len(quotes), "quotes": quotes}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_tweet_retweeters(args: argparse.Namespace) -> dict[str, Any]:
  tweet_id = (args.tweet_id or "").strip()
  if not tweet_id:
    raise CliError("--tweet-id is required.")
  limit = max(1, min(args.limit, 400))
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/i/web/status/{tweet_id}/retweets", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    users = _collect_with_scroll(page, _extract_users, limit, max_scrolls=18)
    return {"tweet_id": tweet_id, "count": len(users), "retweeters": users}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_tweet_thread_context(args: argparse.Namespace) -> dict[str, Any]:
  tweet_id = (args.tweet_id or "").strip()
  if not tweet_id:
    raise CliError("--tweet-id is required.")
  limit = max(1, min(args.limit, 200))
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/i/web/status/{tweet_id}", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    thread = _collect_with_scroll(page, _extract_tweets, limit, max_scrolls=20)
    return {"tweet_id": tweet_id, "count": len(thread), "thread": thread}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_trends(args: argparse.Namespace) -> dict[str, Any]:
  limit = max(1, min(args.limit, 100))
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto("https://x.com/explore/tabs/trending", wait_until="domcontentloaded")
    page.wait_for_timeout(1000)
    trends = _collect_with_scroll(page, _extract_trends, limit, max_scrolls=6)
    return {"count": len(trends), "trends": trends}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_spaces_detail(args: argparse.Namespace) -> dict[str, Any]:
  space_id = (args.space_id or "").strip()
  if not space_id:
    raise CliError("--space-id is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/i/spaces/{space_id}", wait_until="domcontentloaded")
    page.wait_for_timeout(1000)
    return _extract_space_detail(page, space_id)
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_spaces_live(args: argparse.Namespace) -> dict[str, Any]:
  limit = max(1, min(args.limit, 100))
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto("https://x.com/i/spaces", wait_until="domcontentloaded")
    page.wait_for_timeout(1000)
    spaces = _collect_with_scroll(page, _extract_spaces, limit, max_scrolls=8)
    return {"count": len(spaces), "spaces": spaces}
  finally:
    context.close()
    browser.close()
    p.stop()


def _run_spaces_listen(args: argparse.Namespace) -> dict[str, Any]:
  space_id = (args.space_id or "").strip()
  if not space_id:
    raise CliError("--space-id is required.")
  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/i/spaces/{space_id}", wait_until="domcontentloaded")
    page.wait_for_timeout(1000)
    joined = _click_first(
      page,
      [
        "button:has-text('Start listening')",
        "button:has-text('Listen live')",
        "button:has-text('Join this Space')",
        "button:has-text('Join')",
      ],
    )
    page.wait_for_timeout(800)
    return {"space_id": space_id, "joined": joined}
  finally:
    context.close()
    browser.close()
    p.stop()


def _ensure_ffmpeg() -> None:
  if not shutil.which("ffmpeg"):
    raise CliError("ffmpeg is required for live streaming. Install ffmpeg first.")


def _stream_target_url(rtmp_url: str, stream_key: str | None) -> str:
  base = (rtmp_url or "").strip()
  if not base:
    raise CliError("--rtmp-url is required.")
  key = (stream_key or "").strip()
  if not key:
    return base
  if base.endswith("/"):
    return base + key
  return base + "/" + key


def _pid_running(pid: int) -> bool:
  try:
    os.kill(pid, 0)
  except OSError:
    return False
  return True


def _run_stream_status(args: argparse.Namespace) -> dict[str, Any]:
  pid_path = _stream_pid_file()
  meta_path = _stream_meta_file()
  if not pid_path.exists():
    return {"running": False}
  try:
    pid = int(pid_path.read_text(encoding="utf-8").strip())
  except Exception:
    return {"running": False, "error": "Invalid pid file"}
  running = _pid_running(pid)
  meta: dict[str, Any] = {}
  if meta_path.exists():
    try:
      loaded = json.loads(meta_path.read_text(encoding="utf-8"))
      if isinstance(loaded, dict):
        meta = loaded
    except Exception:
      meta = {}
  return {"running": running, "pid": pid, "meta": meta, "log_file": str(_stream_log_file())}


def _run_stream_start(args: argparse.Namespace) -> dict[str, Any]:
  _ensure_ffmpeg()
  status = _run_stream_status(args)
  if status.get("running"):
    raise CliError(f"Stream already running (pid={status.get('pid')}).")

  target = _stream_target_url(args.rtmp_url, args.stream_key)
  input_value = (args.input or "").strip()
  if not input_value:
    raise CliError("--input is required (video file/device/stream source).")

  cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning"]
  if args.loop:
    cmd.extend(["-stream_loop", "-1"])
  cmd.extend(
    [
      "-re",
      "-i",
      input_value,
      "-c:v",
      "libx264",
      "-preset",
      args.preset,
      "-b:v",
      args.video_bitrate,
      "-maxrate",
      args.video_bitrate,
      "-bufsize",
      args.buffer_size,
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      "-c:a",
      "aac",
      "-b:a",
      args.audio_bitrate,
      "-ar",
      "44100",
      "-f",
      "flv",
      target,
    ]
  )

  log_path = _stream_log_file()
  log_file = open(log_path, "a", encoding="utf-8")
  try:
    proc = subprocess.Popen(cmd, stdout=log_file, stderr=log_file, start_new_session=True)
  except Exception as err:
    log_file.close()
    raise CliError(f"Failed to launch ffmpeg: {err}") from err
  log_file.close()

  time.sleep(2.0)
  if proc.poll() is not None:
    raise CliError(f"ffmpeg exited immediately with code {proc.returncode}. See {log_path}")

  _stream_pid_file().write_text(str(proc.pid), encoding="utf-8")
  meta = {
    "pid": proc.pid,
    "started_at": int(time.time()),
    "input": input_value,
    "target": target,
    "command": cmd,
  }
  _stream_meta_file().write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
  return {
    "started": True,
    "pid": proc.pid,
    "target": target,
    "log_file": str(log_path),
    "meta_file": str(_stream_meta_file()),
  }


def _run_stream_stop(args: argparse.Namespace) -> dict[str, Any]:
  pid_path = _stream_pid_file()
  if not pid_path.exists():
    return {"stopped": False, "message": "No running stream."}
  pid = int(pid_path.read_text(encoding="utf-8").strip())
  if not _pid_running(pid):
    pid_path.unlink(missing_ok=True)
    _stream_meta_file().unlink(missing_ok=True)
    return {"stopped": False, "message": "No running stream process found."}

  os.kill(pid, signal.SIGTERM)
  deadline = time.time() + 8.0
  while time.time() < deadline:
    if not _pid_running(pid):
      break
    time.sleep(0.25)
  if _pid_running(pid):
    os.kill(pid, signal.SIGKILL)

  pid_path.unlink(missing_ok=True)
  _stream_meta_file().unlink(missing_ok=True)
  return {"stopped": True, "pid": pid, "log_file": str(_stream_log_file())}


def _run_stream_live_search(args: argparse.Namespace) -> dict[str, Any]:
  query = (args.query or "").strip()
  if not query:
    raise CliError("--query is required.")
  duration = max(5, min(args.duration, 3600))
  interval = max(2, min(args.interval, 120))
  max_events = max(1, min(args.max_events, 1000))
  encoded = urllib.parse.quote(query)

  p, browser, context, page = _with_page(args)
  try:
    _require_logged_in(page)
    page.goto(f"https://x.com/search?q={encoded}&src=typed_query&f=live", wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    seen: set[str] = set()
    events: list[dict[str, Any]] = []
    end_at = time.time() + duration
    while time.time() < end_at and len(events) < max_events:
      rows = _extract_tweets(page)
      for row in rows:
        tweet_id = str(row.get("tweet_id") or "")
        key = tweet_id or str(row.get("key") or "")
        if not key or key in seen:
          continue
        seen.add(key)
        row["observed_at"] = int(time.time())
        events.append(row)
        if len(events) >= max_events:
          break
      if len(events) >= max_events:
        break
      page.reload(wait_until="domcontentloaded")
      page.wait_for_timeout(int(interval * 1000))
    return {
      "query": query,
      "duration": duration,
      "interval": interval,
      "count": len(events),
      "events": events,
    }
  finally:
    context.close()
    browser.close()
    p.stop()


def _build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description="Local X API parity CLI (no external API keys).")
  parser.add_argument("--browser", choices=sorted(VALID_BROWSERS), default="chrome")
  parser.add_argument("--chrome-profile", default=None, help="Path to browser profile root or Cookies DB.")
  parser.add_argument("--chrome-profile-name", default="Default", help="Profile name when --chrome-profile is a user data root.")
  parser.add_argument("--visible", action="store_true", help="Run browser in visible mode.")
  parser.add_argument("--notify", action="store_true", help="Send local desktop notification after command.")
  parser.add_argument("--notify-webhook", default=None, help="Webhook URL for JSON push notifications.")
  parser.add_argument(
    "--compat-provider",
    choices=["none", "aisa"],
    default="none",
    help="Response compatibility mode.",
  )

  sub = parser.add_subparsers(dest="endpoint", required=True)

  login = sub.add_parser("user_login_v3")
  login.add_argument("--username", dest="username", default=None)
  login.add_argument("--user-name", dest="user_name", default=None)
  login.add_argument("--password", default=None)
  login.add_argument("--email", default=None)
  login.add_argument("--refresh", action="store_true", help="Force credential refresh login flow.")

  refresh_login = sub.add_parser("refresh_login_v3")
  refresh_login.add_argument("--username", dest="username", default=None)
  refresh_login.add_argument("--user-name", dest="user_name", default=None)
  refresh_login.add_argument("--password", default=None)
  refresh_login.add_argument("--email", default=None)
  refresh_login.set_defaults(refresh=True)

  detail = sub.add_parser("get_my_x_account_detail_v3")
  detail.add_argument("--user-name", dest="user_name", default=None)
  detail.add_argument("--username", dest="username", default=None)

  for name in ("send_tweet_v3", "create_tweet_v2"):
    cmd = sub.add_parser(name)
    cmd.add_argument("--text", required=True)

  for name in ("like_tweet_v3", "like_tweet_v2", "unlike_tweet_v2", "retweet_v3", "retweet_tweet_v2", "delete_tweet_v2"):
    cmd = sub.add_parser(name)
    cmd.add_argument("--tweet-id", required=True)

  for name in ("follow_user_v2", "unfollow_user_v2"):
    cmd = sub.add_parser(name)
    cmd.add_argument("--username", "--user-name", dest="username", required=True)

  dm = sub.add_parser("send_dm_to_user")
  dm.add_argument("--username", "--user-name", dest="username", required=True)
  dm.add_argument("--text", required=True)

  media = sub.add_parser("upload_media_v2")
  media.add_argument("--media-path", required=True)
  media.add_argument("--text", default="")

  for name in ("update_profile_v3", "update_profile_v2"):
    up = sub.add_parser(name)
    up.add_argument("--name", default=None)
    up.add_argument("--bio", default=None)

  for name in ("update_avatar_v2", "update_banner_v2"):
    upm = sub.add_parser(name)
    upm.add_argument("--file-path", required=True)

  info = sub.add_parser("user_info")
  info.add_argument("--username", "--user-name", dest="username", required=True)

  for name in ("user_last_tweets", "user_last_tweet", "user_followers", "user_followings"):
    cmd = sub.add_parser(name)
    cmd.add_argument("--username", "--user-name", dest="username", required=True)
    cmd.add_argument("--limit", type=int, default=20)

  home_timeline = sub.add_parser("home_timeline")
  home_timeline.add_argument("--limit", type=int, default=40)

  notifications = sub.add_parser("notifications_list")
  notifications.add_argument("--limit", type=int, default=40)

  for name in ("user_search", "search_user"):
    cmd = sub.add_parser(name)
    cmd.add_argument("--keyword", required=True)
    cmd.add_argument("--limit", type=int, default=20)

  for name in ("tweet_advanced_search", "advanced_search"):
    cmd = sub.add_parser(name)
    cmd.add_argument("--query", required=True)
    cmd.add_argument("--tab", default="latest")
    cmd.add_argument("--limit", type=int, default=20)

  for name in ("get_tweet_by_ids", "tweetById", "tweets"):
    cmd = sub.add_parser(name)
    cmd.add_argument("--tweet-ids", default=None, help="Comma-separated tweet ids.")
    cmd.add_argument("--tweet-id", action="append", default=[])

  for name in ("tweet_replies", "tweet_quotes", "tweet_retweeters", "tweet_thread_context"):
    cmd = sub.add_parser(name)
    cmd.add_argument("--tweet-id", required=True)
    cmd.add_argument("--limit", type=int, default=20)

  trends = sub.add_parser("trends")
  trends.add_argument("--limit", type=int, default=20)

  spaces_detail = sub.add_parser("spaces_detail")
  spaces_detail.add_argument("--space-id", required=True)

  spaces_live = sub.add_parser("spaces_live")
  spaces_live.add_argument("--limit", type=int, default=20)

  spaces_listen = sub.add_parser("spaces_listen")
  spaces_listen.add_argument("--space-id", required=True)

  stream_start = sub.add_parser("stream_start")
  stream_start.add_argument("--input", required=True, help="Input source for ffmpeg (file/device/url).")
  stream_start.add_argument("--rtmp-url", required=True, help="RTMP ingest base URL or full RTMP URL.")
  stream_start.add_argument("--stream-key", default=None, help="Optional stream key appended to --rtmp-url.")
  stream_start.add_argument("--loop", action="store_true", help="Loop input continuously.")
  stream_start.add_argument("--preset", default="veryfast")
  stream_start.add_argument("--video-bitrate", default="4500k")
  stream_start.add_argument("--audio-bitrate", default="128k")
  stream_start.add_argument("--buffer-size", default="9000k")

  sub.add_parser("stream_status")
  sub.add_parser("stream_stop")

  stream_live = sub.add_parser("stream_live_search")
  stream_live.add_argument("--query", required=True)
  stream_live.add_argument("--duration", type=int, default=120)
  stream_live.add_argument("--interval", type=int, default=5)
  stream_live.add_argument("--max-events", type=int, default=100)

  return parser


def _dispatch(args: argparse.Namespace) -> dict[str, Any]:
  endpoint = args.endpoint
  if endpoint in {"user_login_v3", "refresh_login_v3"}:
    if endpoint == "refresh_login_v3":
      args.refresh = True
    return _run_user_login_v3(args)
  if endpoint == "get_my_x_account_detail_v3":
    return _run_get_my_x_account_detail_v3(args)
  if endpoint in {"send_tweet_v3", "create_tweet_v2"}:
    return _run_send_tweet_v3(args) if endpoint == "send_tweet_v3" else _run_create_tweet_v2(args)
  if endpoint in {"like_tweet_v3", "like_tweet_v2"}:
    return _run_like_tweet_v3(args)
  if endpoint == "unlike_tweet_v2":
    return _run_unlike_tweet_v2(args)
  if endpoint in {"retweet_v3", "retweet_tweet_v2"}:
    return _run_retweet_v3(args)
  if endpoint == "delete_tweet_v2":
    return _run_delete_tweet_v2(args)
  if endpoint == "follow_user_v2":
    return _run_follow_user_v2(args)
  if endpoint == "unfollow_user_v2":
    return _run_unfollow_user_v2(args)
  if endpoint == "send_dm_to_user":
    return _run_send_dm_to_user(args)
  if endpoint == "upload_media_v2":
    return _run_upload_media_v2(args)
  if endpoint in {"update_profile_v3", "update_profile_v2"}:
    return _run_update_profile_v3(args)
  if endpoint == "update_avatar_v2":
    return _run_update_media_profile(args, "avatar")
  if endpoint == "update_banner_v2":
    return _run_update_media_profile(args, "banner")
  if endpoint == "user_info":
    return _run_user_info(args)
  if endpoint in {"user_last_tweets", "user_last_tweet"}:
    return _run_user_last_tweets(args)
  if endpoint == "home_timeline":
    return _run_home_timeline(args)
  if endpoint == "notifications_list":
    return _run_notifications_list(args)
  if endpoint == "user_followers":
    return _run_user_connections(args, "followers")
  if endpoint == "user_followings":
    return _run_user_connections(args, "followings")
  if endpoint in {"user_search", "search_user"}:
    return _run_search_user(args)
  if endpoint in {"tweet_advanced_search", "advanced_search"}:
    return _run_advanced_search(args)
  if endpoint in {"get_tweet_by_ids", "tweetById", "tweets"}:
    return _run_get_tweet_by_ids(args)
  if endpoint == "tweet_replies":
    return _run_tweet_replies(args)
  if endpoint == "tweet_quotes":
    return _run_tweet_quotes(args)
  if endpoint == "tweet_retweeters":
    return _run_tweet_retweeters(args)
  if endpoint == "tweet_thread_context":
    return _run_tweet_thread_context(args)
  if endpoint == "trends":
    return _run_trends(args)
  if endpoint == "spaces_detail":
    return _run_spaces_detail(args)
  if endpoint == "spaces_live":
    return _run_spaces_live(args)
  if endpoint == "spaces_listen":
    return _run_spaces_listen(args)
  if endpoint == "stream_start":
    return _run_stream_start(args)
  if endpoint == "stream_status":
    return _run_stream_status(args)
  if endpoint == "stream_stop":
    return _run_stream_stop(args)
  if endpoint == "stream_live_search":
    return _run_stream_live_search(args)
  raise CliError(f"Unsupported endpoint command: {endpoint}")


def main() -> int:
  parser = _build_parser()
  args = parser.parse_args()
  try:
    data = _dispatch(args)
    result = CommandResult(ok=True, endpoint=args.endpoint, data=data)
    print(_render_output(result, args))
    _notify(args, True, args.endpoint, "completed")
    return 0
  except CliError as err:
    result = CommandResult(ok=False, endpoint=args.endpoint, data={}, error=str(err))
    print(_render_output(result, args), file=sys.stderr)
    _notify(args, False, args.endpoint, str(err))
    return 2
  except urllib.error.URLError as err:
    result = CommandResult(
      ok=False,
      endpoint=args.endpoint,
      data={},
      error=f"Network error while sending notification webhook: {err}",
    )
    print(_render_output(result, args), file=sys.stderr)
    _notify(args, False, args.endpoint, "notification webhook network error")
    return 3
  except Exception as err:
    result = CommandResult(
      ok=False,
      endpoint=args.endpoint,
      data={},
      error=f"Unexpected failure: {err}",
    )
    print(_render_output(result, args), file=sys.stderr)
    _notify(args, False, args.endpoint, "unexpected failure")
    return 4


if __name__ == "__main__":
  raise SystemExit(main())
