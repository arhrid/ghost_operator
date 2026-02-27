import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

(async () => {
  const browser = await chromium.launch();

  // Full dashboard screenshot
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`file://${join(__dirname, 'mock-dashboard.html')}`);
  await page.waitForTimeout(500);
  await page.screenshot({
    path: join(__dirname, 'dashboard-full.png'),
    fullPage: false,
  });
  console.log('Captured: dashboard-full.png');

  // Incident feed close-up
  const incidentCard = page.locator('.card').nth(2);
  await incidentCard.screenshot({
    path: join(__dirname, 'dashboard-incidents.png'),
  });
  console.log('Captured: dashboard-incidents.png');

  // Activity log close-up
  const activityCard = page.locator('.card').nth(3);
  await activityCard.screenshot({
    path: join(__dirname, 'dashboard-activity.png'),
  });
  console.log('Captured: dashboard-activity.png');

  await browser.close();
  console.log('Done.');
})();
