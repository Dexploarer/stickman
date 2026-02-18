const MAX_EVENTS = 240;
const events = [];
let source = null;
let socket = null;
const query = new URLSearchParams(window.location.search);
let pinnedSessionId = (query.get("sessionId") || "").trim();
const pinnedSourceId = (query.get("sourceId") || "").trim();
const pinnedTaskId = (query.get("taskId") || "").trim();

const $ = (id) => document.getElementById(id);

const buildFilterQuery = () => {
  const params = new URLSearchParams();
  if (pinnedSessionId) params.set("sessionId", pinnedSessionId);
  if (pinnedSourceId) params.set("sourceId", pinnedSourceId);
  if (pinnedTaskId) params.set("taskId", pinnedTaskId);
  return params.toString();
};

const updateFilterLabel = () => {
  const node = $("live-filter");
  if (!node) return;
  const parts = [];
  if (pinnedSessionId) parts.push(`session=${pinnedSessionId}`);
  if (pinnedSourceId) parts.push(`source=${pinnedSourceId}`);
  if (pinnedTaskId) parts.push(`task=${pinnedTaskId}`);
  node.textContent = parts.length ? `Filter: ${parts.join(" | ")}` : "Filter: all watch sessions";
};

const frameMatchesFilter = (payload) => {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  if (pinnedSessionId && String(payload.watchSessionId || "").trim() !== pinnedSessionId) {
    return false;
  }
  if (pinnedSourceId && String(payload.sourceId || "").trim() !== pinnedSourceId) {
    return false;
  }
  if (pinnedTaskId && String(payload.taskId || "").trim() !== pinnedTaskId) {
    return false;
  }
  return true;
};

const render = () => {
  const stream = $("live-stream");
  if (!stream) return;
  stream.innerHTML = "";
  const rows = events.slice(-MAX_EVENTS).reverse();
  rows.forEach((event) => {
    const item = document.createElement("article");
    item.className = "event";
    const head = document.createElement("div");
    head.className = "event-head";
    const type = document.createElement("span");
    type.className = "event-type";
    type.textContent = event.type || "event";
    const time = document.createElement("span");
    time.className = "event-time";
    time.textContent = event.ts ? new Date(event.ts).toLocaleTimeString() : "";
    head.appendChild(type);
    head.appendChild(time);

    const body = document.createElement("div");
    body.className = "event-body";
    body.textContent = JSON.stringify(event.payload || {}, null, 2);

    item.appendChild(head);
    item.appendChild(body);
    stream.appendChild(item);
  });
  const count = $("live-count");
  if (count) {
    count.textContent = `${events.length} events`;
  }
};

const setConnectionState = (online, label) => {
  const status = $("live-status");
  const connection = $("live-connection");
  if (status) {
    status.classList.toggle("online", Boolean(online));
  }
  if (connection) {
    connection.textContent = label;
  }
};

const sanitizeEvent = (event) => {
  const payload = event?.payload && typeof event.payload === "object" ? { ...event.payload } : event?.payload;
  if (event?.type === "frame" && payload && typeof payload.frame === "string") {
    const byteLength = payload.frame.length;
    payload.frame = `<frame omitted: ${byteLength} chars>`;
  }
  if (event?.type === "stdout_chunk" && payload && typeof payload.chunk === "string" && payload.chunk.length > 2000) {
    payload.chunk = `${payload.chunk.slice(0, 2000)} …[truncated]`;
  }
  return {
    ...event,
    payload,
  };
};

const ingestEvent = (event) => {
  if (!event || typeof event !== "object") return;
  if (event.type === "watch_session_started" && !pinnedSessionId) {
    const startedId = String(event.payload?.watchSessionId || "").trim();
    if (startedId) {
      pinnedSessionId = startedId;
      updateFilterLabel();
    }
  }
  if (event.type === "frame" && event.payload?.frame && $("live-frame") && frameMatchesFilter(event.payload)) {
    $("live-frame").src = String(event.payload.frame);
  }
  events.push(sanitizeEvent(event));
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  render();
};

const connectSse = () => {
  if (socket) {
    socket.close();
    socket = null;
  }
  if (source) {
    source.close();
  }
  setConnectionState(false, "Connecting SSE...");
  const filterQuery = buildFilterQuery();
  source = new EventSource(filterQuery ? `/api/live/events?${filterQuery}` : "/api/live/events");

  source.onopen = () => {
    setConnectionState(true, "Live stream connected");
  };

  source.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data || "{}");
      ingestEvent(parsed);
    } catch {
      ingestEvent({
        id: `${Date.now()}`,
        type: "raw",
        ts: new Date().toISOString(),
        payload: {
          value: message.data || "",
        },
      });
    }
  };

  source.onerror = () => {
    setConnectionState(false, "SSE disconnected");
  };
};

const connectWebSocket = () => {
  if (source) {
    source.close();
    source = null;
  }
  if (socket) {
    socket.close();
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const filterQuery = buildFilterQuery();
  const wsPath = filterQuery ? `/api/live/ws?${filterQuery}` : "/api/live/ws";
  socket = new WebSocket(`${protocol}://${window.location.host}${wsPath}`);

  socket.onopen = () => {
    setConnectionState(true, "WebSocket live connected");
  };

  socket.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data || "{}");
      ingestEvent(parsed);
    } catch {
      ingestEvent({
        id: `${Date.now()}`,
        type: "raw",
        ts: new Date().toISOString(),
        payload: {
          value: message.data || "",
        },
      });
    }
  };

  socket.onerror = () => {
    setConnectionState(false, "WebSocket error, falling back to SSE");
    connectSse();
  };

  socket.onclose = () => {
    if (!source) {
      connectSse();
    }
  };
};

const loadSnapshot = async () => {
  try {
    const filterQuery = buildFilterQuery();
    const response = await fetch(filterQuery ? `/api/live/snapshot?${filterQuery}` : "/api/live/snapshot");
    const parsed = await response.json();
    const rows = Array.isArray(parsed?.events) ? parsed.events : [];
    events.splice(0, events.length, ...rows.slice(-MAX_EVENTS));
    const latestFrame = [...rows]
      .reverse()
      .find((event) => event?.type === "frame" && frameMatchesFilter(event?.payload || {}));
    if (latestFrame?.payload?.frame && $("live-frame")) {
      $("live-frame").src = String(latestFrame.payload.frame);
    }
    render();
  } catch {
    // ignore snapshot errors
  }
};

$("live-clear")?.addEventListener("click", () => {
  events.splice(0, events.length);
  render();
});

$("live-reconnect")?.addEventListener("click", async () => {
  await loadSnapshot();
  connectWebSocket();
});

updateFilterLabel();
await loadSnapshot();
connectWebSocket();
