import { expect, test } from "@playwright/test";

const mediaPath = (fileName: string) =>
  `./media/${fileName}?v=2026-07-30-clean-demos-v2`;

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test("initial load is minimal, outcome-led, and poster-only", async ({ page }) => {
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
      name: "Research and build from the notes you already have.",
    }),
  ).toBeVisible();
  await expect(page.locator("main > section")).toHaveCount(4);
  await expect(page.getByRole("link", { name: "Watch real runs" })).toBeVisible();

  const background = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(background).toBe("rgb(11, 13, 12)");

  for (const trustStep of [
    "Reads your context",
    "Runs approved tools",
    "Returns receipts",
  ]) {
    await expect(page.getByRole("heading", { level: 3, name: trustStep })).toBeAttached();
  }

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
  await expect(video.locator('source[type="video/webm"]')).toHaveAttribute(
    "data-src",
    mediaPath("researcher-demo.webm"),
  );
  expect(await video.locator('source[type="video/webm"]').getAttribute("src")).toBeNull();
  expect(videoRequests).toEqual([]);
});

test("explicit playback loads only the selected run and exposes controls", async ({
  page,
}) => {
  const videoRequests: string[] = [];
  page.on("request", (request) => {
    if (/\.(?:mp4|webm)(?:\?|$)/iu.test(request.url())) {
      videoRequests.push(request.url());
    }
  });
  await page.goto("/#demos");

  const video = page.locator("#role-demo");
  await page.getByRole("button", { name: "Play Researcher run" }).click();
  await expect(video.locator('source[type="video/mp4"]')).toHaveAttribute(
    "src",
    mediaPath("researcher-demo.mp4"),
  );
  await expect(video).toHaveJSProperty("controls", true);
  await expect(page.locator("#demo-play")).toBeHidden();
  expect(videoRequests.some((url) => url.includes("researcher-demo"))).toBe(true);
  expect(videoRequests.some((url) => url.includes("builder-demo"))).toBe(false);
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
  await expect(video).toHaveAttribute("poster", mediaPath("builder-demo-poster.jpg"));
  await expect(page.getByText("Tool delivered and checks passed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Play Builder run" })).toBeVisible();

  await builder.focus();
  await builder.press("ArrowLeft");
  await expect(researcher).toBeFocused();
  await expect(researcher).toHaveAttribute("aria-selected", "true");
  await researcher.press("End");
  await expect(builder).toBeFocused();
});

for (const viewport of viewports) {
  test(`${viewport.name} layout has no horizontal overflow`, async ({ page }, testInfo) => {
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
    await expect(page.getByRole("tablist", { name: "Choose a demo role" })).toBeVisible();
    await expect(page.locator("#role-demo")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-demos.png`),
      animations: "disabled",
      caret: "hide",
    });
  });
}

test("mobile keeps CTAs, selector, and the 16:9 demo readable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const primary = page.getByRole("link", { name: "Watch real runs" });
  const secondary = page.getByRole("link", { name: "Install the development build" }).first();
  const primaryBox = await primary.boundingBox();
  const secondaryBox = await secondary.boundingBox();
  expect(primaryBox?.width ?? 0).toBeGreaterThan(340);
  expect(secondaryBox?.width ?? 0).toBeGreaterThan(340);

  await page.locator("#demos").scrollIntoViewIfNeeded();
  const tablist = page.getByRole("tablist", { name: "Choose a demo role" });
  const frame = page.locator("#role-demo");
  await expect(tablist).toBeVisible();
  await expect(frame).toBeVisible();
  const box = await frame.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(340);
  expect(Math.abs((box?.width ?? 0) / (box?.height ?? 1) - 16 / 9)).toBeLessThan(0.05);
});

test("reduced motion disables smooth scroll and transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const motion = await page.evaluate(() => ({
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    buttonTransition: getComputedStyle(
      document.querySelector(".button") as HTMLElement,
    ).transitionDuration,
  }));
  expect(motion.scrollBehavior).toBe("auto");
  expect(motion.buttonTransition).toBe("0s");
});

test("navigation and conversion links have stable destinations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Demos" })).toHaveAttribute("href", "#demos");
  await expect(page.getByRole("link", { name: "Trust" })).toHaveAttribute("href", "#trust");
  await expect(page.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    /github\.com\/JoshuaNguyen123\/Obsidian_research_agent/u,
  );
  await expect(
    page.getByRole("link", { name: "Install the development build" }).first(),
  ).toHaveAttribute("href", /#install-for-development$/u);
});
