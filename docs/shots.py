# Regenerates the README screenshots in docs/img/ from sample data (tail N12345, made-up route).
# Usage: python3 docs/shots.py   (needs Playwright, same as test/ui)
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
IMG = os.path.join(ROOT, 'docs', 'img')
os.makedirs(IMG, exist_ok=True)
M = 60000
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8799', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs = []

def typ(page, sel, v):
    page.fill(sel, v); page.locator(sel).dispatch_event('input'); page.locator(sel).dispatch_event('change')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, timezone_id='America/Chicago')
        page = ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 23, 15, 0, 0, 0, 0, -1)))
        def shot(n):
            page.evaluate('window.scrollTo(0, 0)'); page.wait_for_timeout(100); page.screenshot(path=f'{IMG}/{n}.png')
        page.goto('http://localhost:8799/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft'); page.wait_for_timeout(200)
        page.fill('#s-from', 'KAAA'); page.fill('#s-to', 'KBBB')
        typ(page, '#s-ete', '4:33'); typ(page, '#s-fuel', '64.0'); page.locator('#s-fuel').blur(); page.wait_for_timeout(3500)
        shot('setup')
        page.click('text=Build plan'); page.wait_for_timeout(200)
        shot('plan')
        page.click('text=Start flight'); typ(page, '#sd-at', '0:20:00'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.clock.run_for(5 * M); page.wait_for_timeout(300)
        if page.locator('#alertbar .inner').count(): page.keyboard.press('Escape')
        shot('fly')
        page.click('[data-sheet=check]'); typ(page, '#sd-used', '9.1'); typ(page, '#sd-gph', '14.2'); page.wait_for_timeout(100)
        shot('check')
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
