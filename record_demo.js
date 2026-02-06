const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/llogangokul/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: 'videos/' } // Optional: Playwright can record video directly!
  });
  context.setDefaultTimeout(60000); // 60s timeout
  const page = await context.newPage();
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err));
  page.on('requestfailed', req => console.log('REQUEST FAILED:', req.url(), req.failure().errorText));

  console.log('1. Login...');
  await page.goto('http://localhost:3000/auth/sign-in', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="email"]');
  await page.screenshot({ path: '1_login.png' });

  await page.fill('input[name="email"]', 'admin@example.com');
  await page.fill('input[name="password"]', 'password');
  await page.click('button[type="submit"]');
  
  console.log('2. Catalog...');
  // Wait for navigation
  await page.waitForURL('**/');
  await page.goto('http://localhost:3000/mcp-catalog', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button:has-text("Add MCP Server")');
  await page.screenshot({ path: '2_catalog.png' });

  console.log('3. Add Server...');
  // Click "Add MCP Server"
  await page.click('button:has-text("Add MCP Server")');
  await page.waitForTimeout(1000);
  
  // Click "Self-hosted" (Local)
  await page.click('button:has-text("Self-hosted")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '3_add_server.png' });

  console.log('4. Fill Form...');
  await page.fill('input[name="name"]', 'Mock UI Server');
  await page.fill('input[name="localConfig.command"]', 'python3');
  await page.fill('textarea[name="localConfig.arguments"]', '/home/llogangokul/.openclaw/workspace/projects/archestra/mock_mcp_server.py');
  await page.screenshot({ path: '4_form_filled.png' });

  await page.click('button:has-text("Add Server")');
  // Wait for modal to close and list to update
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '5_server_added.png' });

  console.log('5. Chat...');
  await page.goto('http://localhost:3000/chat');
  await page.waitForLoadState('networkidle');
  
  // Send message
  const inputSelector = 'textarea[placeholder="Send a message..."]';
  await page.waitForSelector(inputSelector);
  await page.fill(inputSelector, "Render a widget called 'Archestra Bounty Status'");
  await page.press(inputSelector, 'Enter');
  
  console.log('Waiting for response...');
  // Wait for the widget to appear (it has "Archestra Bounty Status" text)
  try {
    await page.waitForSelector('text=Archestra Bounty Status', { timeout: 30000 });
    console.log('Widget rendered!');
    await page.waitForTimeout(1000); // Wait for animation
    await page.screenshot({ path: '6_chat_widget.png' });

    // Click the button
    await page.click('button:has-text("Click Me")');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '7_clicked.png' });
  } catch (e) {
    console.log('Widget did not render in time, taking screenshot anyway...');
    await page.screenshot({ path: '6_chat_fail.png' });
  }

  await browser.close();
  console.log('Done.');
})();
