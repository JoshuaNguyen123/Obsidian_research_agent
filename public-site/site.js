const MEDIA_VERSION = "2026-07-30-clean-demos-v2";
const mediaPath = (fileName) => `./media/${fileName}?v=${MEDIA_VERSION}`;

const DEMOS = Object.freeze({
  researcher: Object.freeze({
    label: "Researcher",
    outcome: "Turn a research brief into a cited decision.",
    description:
      "The agent reads one useful note, checks its linked sources, and appends a compact decision with citations.",
    steps: Object.freeze([
      "Reads the active-note brief",
      "Reads both linked sources",
      "Appends the cited decision",
      "Confirms the verified receipt",
    ]),
    receipt: "Decision appended and verified",
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
      "The agent reads the acceptance criteria, builds a Python CLI, validates it with sample files, and delivers the result.",
    steps: Object.freeze([
      "Reads the acceptance criteria",
      "Builds the Python CLI",
      "Runs targeted and full checks",
      "Delivers the verified file",
    ]),
    receipt: "Tool delivered and checks passed",
    poster: mediaPath("builder-demo-poster.jpg"),
    webm: mediaPath("builder-demo.webm"),
    mp4: mediaPath("builder-demo.mp4"),
    ariaLabel:
      "Builder demo: a real run turns text-file acceptance criteria into a tested Python tool",
  }),
});

const tabs = Array.from(document.querySelectorAll("[data-demo-role]"));
const panel = document.querySelector("#demo-panel");
const video = document.querySelector("#role-demo");
const webmSource = document.querySelector("#role-demo-webm");
const mp4Source = document.querySelector("#role-demo-mp4");
const playButton = document.querySelector("#demo-play");
const status = document.querySelector("#demo-status");
const roleLabel = document.querySelector("#demo-role-label");
const outcome = document.querySelector("#demo-outcome");
const description = document.querySelector("#demo-description");
const stepsList = document.querySelector("#demo-steps");
const receipt = document.querySelector("#demo-receipt");

let activeRole = "researcher";
let mediaLoaded = false;

function setStatus(message) {
  if (status) status.textContent = message;
}

function resetMedia(demo) {
  mediaLoaded = false;
  video?.pause();
  if (video) {
    video.controls = false;
    video.poster = demo.poster;
    video.preload = "none";
    video.setAttribute("aria-label", demo.ariaLabel);
    try {
      video.currentTime = 0;
    } catch {
      // Metadata is intentionally unloaded until the viewer presses Play.
    }
  }
  webmSource?.setAttribute("data-src", demo.webm);
  mp4Source?.setAttribute("data-src", demo.mp4);
  webmSource?.removeAttribute("src");
  mp4Source?.removeAttribute("src");
  if (playButton) {
    playButton.hidden = false;
    playButton.textContent = `Play ${demo.label} run`;
  }
  setStatus("");
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
  panel.setAttribute("aria-labelledby", selectedTab.id);
  if (roleLabel) roleLabel.textContent = demo.label;
  if (outcome) outcome.textContent = demo.outcome;
  if (description) description.textContent = demo.description;
  if (receipt) receipt.textContent = demo.receipt;
  if (stepsList) {
    stepsList.replaceChildren(
      ...demo.steps.map((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        return li;
      }),
    );
  }
  resetMedia(demo);
  if (options.focus === true) selectedTab.focus();
}

function ensureMediaLoaded() {
  if (mediaLoaded || !video) return;
  const demo = DEMOS[activeRole];
  webmSource?.setAttribute("src", demo.webm);
  mp4Source?.setAttribute("src", demo.mp4);
  video.preload = "metadata";
  video.load();
  mediaLoaded = true;
}

async function playActiveDemo() {
  if (!video || !playButton) return;
  ensureMediaLoaded();
  playButton.disabled = true;
  setStatus(`Loading ${DEMOS[activeRole].label} run...`);
  try {
    await video.play();
    video.controls = true;
    playButton.hidden = true;
    setStatus("");
  } catch {
    playButton.disabled = false;
    playButton.textContent = "Try playback again";
    setStatus("Playback could not start. Try again or use the video controls.");
    video.controls = true;
  }
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => renderDemo(tab.dataset.demoRole));
  tab.addEventListener("keydown", (event) => {
    let targetIndex = null;
    if (event.key === "ArrowRight") targetIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") {
      targetIndex = (index - 1 + tabs.length) % tabs.length;
    }
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = tabs.length - 1;
    if (targetIndex === null) return;
    event.preventDefault();
    renderDemo(tabs[targetIndex].dataset.demoRole, { focus: true });
  });
}

playButton?.addEventListener("click", () => void playActiveDemo());
video?.addEventListener("play", () => {
  if (playButton) playButton.hidden = true;
  setStatus("");
});
video?.addEventListener("ended", () => {
  if (!playButton) return;
  playButton.disabled = false;
  playButton.hidden = false;
  playButton.textContent = `Replay ${DEMOS[activeRole].label} run`;
  setStatus("Run complete.");
});
video?.addEventListener("error", () => {
  if (!mediaLoaded || !playButton) return;
  playButton.disabled = false;
  playButton.hidden = false;
  playButton.textContent = "Try playback again";
  setStatus("The demo could not be loaded.");
});

renderDemo("researcher");
