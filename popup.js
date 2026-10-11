
const $ = id => document.getElementById(id);

let videoInfo = null;
let segments = [];
let detectedComments = [];

function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const pad = n => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function parseTime(value) {
  const parts = value.trim().split(":");

  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some(p => !/^\d+$/.test(p))
  ) {
    throw new Error(`Invalid time: ${value}`);
  }

  const nums = parts.map(Number);
  const sec = nums[nums.length - 1];
  const min = nums[nums.length - 2];

  if (sec > 59) throw new Error("Seconds must be 00–59.");

  if (parts.length === 3) {
    if (min > 59) throw new Error("Minutes must be 00–59 in HH:MM:SS.");
    return nums[0] * 3600 + min * 60 + sec;
  }

  // Two-part timestamps intentionally support 110:15 = 110 min, 15 sec.
  return min * 60 + sec;
}

function storageKey() {
  return `segments:${videoInfo.videoId}`;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (!tab?.id || !tab.url?.startsWith("https://www.youtube.com/")) {
    throw new Error("Open a YouTube video first.");
  }

  return tab;
}

async function send(message) {
  const tab = await activeTab();

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    throw new Error("Reload the YouTube tab and reopen this extension.");
  }
}

function setStatus(message) {
  $("status").textContent = message;
}

async function loadVideo() {
  setStatus("Reading YouTube video…");

  const info = await send({ type: "GET_INFO" });

  if (!info?.ok || !info.videoId) {
    throw new Error("Open a YouTube video, wait for it to load, and retry.");
  }

  videoInfo = info;

  $("videoTitle").textContent = info.title || "YouTube video";
  $("videoMeta").textContent =
    `${formatTime(info.duration)} total · ${info.videoId}`;

  $("playhead").max = Math.max(1, Math.floor(info.duration));
  $("playhead").value = Math.floor(info.currentTime || 0);
  $("currentTime").textContent = formatTime(info.currentTime);
  $("duration").textContent = formatTime(info.duration);

  const saved = await chrome.storage.local.get(storageKey());
  segments = saved[storageKey()] || [];

  renderSegments();
  setStatus("");
}

function renderSegments() {
  const root = $("segments");
  root.replaceChildren();

  if (!segments.length) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "No segments saved for this video yet.";
    root.append(p);
    return;
  }

  segments.forEach((segment, index) => {
    const item = document.createElement("div");
    item.className = "segment";

    const title = document.createElement("div");
    title.className = "segment-title";
    title.textContent =
      `${index + 1}. ${segment.name || "Segment " + (index + 1)}`;

    const times = document.createElement("div");
    times.className = "muted small";
    times.textContent =
      `${formatTime(segment.start)} – ${formatTime(segment.end)}`;

    const actions = document.createElement("div");
    actions.className = "segment-actions";

    const jump = document.createElement("button");
    jump.textContent = "▶ Play";
    jump.addEventListener("click", async () => {
      try {
        await send({ type: "SEEK", time: segment.start });
        setStatus("Jumped to " + formatTime(segment.start));
      } catch (e) {
        setStatus(e.message);
      }
    });

    const up = document.createElement("button");
    up.textContent = "↑";
    up.title = "Move up";
    up.disabled = index === 0;
    up.addEventListener("click", () => {
      [segments[index - 1], segments[index]] =
        [segments[index], segments[index - 1]];
      renderSegments();
      persist();
    });

    const down = document.createElement("button");
    down.textContent = "↓";
    down.title = "Move down";
    down.disabled = index === segments.length - 1;
    down.addEventListener("click", () => {
      [segments[index], segments[index + 1]] =
        [segments[index + 1], segments[index]];
      renderSegments();
      persist();
    });

    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      segments.splice(index, 1);
      renderSegments();
      persist();
    });

    actions.append(jump, up, down, remove);
    item.append(title, times, actions);
    root.append(item);
  });
}

async function persist() {
  if (!videoInfo) return;

  await chrome.storage.local.set({
    [storageKey()]: segments
  });

  $("savedStatus").textContent =
    `Saved ${segments.length} segment(s) for this video.`;
}

$("refresh").addEventListener("click", async () => {
  try {
    await loadVideo();
  } catch (e) {
    setStatus(e.message);
  }
});

$("playhead").addEventListener("input", () => {
  $("currentTime").textContent =
    formatTime(Number($("playhead").value));
});

$("seek").addEventListener("click", async () => {
  try {
    await send({
      type: "SEEK",
      time: Number($("playhead").value)
    });
    setStatus("Video position updated.");
  } catch (e) {
    setStatus(e.message);
  }
});

async function setFieldFromCurrent(field) {
  try {
    const info = await send({ type: "GET_INFO" });
    $(field).value = formatTime(info.currentTime);
  } catch (e) {
    setStatus(e.message);
  }
}

$("setStart").addEventListener("click", () => setFieldFromCurrent("start"));
$("setEnd").addEventListener("click", () => setFieldFromCurrent("end"));

$("add").addEventListener("click", async () => {
  try {
    if (!videoInfo) throw new Error("Load a YouTube video first.");

    const start = parseTime($("start").value);
    const end = parseTime($("end").value);

    if (end <= start) throw new Error("End must be after start.");
    if (start >= videoInfo.duration) {
      throw new Error("Start is beyond the video duration.");
    }

    segments.push({
      start,
      end: Math.min(end, videoInfo.duration),
      name: $("segmentName").value.trim()
    });

    // Keep the playlist in chronological order.
    segments.sort((a, b) => a.start - b.start);

    renderSegments();
    await persist();

    $("segmentName").value = "";
    setStatus("Segment added.");
  } catch (e) {
    setStatus(e.message);
  }
});

$("save").addEventListener("click", async () => {
  try {
    await persist();
    setStatus("Your segments are saved.");
  } catch (e) {
    setStatus(e.message);
  }
});

$("play").addEventListener("click", async () => {
  try {
    if (!segments.length) throw new Error("Add a segment first.");

    const result = await send({
      type: "START_SEGMENTS",
      segments
    });

    if (!result?.ok) throw new Error(result?.error || "Could not start.");

    setStatus(`Playing ${segments.length} selected segment(s).`);
  } catch (e) {
    setStatus(e.message);
  }
});

$("stop").addEventListener("click", async () => {
  try {
    await send({ type: "STOP_SEGMENTS" });
    setStatus("Segment playback stopped.");
  } catch (e) {
    setStatus(e.message);
  }
});

$("scan").addEventListener("click", async () => {
  const root = $("commentResults");
  root.replaceChildren();
  detectedComments = [];
  $("import").disabled = true;
  setStatus("Scanning loaded comments…");

  try {
    const result = await send({ type: "GET_COMMENTS" });

    if (!result?.ok) throw new Error(result?.error || "Scan failed.");

    detectedComments = result.comments || [];

    if (!detectedComments.length) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent =
        "No ranges found. Load more comments or check for ranges like 18:00 - 18:45.";
      root.append(p);
    }

    detectedComments.forEach((comment, index) => {
      const item = document.createElement("div");
      item.className = "comment";

      const label = document.createElement("label");
      label.className = "checkrow";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.index = String(index);

      const detail = document.createElement("div");
      const range = document.createElement("strong");
      range.textContent =
        `${formatTime(comment.start)} – ${formatTime(comment.end)}`;

      const source = document.createElement("div");
      source.className = "comment-text small";
      source.textContent = comment.text;

      detail.append(range, source);
      label.append(checkbox, detail);
      item.append(label);
      root.append(item);
    });

    $("import").disabled = !detectedComments.length;
    setStatus(`Found ${detectedComments.length} possible range(s).`);
  } catch (e) {
    setStatus(e.message);
  }
});

$("import").addEventListener("click", async () => {
  try {
    if (!videoInfo) throw new Error("Load a video first.");

    const selected = [
      ...$("commentResults").querySelectorAll(
        'input[type="checkbox"]:checked'
      )
    ];

    const additions = selected.map(box => {
      const found = detectedComments[Number(box.dataset.index)];
      return {
        start: found.start,
        end: Math.min(found.end, videoInfo.duration),
        name: found.text.slice(0, 80)
      };
    }).filter(s =>
      s.start >= 0 &&
      s.start < videoInfo.duration &&
      s.end > s.start
    );

    segments.push(...additions);
    segments.sort((a, b) => a.start - b.start);

    renderSegments();
    await persist();

    setStatus(`Imported ${additions.length} range(s).`);
  } catch (e) {
    setStatus(e.message);
  }
});

// Refresh the current playhead while the popup is open.
setInterval(async () => {
  try {
    const info = await send({ type: "GET_INFO" });
    if (!info?.ok) return;

    $("playhead").max = Math.max(1, Math.floor(info.duration));
    $("playhead").value = Math.floor(info.currentTime);
    $("currentTime").textContent = formatTime(info.currentTime);
    $("duration").textContent = formatTime(info.duration);
  } catch {
    // Ignore transient player navigation while the popup is open.
  }
}, 1000);

loadVideo().catch(e => setStatus(e.message));
