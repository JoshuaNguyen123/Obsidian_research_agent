import { expect, test } from "@playwright/test";

const mediaPath = (fileName: string) =>
  `./media/${fileName}?v=2026-07-30-clean-demos-v2`;

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test("initial load is executive, black, poster-only, Researcher-default", async ({
  page,
}) => {
  const videoRequests: string[] = [];
  page.on("request", (request) => {
    if (/\.(?:mp4|webm)(?:\?|$)/iu.test(request.url())) {
      videoRequests.push(request.url());
    }
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "The research assistant that works inside your vault.",
    }),
  ).toBeVisible();
  await expect(page.locator("main > section")).toHaveCount(4);

  // Executive black-and-white surface.
  const bg = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(bg).toBe("rgb(0, 0, 0)");

  for (const assurance of [
    "Local-first context",
    "Append-first writing",
    "Approval-gated actions",
  ]) {
    await expect(
      page.getByRole("heading", { level: 3, name: assurance }),
    ).toBeAttached();
  }
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Bring the next task into your vault.",
    }),
  ).toBeAttached();

  await expect(page.getByRole("tab", { name: "Researcher" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const video = page.locator("#role-demo");
  await expect(video).toHaveAttribute(
    "poster",
    mediaPath("researcher-demo-poster.jpg"),
  );
  await expect(video).toHaveAttribute("preload", "none");
  const webmSource = video.locator('source[type="video/webm"]');
  await expect(webmSource).toHaveAttribute(
    "data-src",
    mediaPath("researcher-demo.webm"),
  );
  expect(await webmSource.getAttribute("src")).toBeNull();

  // Nothing heavy streams before the run scrolls into view.
  expect(videoRequests).toEqual([]);
});

test("scrolling scrubs the run: currentTime and progress advance with scroll", async ({
  page,
}) => {
  await page.goto("/");
  // Drive scroll to ~60% through the pinned demo track.
  await page.evaluate(() => {
    const track = document.querySelector(".demo-scroll") as HTMLElement;
    const absTop = track.getBoundingClientRect().top + window.scrollY;
    const start = absTop - 64;
    const end = absTop + track.offsetHeight - window.innerHeight;
    window.scrollTo(0, start + (end - start) * 0.6);
    window.dispatchEvent(new Event("scroll"));
  });

  const video = page.locator("#role-demo");
  // The active source is lazily attached once the run enters the viewport.
  await expect(video.locator('source[type="video/mp4"]')).toHaveAttribute(
    "src",
    mediaPath("researcher-demo.mp4"),
  );

  // Nudge the scroll a few times so the metadata-loaded video seeks.
  await expect
    .poll(
      async () => {
        await page.evaluate(() =>
          window.dispatchEvent(new Event("scroll")),
        );
        return page
          .locator("#role-demo")
          .evaluate((element: HTMLVideoElement) => element.currentTime);
      },
      { timeout: 8_000 },
    )
    .toBeGreaterThan(0.1);

  const fillWidth = await page.evaluate(
    () =>
      (document.querySelector("#demo-scrubline-fill") as HTMLElement).style
        .width,
  );
  expect(parseFloat(fillWidth)).toBeGreaterThan(0);

  const activeSteps = await page
    .locator('#demo-steps li[data-active="true"]')
    .count();
  expect(activeSteps).toBeGreaterThan(0);
});

test("mouse and keyboard role switching update one accessible panel", async ({
  page,
}) => {
  await page.goto("/#demos");
  const researcher = page.getByRole("tab", { name: "Researcher" });
  const builder = page.getByRole("tab", { name: "Builder" });
  const panel = page.getByRole("tabpanel");
  const video = page.locator("#role-demo");

  await builder.click();
  await expect(builder).toHaveAttribute("aria-selected", "true");
  await expect(researcher).toHaveAttribute("aria-selected", "false");
  await expect(panel).toHaveAttribute("aria-labelledby", "builder-tab");
  await expect(
    page.getByRole("heading", {
      level: 3,
      name: "Turn a working brief into a tested tool.",
    }),
  ).toBeVisible();
  await expect(video).toHaveAttribute(
    "poster",
    mediaPath("builder-demo-poster.jpg"),
  );
  await expect(video.locator('source[type="video/webm"]')).toHaveAttribute(
    "data-src",
    mediaPath("builder-demo.webm"),
  );
  await expect(
    page.getByText("Runs targeted and full checks", { exact: true }),
  ).toBeVisible();

  await builder.focus();
  await builder.press("ArrowLeft");
  await expect(researcher).toBeFocused();
  await expect(researcher).toHaveAttribute("aria-selected", "true");
  await expect(panel).toHaveAttribute("aria-labelledby", "researcher-tab");
  await researcher.press("End");
  await expect(builder).toBeFocused();
  await expect(builder).toHaveAttribute("aria-selected", "true");
});

for (const viewport of viewports) {
  test(`${viewport.name} layout has no horizontal overflow`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator("#hero-title")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-hero.png`),
      animations: "disabled",
      caret: "hide",
    });

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

    await page.locator("#demos").scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("tablist", { name: "Choose a demo role" }),
    ).toBeVisible();
    await expect(page.locator("#role-demo")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-demos.png`),
      animations: "disabled",
      caret: "hide",
    });
  });
}

test("mobile keeps the heading, selector, and 16:9 frame readable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#demos");

  const heading = page.getByRole("heading", {
    level: 2,
    name: "Scroll to watch a real run unfold.",
  });
  const tablist = page.getByRole("tablist", { name: "Choose a demo role" });
  const frame = page.locator("#role-demo");
  await expect(heading).toBeVisible();
  await expect(tablist).toBeVisible();
  await expect(frame).toBeVisible();

  const box = await frame.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);
  expect(Math.abs((box?.width ?? 0) / (box?.height ?? 1) - 16 / 9)).toBeLessThan(
    0.05,
  );
});

test("reduced motion disables scrubbing, smooth scroll, and transitions", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const motion = await page.evaluate(() => ({
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    buttonTransition: getComputedStyle(
      document.querySelector(".button") as HTMLElement,
    ).transitionDuration,
    stagePosition: getComputedStyle(
      document.querySelector(".demo-stage") as HTMLElement,
    ).position,
  }));
  expect(motion.scrollBehavior).toBe("auto");
  expect(motion.buttonTransition).toBe("0s");
  // No scrub track under reduced motion: the stage is a static block.
  expect(motion.stagePosition).toBe("static");

  // The run stays viewable via native controls instead of scroll scrubbing.
  await expect(page.locator("#role-demo")).toHaveJSProperty("controls", true);
});
