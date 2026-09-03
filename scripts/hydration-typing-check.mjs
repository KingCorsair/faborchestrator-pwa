/** Does typing before hydration survive, and does sign-in then work? */
import { chromium } from "playwright";
import fs from "node:fs";
const ROOT = "C:/Users/ATUL ANAND/OneDrive/Documentos/Desktop/AthenaTech/faborchestrator-pwa";
const env = Object.fromEntries(fs.readFileSync(`${ROOT}/.env`,"utf8").split(/\r?\n/)
  .filter(l=>l&&!l.startsWith("#")&&l.includes("=")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true });
const p = await ctx.newPage();
// Fill IMMEDIATELY on domcontentloaded — before hydration. That is the hazard.
await p.goto("https://faborch-demo.fly.dev/login", { waitUntil: "domcontentloaded" });
await p.fill('input[type="email"]', env.FABORCH_PROBE_EMAIL);
await p.fill('input[type="password"]', env.FABORCH_PROBE_PASSWORD);
await p.waitForFunction(() => { const b=document.querySelector('button[type="submit"]'); return !!b && !b.disabled; }, null, { timeout: 40000 });
const kept = await p.locator('input[type="email"]').inputValue();
console.log(`  email survived hydration : ${kept === env.FABORCH_PROBE_EMAIL ? "YES" : "NO ('" + kept + "')"}`);
await p.click('button[type="submit"]');
await p.waitForFunction(() => !location.pathname.startsWith("/login"), null, { timeout: 60000 }).catch(()=>{});
console.log(`  signed in                : ${await p.evaluate(() => !!localStorage.getItem("llmatscale_auth_token"))}`);
console.log(`  landed on                : ${p.url()}`);
await b.close();
