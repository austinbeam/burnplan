import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8781', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    out=[]
    for k in text: page.keyboard.type(k); out.append(page.input_value(sel))
    return out
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8781/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        print('ETE stays h:mm:', typ(page, '#s-ete', '338'))
        typ(page, '#s-fuel', '52.8'); page.click('text=Build plan'); page.click('text=Start flight')
        print('timer typing:', typ(page, '#sd-at', '2015'))
        print('other:', page.inner_text('#sdAtOther'))
        page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        print('fly field:', page.input_value('#flyTime'))
        page.clock.run_for(65*1000); page.wait_for_timeout(5500)
        print('fly field after 65s:', page.input_value('#flyTime'))
        page.click('[data-act=tapTank][data-tank=RM]'); print('switch field default:', page.input_value('#sd-at'), page.locator('label[for=sd-at]').inner_text())
        typ(page, '#sd-at', '1830'); page.click('[data-act=saveSwitch]'); page.wait_for_timeout(300)
        page.goto('http://localhost:8781/#log'); page.wait_for_timeout(200); page.click('.item'); page.wait_for_timeout(200)
        print('log switch:', [t.replace('\n',' / ') for t in page.locator('.evrow.tap').all_inner_texts() if 'Switch' in t])
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
