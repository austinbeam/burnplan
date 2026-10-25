import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8789', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
card = lambda page: page.locator('#flyLive .card').filter(has_text='Fuel burn').inner_text().replace('\n',' | ')
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8789/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-ete', '329'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan'); page.click('text=Start flight')
        typ(page, '#sd-at', '13000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        print('cruise:', card(page))
        page.click('[data-sheet=climb]'); page.click('[data-act=saveClimb]'); page.wait_for_timeout(300)
        print('toast:', page.inner_text('#toast'))
        print('climbing:', card(page))
        used0 = float(card(page).split('used ')[1].split(' ')[0])
        page.clock.run_for(10*M); page.wait_for_timeout(5500)
        used1 = float(card(page).split('used ')[1].split(' ')[0])
        print(f'10 min climbing burned {used1-used0:.2f} gal (20 gph -> 3.33)')
        page.clock.run_for(5*M); page.wait_for_timeout(5500)
        print('alert:', page.inner_text('#alertbar').replace('\n',' | ') if page.locator('#alertbar .inner').count() else 'none')
        page.click('#alertbar [data-act=alertLevel]'); page.wait_for_timeout(100)
        print('level picks:', page.locator('[data-act=sdAtMs]').all_inner_texts())
        page.click('[data-act=sdAtMs] >> nth=0'); page.click('[data-act=saveLevel]'); page.wait_for_timeout(300)
        print('after level:', card(page))
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
