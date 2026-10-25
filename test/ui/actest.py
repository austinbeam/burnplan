import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8790', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:8790/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.goto('http://localhost:8790/#aircraft/N12345'); page.wait_for_timeout(200)
        print('fields:', [t for t in page.locator('.ovr label').all_inner_texts() if 'limb' in t])
        print('placeholder:', page.get_attribute('#ov-burn-stepClimbMin', 'placeholder'))
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
