import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8795', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 1600})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:8795/'); page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        print('tabs:', page.locator('nav.tabs a').all_inner_texts())
        page.click('nav.tabs a:has-text("Settings")'); page.wait_for_timeout(200)
        print('headings:', page.locator('#app h1, #app h2').all_inner_texts())
        print('footer:', page.inner_text('.buildinfo'))
        page.goto('http://localhost:8795/#log'); page.wait_for_timeout(200)
        print('log has backup:', page.locator('text=Export backup').count())
        page.goto('http://localhost:8795/#aircraft/N12345'); page.wait_for_timeout(200)
        print('tail kicker:', page.locator('.top .kicker').first.inner_text())
        page.goto('http://localhost:8795/#aircraft'); page.wait_for_timeout(200)
        page.screenshot(path=OUT+'/settings.png', full_page=True)
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
