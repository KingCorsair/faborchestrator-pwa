import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isIOSPlatform } from "../../lib/platform";

/**
 * Real user-agent strings, not invented ones. The whole value of this function
 * is in devices that misreport themselves, and a made-up UA cannot reproduce
 * that — it would only assert that the regex matches the string I wrote for it.
 */
const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
  ipadOS13Plus:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windowsTouch:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

describe("isIOSPlatform", () => {
  test("detects an iPhone", () => {
    assert.equal(isIOSPlatform(UA.iphoneSafari, 5), true);
  });

  test("detects an iPhone running Chrome, which is still WebKit underneath", () => {
    assert.equal(isIOSPlatform(UA.iphoneChrome, 5), true);
  });

  /**
   * The case the whole function exists for. iPadOS 13+ sends a Macintosh UA
   * with no iPad token anywhere in it, so the string alone is indistinguishable
   * from a desktop Safari — only the touch points separate them.
   */
  test("detects an iPad despite it claiming to be a Macintosh", () => {
    assert.equal(isIOSPlatform(UA.ipadOS13Plus, 5), true);
  });

  test("does not mistake a desktop Mac for an iPad", () => {
    // Byte-for-byte the same UA as the iPad above. Only the touch count differs,
    // which is the point: a Mac reports 0 even with a trackpad attached.
    assert.equal(UA.macSafari, UA.ipadOS13Plus);
    assert.equal(isIOSPlatform(UA.macSafari, 0), false);
  });

  test("does not fire on Android, which has its own install prompt", () => {
    assert.equal(isIOSPlatform(UA.androidChrome, 5), false);
  });

  test("does not fire on Windows", () => {
    assert.equal(isIOSPlatform(UA.windowsChrome, 0), false);
  });

  /**
   * A touchscreen Windows laptop reports plenty of touch points. The Macintosh
   * check has to gate the touch check, not the other way round — otherwise
   * every Surface gets told to use a Share menu it does not have.
   */
  test("does not fire on a touchscreen Windows laptop", () => {
    assert.equal(isIOSPlatform(UA.windowsTouch, 10), false);
  });

  test("treats a single touch point as not-an-iPad", () => {
    // maxTouchPoints of 1 is reported by some non-Apple hybrids and by a Mac
    // with a touch-capable peripheral. The threshold is > 1 for that reason.
    assert.equal(isIOSPlatform(UA.macSafari, 1), false);
  });
});
