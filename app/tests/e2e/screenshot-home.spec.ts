import { test } from '@playwright/test'

/**
 * 5 viewport スクショ。
 * playwright.config.ts の projects (desktop 1280 / tablet 768 / mobile 375) 全てで撮影。
 * 認証未済状態の表示確認。
 */

test('home page', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.screenshot({
    path: `tests/screenshots/home-${testInfo.project.name}.png`,
    fullPage: true,
  })
})

test('templates page (auth required)', async ({ page }, testInfo) => {
  await page.goto('/templates')
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.screenshot({
    path: `tests/screenshots/templates-${testInfo.project.name}.png`,
    fullPage: true,
  })
})

test('templates new page (auth required)', async ({ page }, testInfo) => {
  await page.goto('/templates/new')
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.screenshot({
    path: `tests/screenshots/templates-new-${testInfo.project.name}.png`,
    fullPage: true,
  })
})
