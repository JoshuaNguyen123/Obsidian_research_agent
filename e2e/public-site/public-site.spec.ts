import { expect, test } from "@playwright/test";

const mediaPath = (fileName: string) =>
  `./media/${fileName}?v=2026-07-30-clean-demos-v2`;

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test("initial load is poster-only and the Researcher demo is the default", async ({
  page,
}) => {
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    if (/\.(?:jpe?g|mp4|webm)(?:\?|$)/iu.test(request.url())) {
      mediaRequests.push(request.url());
    }
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const video = page.locator("#role-demo");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Research and build from the notes you already have.",
    }),
  ).toBeVisible();
  await expect(page.locator("main > section")).toHaveCount(4);
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
  await expect(video).toHaveAttribute(
    "poster",
    mediaPath("researcher-demo-poster.jpg"),
  );
  const webmSource = video.locator('source[type="video/webm"]');
  const mp4Source = video.locator('source[type="video/mp4"]');
  await expect(webmSource).toHaveAttribute(
    "data-src",
    mediaPath("researcher-demo.webm"),
  );
  await expect(mp4Source).toHaveAttribute(
    "data-src",
    mediaPath("researcher-demo.mp4"),
  );
  expect(await webmSource.getAttribute("src")).toBeNull();
  expect(await mp4Source.getAttribute("src")).toBeNull();
  await expect(
    page.getByRole("button", { name: "Play 21-second Researcher demo" }),
  ).toBeVisible();
  await expect(page.locator("#demo-poster-image")).toHaveAttribute(
    "src",
    mediaPath("researcher-demo-poster.jpg"),
  );
  await expect(video).toHaveAttribute("preload", "none");
  expect(
    await video.evaluate((element: HTMLVideoElement) => ({
      autoplay: element.autoplay,
      controls: element.controls,
      paused: element.paused,
    })),
  ).toEqual({ autoplay: false, controls: true, paused: true });
  expect(
    mediaRequests.filter((url) => /\.(?:mp4|webm)(?:\?|$)/iu.test(url)),
  ).toEqual([]);
  expect(
    mediaRequests.every((url) => /\.jpe?g(?:\?|$)/iu.test(url)),
  ).toBe(true);
});

test("mouse and keyboard role switching update one accessible media panel", async ({
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
  expect(
    await video.locator('source[type="video/webm"]').getAttribute("src"),
  ).toBeNull();
  await expect(page.locator("#demo-poster-image")).toHaveAttribute(
    "src",
    mediaPath("builder-demo-poster.jpg"),
  );
  await expect(
    page.getByRole("button", { name: "Play 25-second Builder demo" }),
  ).toBeVisible();
  await expect(
    page.getByText("Targeted + full validation", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Builder demo transcript", { exact: true }),
  ).toBeVisible();

  await builder.focus();
  await builder.press("ArrowLeft");
  await expect(researcher).toBeFocused();
  await expect(researcher).toHaveAttribute("aria-selected", "true");
  await expect(panel).toHaveAttribute("aria-labelledby", "researcher-tab");
  await researcher.press("End");
  await expect(builder).toBeFocused();
  await expect(builder).toHaveAttribute("aria-selected", "true");
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.paused),
  ).toBe(true);
});

test("poster activation loads only the selected role and reveals native playback", async ({
  page,
}) => {
  const videoRequests: string[] = [];
  page.on("request", (request) => {
    if (/\.(?:mp4|webm)(?:\?|$)/iu.test(request.url())) {
      videoRequests.push(request.url());
    }
  });

  await page.goto("/#demos");
  await page.getByRole("tab", { name: "Builder" }).click();
  const playButton = page.getByRole("button", {
    name: "Play 25-second Builder demo",
  });
  const requestedMedia = page.waitForRequest((request) =>
    /builder-demo\.(?:mp4|webm)(?:\?|$)/iu.test(request.url()),
  );
  await playButton.click();
  await requestedMedia;

  const video = page.locator("#role-demo");
  await expect(playButton).toBeHidden();
  await expect(video.locator('source[type="video/webm"]')).toHaveAttribute(
    "src",
    mediaPath("builder-demo.webm"),
  );
  await expect(video.locator('source[type="video/mp4"]')).toHaveAttribute(
    "src",
    mediaPath("builder-demo.mp4"),
  );
  expect(
    await video.evaluate((element: HTMLVideoElement) => ({
      autoplay: element.autoplay,
      controls: element.controls,
    })),
  ).toEqual({ autoplay: false, controls: true });
  expect(videoRequests.some((url) => /builder-demo\./iu.test(url))).toBe(true);
  expect(videoRequests.some((url) => /researcher-demo\./iu.test(url))).toBe(false);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
});

for (const viewport of viewports) {
  test(
    `${viewport.name} layout has no horizontal overflow`,
    async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await expect(page.locator("#hero-title")).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`${viewport.name}-hero.png`),
        animations: "disabled",
        caret: "hide",
      });

      await page.getByRole("link", { name: "Watch the demos" }).click();
      await expect(page).toHaveURL(/#demos$/u);
      await expect(
        page.getByRole("tablist", { name: "Choose a demo role" }),
      ).toBeVisible();
      await expect(page.locator("#role-demo")).toBeVisible();
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                document.querySelector("#demos")?.getBoundingClientRect().top ??
                Number.POSITIVE_INFINITY,
            ),
          { timeout: 5_000 },
        )
        .toBeLessThan(90);

      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        demoTop: document.querySelector("#demos")?.getBoundingClientRect().top ?? null,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
      expect(dimensions.demoTop).not.toBeNull();
      expect(dimensions.demoTop as number).toBeGreaterThanOrEqual(55);
      expect(dimensions.demoTop as number).toBeLessThan(90);
      await page.screenshot({
        path: testInfo.outputPath(`${viewport.name}-demos.png`),
        animations: "disabled",
        caret: "hide",
      });
    },
  );
}

test("mobile keeps the heading, selector, and 16:9 poster readable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#demos");

  const heading = page.getByRole("heading", {
    level: 2,
    name: "Choose the role. Give it the outcome.",
  });
  const tablist = page.getByRole("tablist", { name: "Choose a demo role" });
  const video = page.locator("#role-demo");
  await expect(heading).toBeVisible();
  await expect(tablist).toBeVisible();
  await expect(video).toBeVisible();

  const [headingBox, tablistBox, videoBox] = await Promise.all([
    heading.boundingBox(),
    tablist.boundingBox(),
    video.boundingBox(),
  ]);
  expect(headingBox?.width ?? 0).toBeGreaterThan(300);
  expect(tablistBox?.width ?? 0).toBeGreaterThan(340);
  expect(videoBox?.width ?? 0).toBeGreaterThanOrEqual(388);
  expect(videoBox?.height ?? 0).toBeGreaterThanOrEqual(215);
  expect(Math.abs((videoBox?.width ?? 0) / (videoBox?.height ?? 1) - 16 / 9)).toBeLessThan(
    0.03,
  );
});

test("reduced-motion preference disables smooth scrolling and transitions", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const motion = await page.evaluate(() => ({
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    buttonTransition: getComputedStyle(
      document.querySelector(".button") as HTMLElement,
    ).transitionDuration,
    playTransition: getComputedStyle(
      document.querySelector(".demo-play-icon") as HTMLElement,
    ).transitionDuration,
  }));
  expect(motion.scrollBehavior).toBe("auto");
  expect(motion.buttonTransition).toBe("0s");
  expect(motion.playTransition).toBe("0s");
});
