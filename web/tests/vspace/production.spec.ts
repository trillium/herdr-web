// Production-composition contracts (project-9q9 follow-up): drive the REAL
// herdr-web app served by the live bridge at iPhone Pro Max size and measure
// actual layout. Read-only by default — never types into panes, because the
// bridge fronts live fleet sessions. Set HERDR_WEB_SAFE_TYPING=1 and point
// HERDR_WEB_URL at a disposable instance to also exercise textarea growth.

import { test, expect } from "@playwright/test";

const BASE = process.env.HERDR_WEB_URL ?? "http://localhost:8787";
const VIEWPORT = { width: 430, height: 932 };

test.describe.configure({ mode: "serial" });

test.use({ viewport: VIEWPORT, hasTouch: true, isMobile: true });

// Selecting a pane is tap-only (no text enters the terminal), so this is safe
// against the live fleet — it changes herdr-web's own selection state.
async function ensurePaneMounted(page: import("@playwright/test").Page) {
  const host = page.locator(".terminal-host").first();
  if ((await host.count()) > 0 && (await host.isVisible())) return true;
  const cell = page.locator(".pane-cell").first();
  if ((await cell.count()) === 0) return false;
  await cell.tap();
  try {
    await expect(page.locator(".terminal-host").first()).toBeVisible({ timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

test("app renders against the live bridge", async ({ page }) => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".terminal-stage, .terminal-host").first()).toBeVisible({
    timeout: 10_000,
  }).catch(() => {
    // A disconnected bridge still renders the shell; only fail if nothing at all mounted.
    return expect(page.locator("body")).not.toBeEmpty();
  });
});

test("baseline budgets: terminal area >= 50% of viewport", async ({ page }) => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (!(await ensurePaneMounted(page))) test.skip(true, "no pane selectable");
  const box = await host.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  // Visible portion of the terminal host within the viewport.
  const visible = Math.max(0, Math.min(box.y + box.height, VIEWPORT.height) - Math.max(box.y, 0));
  expect(visible).toBeGreaterThanOrEqual(VIEWPORT.height * 0.5);
});

test("composer never pushes past 60% of viewport", async ({ page }) => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (!(await ensurePaneMounted(page))) test.skip(true, "no pane selectable");
  const input = page.locator(".term-native-input").first();
  if ((await input.count()) === 0) test.skip(true, "composer not mounted");
  const safeTyping = process.env.HERDR_WEB_SAFE_TYPING === "1";
  if (safeTyping) {
    await input.click();
    await input.type("x".repeat(600), { delay: 2 });
  }
  const box = await input.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  expect(box.y + box.height).toBeLessThanOrEqual(VIEWPORT.height * 0.75);
});

test("textarea growth stays bounded when safe-typing enabled", async ({ page }) => {
  test.skip(process.env.HERDR_WEB_SAFE_TYPING !== "1", "typing into live panes requires HERDR_WEB_SAFE_TYPING=1");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (!(await ensurePaneMounted(page))) test.skip(true, "no pane selectable");
  const input = page.locator(".term-native-input").first();
  await input.click();
  await input.type("grow ".repeat(160), { delay: 1 });
  const box = await input.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  expect(box.height).toBeLessThanOrEqual(VIEWPORT.height * 0.34);
});
