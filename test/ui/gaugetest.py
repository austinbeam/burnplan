import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8792', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8792/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-from', 'KLUK'); typ(page, '#s-to', 'KVBT')
        typ(page, '#s-ete', '329'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan')
        page.goto('http://localhost:8792/#fly'); page.wait_for_timeout(200)
        # before start: full tanks on the ramp
        page.click('[data-sheet=gauge]'); page.wait_for_timeout(100)
        for t, v in [('LT','F'),('LM','23'),('RM','3/4'),('RT','16')]: typ(page, f'#g-{t}', v)
        print('ramp preview:', page.inner_text('#sheetPreview').replace('\n',' | '))
        page.click('[data-act=saveGauge]'); page.wait_for_timeout(200); print('toast:', page.inner_text('#toast'))
        page.click('text=Start flight'); typ(page, '#sd-at', '13000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        print('gauge kept after start:', page.evaluate("Object.values(JSON.parse(localStorage.getItem('burnplan.v1')).flights)[0].events.filter(e=>e.type==='gauge').length"))
        total_before = page.inner_text('.sides .tot .v')
        page.click('[data-sheet=gauge]'); typ(page, '#g-LM', '8'); typ(page, '#g-RM', '50%'); typ(page, '#sd-note', 'level 8500')
        print('cruise preview:', page.inner_text('#sheetPreview').replace('\n',' | '))
        page.screenshot(path=f'{OUT}/gauge-sheet.png', full_page=True)
        page.click('[data-act=saveGauge]'); page.wait_for_timeout(300)
        print('total unchanged:', total_before, '->', page.inner_text('.sides .tot .v'))
        page.goto('http://localhost:8792/#fuel'); page.wait_for_timeout(300)
        print('calibration:', page.locator('.card:has-text("Gauge calibration")').inner_text().replace('\n',' | ')[:400])
        page.screenshot(path=f'{OUT}/gauge-cal.png', full_page=True)
        page.goto('http://localhost:8792/#log'); page.wait_for_timeout(300); page.click('.item'); page.wait_for_timeout(200)
        print('log entries:', [t.split('\n')[0] for t in page.locator('.evrow.tap').all_inner_texts() if 'Gauges' in t])
        page.locator('.evrow.tap', has_text='level 8500').click(); typ(page, '#g-LM', '9'); page.click('[data-act=saveEdit]'); page.wait_for_timeout(200)
        print('after edit:', [t.split('\n')[0] for t in page.locator('.evrow.tap').all_inner_texts() if 'level 8500' in t], '| versions:', page.locator('details.card summary:has-text("Plan versions")').inner_text())
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
