#!/usr/bin/env python3
"""Regenerate docs/screenshots/*.png from the mocked UI.

    VITE_MOCK=1 npm run dev              # terminal 1
    python3 docs/screenshots/capture.py  # terminal 2

Renders through WebKitGTK — the same engine the Linux build ships with — so
the screenshots show what the app actually looks like rather than what another
browser would make of the same CSS.

Needs the GTK introspection bindings:
    sudo apt install gir1.2-webkit2-4.1 python3-gi
"""

import os
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

OUT = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("BASE_URL", "http://localhost:1420")
WIDTH, HEIGHT = 1200, 780

def click_when_ready(selector):
    """Click as soon as React has mounted the element.

    A fixed delay is not enough: how long the first render takes moves with
    machine load, and a click that lands early fails silently, leaving a
    screenshot of the wrong screen.
    """
    sel = repr(selector)
    return (
        f"(function attempt(n) {{"
        f"  const el = document.querySelector({sel});"
        f"  if (el) return el.click();"
        f"  if (n > 0) setTimeout(() => attempt(n - 1), 150);"
        f"}})(30)"
    )


# (filename, url, javascript run once loaded, selector that must exist before
#  the grab, extra settle time)
SHOTS = [
    ("onboarding.png", f"{BASE}/?mock=fresh", "", "input[type=password]", 0.6),
    (
        "search.png",
        BASE,
        "document.querySelector('input')?.focus()",
        "input",
        0.4,
    ),
    (
        "settings.png",
        BASE,
        click_when_ready('button[title="Settings"]'),
        # the model count only appears once the mocked list has resolved
        "select",
        1.2,
    ),
    (
        "light-theme.png",
        BASE,
        "localStorage.setItem('docfindy.theme','light');"
        "document.documentElement.classList.add('light')",
        "html.light",
        0.5,
    ),
]


class Capture:
    def __init__(self):
        self.queue = list(SHOTS)
        self.failures = []

        self.window = Gtk.OffscreenWindow()
        self.window.set_default_size(WIDTH, HEIGHT)
        self.view = WebKit2.WebView()
        self.view.set_size_request(WIDTH, HEIGHT)
        self.window.add(self.view)
        self.window.show_all()
        self.view.connect("load-changed", self.on_load)

    def next_shot(self):
        if not self.queue:
            Gtk.main_quit()
            return
        self.name, url, self.script, self.expect, self.settle = self.queue.pop(0)
        self.waited = 0.0
        # Each shot starts from a clean slate: the theme is persisted, and a
        # leftover value would silently colour the next screenshot.
        self.view.load_uri(url)

    def on_load(self, _view, event):
        if event != WebKit2.LoadEvent.FINISHED:
            return
        GLib.timeout_add(900, self.run_script)

    def run_script(self):
        if self.script:
            self.view.run_javascript(self.script, None, None, None)
        GLib.timeout_add(200, self.wait_for_expected)
        return False

    def wait_for_expected(self):
        """Poll until the shot's marker element is on the page, then settle."""
        self.view.run_javascript(
            f"!!document.querySelector({self.expect!r})", None, self.on_expected, None
        )
        return False

    def on_expected(self, view, result, _data):
        try:
            found = view.run_javascript_finish(result).get_js_value().to_boolean()
        except GLib.Error:
            found = False
        if found:
            GLib.timeout_add(int(self.settle * 1000), self.snap)
            return
        self.waited += 0.2
        if self.waited > 10:
            self.failures.append(f"{self.name}: {self.expect} never appeared")
            print(f"FAILED {self.name}: {self.expect} never appeared", file=sys.stderr)
            GLib.timeout_add(100, lambda: (self.next_shot(), False)[1])
            return
        GLib.timeout_add(200, self.wait_for_expected)

    def snap(self):
        # Pull the pixels off the offscreen window as a GdkPixbuf rather than
        # through WebKit's own snapshot API: that one hands back a
        # cairo.Surface, which needs pycairo, which is one dependency more than
        # this script is worth. Flush pending draws first, or the grab can
        # catch a half-painted frame.
        while Gtk.events_pending():
            Gtk.main_iteration()
        pixbuf = self.window.get_pixbuf()
        if pixbuf is None:
            self.failures.append(f"{self.name}: offscreen window had no pixels")
            print(f"FAILED {self.name}: no pixels", file=sys.stderr)
        else:
            path = os.path.join(OUT, self.name)
            pixbuf.savev(path, "png", [], [])
            print(f"wrote {self.name} ({pixbuf.get_width()}x{pixbuf.get_height()})")
        # clear the persisted theme before the next page
        self.view.run_javascript(
            "localStorage.removeItem('docfindy.theme')", None, None, None
        )
        GLib.timeout_add(200, lambda: (self.next_shot(), False)[1])
        return False


def main():
    cap = Capture()
    GLib.timeout_add(300, lambda: (cap.next_shot(), False)[1])
    # hard stop, so a page that never finishes loading cannot hang a CI run
    GLib.timeout_add_seconds(120, Gtk.main_quit)
    Gtk.main()
    if cap.failures:
        sys.exit("\n".join(cap.failures))


if __name__ == "__main__":
    main()
