const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { createProfile } = require('../src/stealth-profile');

describe('stealth script in browser context', () => {
  let browser;
  let context;
  let page;
  let profile;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    profile = createProfile({ nodeCode: 'node-a', channelId: 1 });
    context = await browser.newContext({
      userAgent: profile.userAgent,
      viewport: profile.viewport,
      locale: profile.locale,
      timezoneId: profile.timezoneId,
    });
    await context.addInitScript(profile.stealthScript);
    page = await context.newPage();
  });

  after(async () => {
    if (context) await context.close();
    if (browser) await browser.close();
  });

  it('hides navigator.webdriver', async () => {
    const webdriver = await page.evaluate(() => navigator.webdriver);
    assert.strictEqual(webdriver, undefined);
  });

  it('sets navigator.languages from profile', async () => {
    const languages = await page.evaluate(() => navigator.languages);
    assert.deepStrictEqual(languages, profile.languages);
  });

  it('sets navigator.platform from profile', async () => {
    const platform = await page.evaluate(() => navigator.platform);
    assert.ok(['Win32', 'MacIntel', 'Linux x86_64', 'iPad', 'iPhone'].includes(platform));
  });
});
