(() => {
  if (window.__segmentJumperV2) return;
  window.__segmentJumperV2 = true;

  let active = false;
  let segments = [];
  let index = -1;
  let player = null;
  let lastSeekAt = 0;
  let videoId = null;

  function getVideoId() {
    return new URL(location.href).searchParams.get("v");
  }

  function getPlayer() {
    return document.querySelector("video.html5-main-video")
      || document.querySelector("video");
  }

  function getInfo() {
    const video = getPlayer();
    const id = getVideoId();

    if (!video || !id) {
      return { ok: false, error: "No YouTube video is open." };
    }

    return {
      ok: true,
      videoId: id,
      title: document.title.replace(/\s*-\s*YouTube$/, ""),
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      currentTime: video.currentTime || 0,
      paused: video.paused
    };
  }

  function stop() {
    active = false;
    segments = [];
    index = -1;

    if (player) {
      player.removeEventListener("timeupdate", onTimeUpdate);
      player.removeEventListener("ended", onEnded);
    }

    player = null;
  }

  function seek(time) {
    const video = getPlayer();
    if (!video) return { ok: false, error: "Video player not found." };

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, error: "Video duration is not ready." };
    }

    const target = Math.max(0, Math.min(Number(time), duration));
    video.currentTime = target;

    return { ok: true, currentTime: target };
  }

  function playIndex(nextIndex) {
    if (!active || nextIndex >= segments.length) {
      stop();
      return;
    }

    index = nextIndex;
    lastSeekAt = Date.now();

    const segment = segments[index];
    player.currentTime = segment.start;

    const promise = player.play();
    if (promise?.catch) {
      promise.catch(() => {
        // Browser autoplay policy may require a user click.
      });
    }
  }

  function advance() {
    if (active) playIndex(index + 1);
  }

  function onTimeUpdate() {
    if (!active || !player || index < 0) return;

    if (
      player.currentTime >= segments[index].end &&
      Date.now() - lastSeekAt > 250
    ) {
      advance();
    }
  }

  function onEnded() {
    if (active) advance();
  }

  function start(requested) {
    const video = getPlayer();

    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
      return { ok: false, error: "Wait for the video duration to load." };
    }

    if (!Array.isArray(requested) || !requested.length) {
      return { ok: false, error: "No segments supplied." };
    }

    const duration = video.duration;
    const checked = [];

    for (const s of requested) {
      const start = Number(s.start);
      const end = Number(s.end);

      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start ||
        start >= duration
      ) {
        return { ok: false, error: "One or more segment times are invalid." };
      }

      checked.push({
        start,
        end: Math.min(end, duration)
      });
    }

    stop();

    // Keep the supplied playlist order. The popup sorts new additions.
    segments = checked;
    player = video;
    active = true;

    player.addEventListener("timeupdate", onTimeUpdate);
    player.addEventListener("ended", onEnded);

    playIndex(0);
    return { ok: true };
  }

  function parseTimestamp(value) {
    const parts = value.split(":").map(Number);

    if (
      parts.length < 2 ||
      parts.length > 3 ||
      parts.some(n => !Number.isInteger(n) || n < 0)
    ) {
      return null;
    }

    const sec = parts[parts.length - 1];
    const min = parts[parts.length - 2];

    if (sec > 59) return null;

    if (parts.length === 3) {
      if (min > 59) return null;
      return parts[0] * 3600 + min * 60 + sec;
    }

    return min * 60 + sec;
  }

  function scanComments() {
    const video = getPlayer();
    const duration = video?.duration;

    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, error: "Video duration is not ready." };
    }

    const results = [];
    const seen = new Set();

    // Scan rendered comment text only; this does not fetch hidden comments.
    const nodes = document.querySelectorAll(
      "ytd-comment-thread-renderer #content-text"
    );

    const rangePattern =
      /(\d{1,3}(?::\d{1,2}){1,2})\s*(?:-|–|—|\bto\b)\s*(\d{1,3}(?::\d{1,2}){1,2})/gi;

    for (const node of nodes) {
      const text = (node.innerText || node.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      if (!text) continue;

      rangePattern.lastIndex = 0;
      let match;

      while ((match = rangePattern.exec(text)) !== null) {
        const start = parseTimestamp(match[1]);
        const end = parseTimestamp(match[2]);

        if (
          start === null ||
          end === null ||
          end <= start ||
          start >= duration
        ) {
          continue;
        }

        const key = `${start}:${end}:${text}`;

        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          start,
          end: Math.min(end, duration),
          text: text.slice(0, 400)
        });
      }
    }

    return { ok: true, comments: results };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // A YouTube single-page navigation may replace the video without
    // replacing the content-script execution context.
    const currentId = getVideoId();

    if (videoId && currentId !== videoId) {
      stop();
    }
    videoId = currentId;

    switch (message.type) {
      case "GET_INFO":
        sendResponse(getInfo());
        break;

      case "SEEK":
        sendResponse(seek(message.time));
        break;

      case "START_SEGMENTS":
        sendResponse(start(message.segments));
        break;

      case "STOP_SEGMENTS":
        stop();
        sendResponse({ ok: true });
        break;

      case "GET_COMMENTS":
        sendResponse(scanComments());
        break;

      default:
        sendResponse({ ok: false, error: "Unknown command." });
    }
  });
})();
