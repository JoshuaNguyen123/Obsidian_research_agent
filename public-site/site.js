const MEDIA_VERSION = "2026-07-30-clean-demos-v2";
const mediaPath = (fileName) => `./media/${fileName}?v=${MEDIA_VERSION}`;

const DEMOS = Object.freeze({
  researcher: Object.freeze({
    label: "Researcher",
    outcome: "Turn a research brief into a cited decision.",
    description:
      "The agent reads one useful note, checks its two linked sources, and appends a compact decision with citations and a verified write receipt.",
    steps: Object.freeze([
      "Reads the active-note brief",
      "Reads both linked sources",
      "Appends the cited decision",
      "Confirms the verified receipt",
    ]),
    poster: mediaPath("researcher-demo-poster.jpg"),
    webm: mediaPath("researcher-demo.webm"),
    mp4: mediaPath("researcher-demo.mp4"),
    ariaLabel:
      "Researcher demo: a real run turns a note-search brief into a cited decision",
  }),
  builder: Object.freeze({
    label: "Builder",
    outcome: "Turn a working brief into a tested tool.",
    description:
      "The agent reads the note's acceptance criteria, builds a Python CLI, validates it with sample files, and delivers the verified result.",
    steps: Object.freeze([
      "Reads the acceptance criteria",
      "Builds the Python CLI",
      "Runs targeted and full checks",
      "Delivers the verified file",
    ]),
    poster: mediaPath("builder-demo-poster.jpg"),
    webm: mediaPath("builder-demo.webm"),
    mp4: mediaPath("builder-demo.mp4"),
    ariaLabel:
      "Builder demo: a real run turns text-file acceptance criteria into a tested Python tool",
  }),
});

const tabs = Array.from(document.querySelectorAll("[data-demo-role]"));
const scrollTrack = document.querySelector(".demo-scroll");
const panel = document.querySelector("#demo-panel");
const video = document.querySelector("#role-demo");
const webmSource = document.querySelector("#role-demo-webm");
const mp4Source = document.querySelector("#role-demo-mp4");
const fill = document.querySelector("#demo-scrubline-fill");
const roleLabel = document.querySelector("#demo-role-label");
const outcome = document.querySelector("#demo-outcome");
const description = document.querySelector("#demo-description");
const stepsList = document.querySelector("#demo-steps");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const compact = window.matchMedia("(max-width: 900px)");

let activeRole = "researcher";
let mediaLoaded = false;

/** Whether the scroll-scrub interaction is active for the current environment. */
function scrubEnabled() {
  return !reducedMotion.matches && !compact.matches;
}

function renderDemo(role, options = {}) {
  const demo = DEMOS[role];
  const selectedTab = tabs.find((tab) => tab.dataset.demoRole === role);
  if (!demo || !selectedTab || !panel || !video) return;

  for (const tab of tabs) {
    const selected = tab === selectedTab;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }

  activeRole = role;
  mediaLoaded = false;
  video.pause();
  video.poster = demo.poster;
  video.setAttribute("aria-label", demo.ariaLabel);
  webmSource?.setAttribute("data-src", demo.webm);
  mp4Source?.setAttribute("data-src", demo.mp4);
  webmSource?.removeAttribute("src");
  mp4Source?.removeAttribute("src");
  try {
    video.currentTime = 0;
  } catch {
    /* metadata not ready yet */
  }

  panel.setAttribute("aria-labelledby", selectedTab.id);
  if (roleLabel) roleLabel.textContent = demo.label;
  if (outcome) outcome.textContent = demo.outcome;
  if (description) description.textContent = demo.description;
  if (stepsList) {
    stepsList.replaceChildren(
      ...demo.steps.map((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        return li;
      }),
    );
  }
  setProgress(0);

  // Reduced-motion / compact: give the viewer normal playback controls since
  // there is no scroll track to scrub. Otherwise, load eagerly so scrubbing is
  // smooth as soon as the run comes into view.
  if (scrubEnabled()) {
    video.controls = false;
    if (isTrackInView()) ensureMediaLoaded();
  } else {
    video.controls = true;
  }

  if (options.focus === true) selectedTab.focus();
}

function ensureMediaLoaded() {
  if (mediaLoaded || !video) return;
  const demo = DEMOS[activeRole];
  webmSource?.setAttribute("src", demo.webm);
  mp4Source?.setAttribute("src", demo.mp4);
  video.preload = "auto";
  video.load();
  mediaLoaded = true;
}

function isTrackInView() {
  if (!scrollTrack) return false;
  const rect = scrollTrack.getBoundingClientRect();
  return rect.top < window.innerHeight && rect.bottom > 0;
}

function setProgress(progress) {
  const clamped = Math.min(1, Math.max(0, progress));
  if (fill) fill.style.width = `${(clamped * 100).toFixed(2)}%`;
  if (stepsList) {
    const items = stepsList.children;
    const activeIndex = Math.min(
      items.length - 1,
      Math.floor(clamped * items.length),
    );
    for (let index = 0; index < items.length; index += 1) {
      items[index].setAttribute("data-active", String(index <= activeIndex));
    }
  }
}

function trackProgress() {
  if (!scrollTrack) return 0;
  const absoluteTop =
    scrollTrack.getBoundingClientRect().top + window.scrollY;
  const headerOffset = 64;
  const start = absoluteTop - headerOffset;
  const end = absoluteTop + scrollTrack.offsetHeight - window.innerHeight;
  if (end <= start) return 0;
  return Math.min(1, Math.max(0, (window.scrollY - start) / (end - start)));
}

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    if (!scrubEnabled()) return;
    if (!isTrackInView()) return;
    ensureMediaLoaded();
    const progress = trackProgress();
    setProgress(progress);
    const duration = video?.duration;
    if (video && typeof duration === "number" && Number.isFinite(duration)) {
      const target = progress * duration;
      if (Math.abs(target - video.currentTime) > 0.03) {
        try {
          video.currentTime = target;
        } catch {
          /* seek not ready */
        }
      }
    }
  });
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => renderDemo(tab.dataset.demoRole));
  tab.addEventListener("keydown", (event) => {
    let targetIndex = null;
    if (event.key === "ArrowRight") targetIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft")
      targetIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = tabs.length - 1;
    if (targetIndex === null) return;
    event.preventDefault();
    renderDemo(tabs[targetIndex].dataset.demoRole, { focus: true });
  });
}

window.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("resize", onScroll, { passive: true });
reducedMotion.addEventListener?.("change", () => renderDemo(activeRole));
compact.addEventListener?.("change", () => renderDemo(activeRole));

renderDemo("researcher");
