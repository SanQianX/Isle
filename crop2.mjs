import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const url = 'file:///' + process.cwd().split('\').join('/') + '/e2e/__screenshots__/local/chromium/vr-01-home-hero.png';
await p.setContent('<body style="margin:0;overflow:hidden"><img src="' + url + '" style="display:block;margin-top:-28px"></body>');
await p.waitForTimeout(500);
await p.screenshot({ path: '.ui-shots/new-baseline-header.png', clip: { x: 900, y: 0, width: 540, height: 80 } });
await b.close();
