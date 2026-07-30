const MEDIA_VERSION = "2026-07-30-clean-demos-v2";
const mediaPath = (fileName) =>
  `./media/${fileName}?v=${MEDIA_VERSION}`;

const DEMOS = Object.freeze({
  researcher: Object.freeze({
    label: "Researcher",
    outcome: "Turn a research brief into a cited decision.",
    description:
      "The agent reads one useful note, checks its two linked sources, and appends a compact decision with citations and a verified write receipt.",
    proof: Object.freeze([
      "Active-note brief",
      "Two source readbacks",
      "Verified append",
    ]),
    poster: mediaPath("researcher-demo-poster.jpg"),
    webm: mediaPath("researcher-demo.webm"),
    mp4: mediaPath("researcher-demo.mp4"),
    durationSeconds: 21,
    ariaLabel:
      "Researcher demo: a real run turns a note-search brief into a cited decision",
    transcript: Object.freeze([
      "The active note defines a real note-search decision and links two sources.",
      "The user asks the agent to compare only those sources.",
      "A concise, cited decision is appended to the note.",
      "Run Details confirms the append with a verified receipt.",
    ]),
  }),
  builder: Object.freeze({
    label: "Builder",
    outcome: "Turn a working brief into a tested tool.",
    description:
      "The agent reads the note's acceptance criteria, builds a Python CLI, validates it with sample files, and delivers the verified result.",
    proof: Object.freeze([
      "Note-led acceptance criteria",
      "Targeted + full validation",
      "Verified delivery",
    ]),
    poster: mediaPath("builder-demo-poster.jpg"),
    webm: mediaPath("builder-demo.webm"),
    mp4: mediaPath("builder-demo.mp4"),
    durationSeconds: 25,
    ariaLabel:
      "Builder demo: a real run turns text-file acceptance criteria into a tested Python tool",
    transcript: Object.freeze([
      "The active note defines a text-file organizer and its acceptance criteria.",
      "The agent creates a trusted workspace and builds the Python CLI.",
      "Sample files, targeted checks, and a fresh full run prove the tool works.",
      "Run Details confirms the delivered file and mission acceptance.",
    ]),
  }),
});

const tabs = Array.from(document.querySelectorAll("[data-demo-role]"));
const panel = document.querySelector("#demo-panel");
const video = document.querySelector("#role-demo");
const webmSource = document.querySelector("#role-demo-webm");
const mp4Source = document.querySelector("#role-demo-mp4");
const playButton = document.querySelector("#demo-play");
const posterImage = document.querySelector("#demo-poster-image");
const roleLabel = document.querySelector("#demo-role-label");
const outcome = document.querySelector("#demo-outcome");
const description = document.querySelector("#demo-description");
const proof = document.querySelector("#demo-proof");
const transcriptSummary = document.querySelector("#demo-transcript-summary");
const transcriptSteps = document.querySelector("#demo-transcript-steps");
const demoMedia = document.querySelector(".demo-media");
let activeRole = "researcher";

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
  video.pause();
  webmSource?.removeAttribute("src");
  mp4Source?.removeAttribute("src");
  webmSource?.setAttribute("data-src", demo.webm);
  mp4Source?.setAttribute("data-src", demo.mp4);
  video.poster = demo.poster;
  video.setAttribute("aria-label", demo.ariaLabel);
  video.load();
  if (posterImage) posterImage.src = demo.poster;
  if (playButton) {
    playButton.hidden = false;
    playButton.setAttribute(
      "aria-label",
      `Play ${demo.durationSeconds}-second ${demo.label} demo`,
    );
  }

  panel.setAttribute("aria-labelledby", selectedTab.id);
  roleLabel.textContent = demo.label;
  outcome.textContent = demo.outcome;
  description.textContent = demo.description;
  proof.setAttribute("aria-label", `${demo.label} demo proof`);
  proof.replaceChildren(
    ...demo.proof.map((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      return li;
    }),
  );
  transcriptSummary.textContent = `${demo.label} demo transcript`;
  transcriptSteps.replaceChildren(
    ...demo.transcript.map((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      return li;
    }),
  );

  if (options.focus === true) selectedTab.focus();
}

async function playActiveDemo() {
  const demo = DEMOS[activeRole];
  if (!demo || !video || !playButton) return;
  webmSource?.setAttribute("src", demo.webm);
  mp4Source?.setAttribute("src", demo.mp4);
  video.load();
  playButton.hidden = true;
  try {
    await video.play();
  } catch {
    playButton.hidden = false;
  }
}

function bindPlayHandlers() {
  if (!video || !playButton) return;

  const startPlayback = (event) => {
    if (!video.paused) return;
    event?.preventDefault();
    void playActiveDemo();
  };

  playButton.addEventListener("click", startPlayback);

  // Clicking the player surface (including poster area) should activate the
  // selected role's video. Native controls remain available once media is loaded.
  video.addEventListener("click", (event) => {
    if (event.target !== video) return;
    startPlayback(event);
  });

  demoMedia?.addEventListener("click", (event) => {
    if (event.target !== demoMedia) return;
    startPlayback(event);
  });

  video.addEventListener("ended", () => {
    playButton.hidden = false;
  });

  video.addEventListener("pause", () => {
    if (video.ended) {
      playButton.hidden = false;
    }
  });
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => renderDemo(tab.dataset.demoRole));
  tab.addEventListener("keydown", (event) => {
    let targetIndex = null;
    if (event.key === "ArrowRight") targetIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") targetIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = tabs.length - 1;
    if (targetIndex === null) return;
    event.preventDefault();
    renderDemo(tabs[targetIndex].dataset.demoRole, { focus: true });
  });
}

bindPlayHandlers();
