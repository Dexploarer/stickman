export type EndpointArgType = "string" | "number" | "boolean";

export interface XEndpointArgSpec {
  key: string;
  label: string;
  type: EndpointArgType;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number | boolean;
}

export interface XEndpointCatalogEntry {
  endpoint: string;
  category: "auth" | "write" | "read" | "search" | "spaces" | "stream";
  summary: string;
  args: XEndpointArgSpec[];
}

export const xEndpointCatalog: XEndpointCatalogEntry[] = [
  {
    endpoint: "user_login_v3",
    category: "auth",
    summary: "Validate existing local X browser session or attempt credential login.",
    args: [
      { key: "userName", label: "Username", type: "string", placeholder: "your_handle" },
      { key: "password", label: "Password", type: "string" },
      { key: "email", label: "Email (challenge fallback)", type: "string" },
      { key: "refresh", label: "Force refresh flow", type: "boolean", defaultValue: false },
    ],
  },
  {
    endpoint: "refresh_login_v3",
    category: "auth",
    summary: "Force refresh login flow with username/password and persist session cookies.",
    args: [
      { key: "userName", label: "Username", type: "string", required: true, placeholder: "your_handle" },
      { key: "password", label: "Password", type: "string", required: true },
      { key: "email", label: "Email (challenge fallback)", type: "string" },
    ],
  },
  {
    endpoint: "get_my_x_account_detail_v3",
    category: "read",
    summary: "Get active account profile details from current session.",
    args: [{ key: "userName", label: "Username override", type: "string" }],
  },
  {
    endpoint: "send_tweet_v3",
    category: "write",
    summary: "Post a text tweet.",
    args: [{ key: "text", label: "Tweet text", type: "string", required: true }],
  },
  {
    endpoint: "create_tweet_v2",
    category: "write",
    summary: "Alias of send_tweet_v3.",
    args: [{ key: "text", label: "Tweet text", type: "string", required: true }],
  },
  {
    endpoint: "upload_media_v2",
    category: "write",
    summary: "Post tweet with media and optional text.",
    args: [
      { key: "mediaPath", label: "Media path", type: "string", required: true, placeholder: "/absolute/path/file.jpg" },
      { key: "text", label: "Tweet text", type: "string" },
    ],
  },
  {
    endpoint: "like_tweet_v3",
    category: "write",
    summary: "Like a tweet.",
    args: [{ key: "tweetId", label: "Tweet ID", type: "string", required: true }],
  },
  {
    endpoint: "unlike_tweet_v2",
    category: "write",
    summary: "Unlike a tweet.",
    args: [{ key: "tweetId", label: "Tweet ID", type: "string", required: true }],
  },
  {
    endpoint: "retweet_v3",
    category: "write",
    summary: "Retweet a tweet.",
    args: [{ key: "tweetId", label: "Tweet ID", type: "string", required: true }],
  },
  {
    endpoint: "delete_tweet_v2",
    category: "write",
    summary: "Delete your own tweet.",
    args: [{ key: "tweetId", label: "Tweet ID", type: "string", required: true }],
  },
  {
    endpoint: "follow_user_v2",
    category: "write",
    summary: "Follow a user.",
    args: [{ key: "username", label: "Username", type: "string", required: true }],
  },
  {
    endpoint: "unfollow_user_v2",
    category: "write",
    summary: "Unfollow a user.",
    args: [{ key: "username", label: "Username", type: "string", required: true }],
  },
  {
    endpoint: "send_dm_to_user",
    category: "write",
    summary: "Send direct message to a user.",
    args: [
      { key: "username", label: "Username", type: "string", required: true },
      { key: "text", label: "DM text", type: "string", required: true },
    ],
  },
  {
    endpoint: "update_profile_v3",
    category: "write",
    summary: "Update profile name and/or bio.",
    args: [
      { key: "name", label: "Display name", type: "string" },
      { key: "bio", label: "Bio", type: "string" },
    ],
  },
  {
    endpoint: "update_avatar_v2",
    category: "write",
    summary: "Update profile avatar image.",
    args: [{ key: "filePath", label: "Image path", type: "string", required: true }],
  },
  {
    endpoint: "update_banner_v2",
    category: "write",
    summary: "Update profile banner image.",
    args: [{ key: "filePath", label: "Image path", type: "string", required: true }],
  },
  {
    endpoint: "user_info",
    category: "read",
    summary: "Fetch profile summary for a username.",
    args: [{ key: "username", label: "Username", type: "string", required: true }],
  },
  {
    endpoint: "user_last_tweets",
    category: "read",
    summary: "Fetch recent tweets for a user timeline.",
    args: [
      { key: "username", label: "Username", type: "string", required: true },
      { key: "limit", label: "Limit", type: "number", defaultValue: 20 },
    ],
  },
  {
    endpoint: "home_timeline",
    category: "read",
    summary: "Fetch recent posts from the Home timeline feed.",
    args: [{ key: "limit", label: "Limit", type: "number", defaultValue: 40 }],
  },
  {
    endpoint: "notifications_list",
    category: "read",
    summary: "Fetch recent notifications from X notifications feed.",
    args: [{ key: "limit", label: "Limit", type: "number", defaultValue: 40 }],
  },
  {
    endpoint: "user_followers",
    category: "read",
    summary: "Fetch followers for a username.",
    args: [
      { key: "username", label: "Username", type: "string", required: true },
      { key: "limit", label: "Limit", type: "number", defaultValue: 20 },
    ],
  },
  {
    endpoint: "user_followings",
    category: "read",
    summary: "Fetch followings for a username.",
    args: [
      { key: "username", label: "Username", type: "string", required: true },
      { key: "limit", label: "Limit", type: "number", defaultValue: 20 },
    ],
  },
  {
    endpoint: "user_search",
    category: "search",
    summary: "Search users by keyword.",
    args: [
      { key: "keyword", label: "Keyword", type: "string", required: true },
      { key: "limit", label: "Limit", type: "number", defaultValue: 20 },
    ],
  },
  {
    endpoint: "tweet_advanced_search",
    category: "search",
    summary: "Search tweets by query and tab.",
    args: [
      { key: "query", label: "Search query", type: "string", required: true },
      { key: "tab", label: "Tab (top/latest)", type: "string", defaultValue: "latest" },
      { key: "limit", label: "Limit", type: "number", defaultValue: 20 },
    ],
  },
  {
    endpoint: "get_tweet_by_ids",
    category: "read",
    summary: "Lookup one or more tweet IDs.",
    args: [
      {
        key: "tweetIds",
        label: "Comma-separated tweet IDs",
        type: "string",
        required: true,
        placeholder: "123,456,789",
      },
    ],
  },
  {
    endpoint: "tweet_replies",
    category: "read",
    summary: "List replies for a tweet.",
    args: [
      { key: "tweetId", label: "Tweet ID", type: "string", required: true },
      { key: "limit", label: "Limit", type: "number", defaultValue: 20 },
    ],
  },
  {
    endpoint: "tweet_quotes",
    category: "read",
    summary: "List quotes for a tweet.",
    args: [
      { key: "tweetId", label: "Tweet ID", type: "string", required: true },
      { key: "limit", label: "Limit", type: "number", defaultValue: 20 },
    ],
  },
  {
    endpoint: "tweet_retweeters",
    category: "read",
    summary: "List retweeters for a tweet.",
    args: [
      { key: "tweetId", label: "Tweet ID", type: "string", required: true },
      { key: "limit", label: "Limit", type: "number", defaultValue: 20 },
    ],
  },
  {
    endpoint: "tweet_thread_context",
    category: "read",
    summary: "Get thread context around a tweet.",
    args: [
      { key: "tweetId", label: "Tweet ID", type: "string", required: true },
      { key: "limit", label: "Limit", type: "number", defaultValue: 20 },
    ],
  },
  {
    endpoint: "trends",
    category: "search",
    summary: "Get trending topics.",
    args: [{ key: "limit", label: "Limit", type: "number", defaultValue: 20 }],
  },
  {
    endpoint: "spaces_detail",
    category: "spaces",
    summary: "Get details for a specific Space.",
    args: [{ key: "spaceId", label: "Space ID", type: "string", required: true }],
  },
  {
    endpoint: "spaces_live",
    category: "spaces",
    summary: "List currently live Spaces.",
    args: [{ key: "limit", label: "Limit", type: "number", defaultValue: 20 }],
  },
  {
    endpoint: "spaces_listen",
    category: "spaces",
    summary: "Attempt to join/listen to a Space.",
    args: [{ key: "spaceId", label: "Space ID", type: "string", required: true }],
  },
  {
    endpoint: "stream_status",
    category: "stream",
    summary: "Check RTMP stream process status.",
    args: [],
  },
  {
    endpoint: "stream_start",
    category: "stream",
    summary: "Start live RTMP stream with ffmpeg.",
    args: [
      { key: "input", label: "Input source", type: "string", required: true },
      { key: "rtmpUrl", label: "RTMP URL", type: "string", required: true },
      { key: "streamKey", label: "Stream key", type: "string" },
      { key: "loop", label: "Loop input", type: "boolean", defaultValue: false },
      { key: "preset", label: "Preset", type: "string", defaultValue: "veryfast" },
      { key: "videoBitrate", label: "Video bitrate", type: "string", defaultValue: "4500k" },
      { key: "audioBitrate", label: "Audio bitrate", type: "string", defaultValue: "128k" },
      { key: "bufferSize", label: "Buffer size", type: "string", defaultValue: "9000k" },
    ],
  },
  {
    endpoint: "stream_stop",
    category: "stream",
    summary: "Stop RTMP stream process.",
    args: [],
  },
  {
    endpoint: "stream_live_search",
    category: "stream",
    summary: "Poll X live search and stream discovered tweets.",
    args: [
      { key: "query", label: "Query", type: "string", required: true },
      { key: "duration", label: "Duration (sec)", type: "number", defaultValue: 120 },
      { key: "interval", label: "Refresh interval (sec)", type: "number", defaultValue: 5 },
      { key: "maxEvents", label: "Max events", type: "number", defaultValue: 100 },
    ],
  },
];

export const xEndpointByName = new Map(xEndpointCatalog.map((entry) => [entry.endpoint, entry]));
