import { describe, expect, it } from "vitest"
import { buildStyleForTest } from "./ui.js"
import { DEFAULT_THEME } from "./theme.js"

const css = buildStyleForTest(DEFAULT_THEME)

/**
 * The phone rules, measured on a 390x844 viewport before they existed.
 *
 * Asserted against the stylesheet rather than a rendered page because the touch rules sit behind
 * `pointer: coarse`, which a desktop browser never matches however small the window is — so a
 * rendering test would report them working while they were absent on every real phone.
 */
describe("the widget on a phone", () => {
  it("stops iOS zooming the shop's page when someone taps the message box", () => {
    // Below 16px, Safari scales the whole host page on focus and the visitor has to pinch back
    // out. Measured at 14.5px. It is the most common way an embedded widget feels broken.
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*?textarea\s*{\s*font-size: 16px/)
  })

  it("gives the controls a finger-sized target on touch", () => {
    // Measured: close 32 square, send 40. Both under the 44px a finger reliably hits, and both
    // are the controls a visitor needs when they are trying to leave or to send.
    const coarse = css.slice(css.indexOf("@media (pointer: coarse)"))
    expect(coarse).toMatch(/\.close\s*{[^}]*width: 44px[^}]*height: 44px/)
    expect(coarse).toMatch(/\.send\s*{[^}]*width: 48px[^}]*height: 48px/)
  })

  it("measures its height against the viewport that actually exists", () => {
    // `inset: 0` alone is the height with the browser chrome hidden, so the composer sat behind
    // the URL bar until the visitor scrolled.
    expect(css).toMatch(/height: 100dvh/)
  })

  it("keeps the composer clear of the home indicator and the notch", () => {
    expect(css).toMatch(/padding-bottom: env\(safe-area-inset-bottom/)
    expect(css).toMatch(/padding-top: calc\(14px \+ env\(safe-area-inset-top/)
  })

  it("collapses the launcher to a disc where a pill would cover the page", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 480px)"))
    expect(phone).toMatch(/\.launcher\s*{[^}]*border-radius: 50%/)
  })
})
