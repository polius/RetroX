#!/usr/bin/env python3
"""Sign in to a RetroX instance once, by hand, and keep the session cookie.

Opens a real browser window on the login page. You sign in yourself (your
password never touches this script); as soon as the app leaves /login, the
browser's storage state is written to .auth/state.json and the window closes.

  login.py https://retrox.example.com
"""
import os
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, ".auth", "state.json")


def main():
    base = sys.argv[1].rstrip("/")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(headless=False)
        ctx = b.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.goto(f"{base}/login")
        page.wait_for_url(lambda u: "/login" not in u, timeout=15 * 60 * 1000)
        page.wait_for_load_state("networkidle")
        ctx.storage_state(path=OUT)
        os.chmod(OUT, 0o600)
        b.close()
    print(f"signed in, session saved -> {OUT}")


if __name__ == "__main__":
    main()
