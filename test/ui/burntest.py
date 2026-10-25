import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8782', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8782/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-ete', '338'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan'); page.click('text=Start flight')
        typ(page, '#sd-at', '10000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        print('phase card:', page.locator('#flyLive .card').filter(has_text='Set burn').inner_text().replace('\n',' | '))
        page.click('[data-sheet=burn]'); page.wait_for_timeout(100)
        typ(page, '#sd-gph', '13.2')
        print('point preview:', page.inner_text('#sheetPreview').replace('\n',' | '))
        page.screenshot(path=f'{OUT}/b1.png', full_page=True)
        page.click('[data-act=sdScope][data-v=all]'); page.wait_for_timeout(100)
        print('all preview:', page.inner_text('#sheetPreview').replace('\n',' | '), '| time field:', page.locator('#sd-at').count())
        page.screenshot(path=f'{OUT}/b2.png', full_page=True)
        page.click('[data-act=sdScope][data-v=now]'); page.wait_for_timeout(100)
        print('back to point, gph kept:', page.input_value('#sd-gph'), '| time field:', page.locator('#sd-at').count())
        page.click('[data-act=saveBurn]'); page.wait_for_timeout(300)
        print('toast:', page.inner_text('#toast'), '| phase:', page.locator('#flyLive .card').filter(has_text='Set burn').inner_text().split('\n')[0])
        page.click('[data-sheet=burn]'); typ(page, '#sd-gph', '14'); page.click('[data-act=sdScope][data-v=all]'); page.click('[data-act=saveBurn]'); page.wait_for_timeout(300)
        print('toast2:', page.inner_text('#toast'))
        page.goto('http://localhost:8782/#log'); page.wait_for_timeout(200); page.click('.item'); page.wait_for_timeout(200)
        print('log:', [t.split('\n')[0] for t in page.locator('.evrow.tap').all_inner_texts() if 'burn' in t])
        page.locator('.evrow.tap', has_text='whole cruise').click(); page.wait_for_timeout(100)
        print('edit sheet:', page.locator('.sheet h2').inner_text(), page.input_value('#sd-gph'), page.is_checked('[data-sd=allScope]'))
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
