import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8769', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
def levels(page):
    return page.inner_text('#flyLive').split('Left')[0].replace('\n',' ')
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8769/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-ete', '226'); typ(page, '#s-fuel', '39'); typ(page, '#s-taxi', '20'); typ(page, '#s-cmin', '12')
        page.click('text=Build plan')
        page.clock.run_for(80 * 60 * 1000)
        page.click('text=Start flight'); typ(page, '#sd-at', '10000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        print('before:', levels(page))
        page.click('text=Edit history'); page.wait_for_timeout(200)
        print('events:', [t.replace('\n',' / ') for t in page.locator('.evrow.tap').all_inner_texts()])
        page.locator('.evrow.tap', has_text='Switch → RM').click(); page.wait_for_timeout(100)
        print('edit sheet:', page.locator('.sheet h2').inner_text(), page.input_value('#sd-at'))
        typ(page, '#sd-at', '5000'); page.click('[data-act=saveEdit]'); page.wait_for_timeout(200)
        print('toast:', page.inner_text('#toast'))
        page.click('[data-act=addEvent][data-kind=climb]'); typ(page, '#sd-at', '3000'); typ(page, '#sd-len', '5')
        page.click('[data-act=saveEdit]'); page.wait_for_timeout(200)
        page.locator('.evrow.tap', has_text='Taxi on').click(); typ(page, '#sd-taxi', '15'); page.click('[data-act=saveEdit]'); page.wait_for_timeout(200)
        page.locator('.evrow.tap', has_text='Takeoff').click(); print('takeoff field:', page.input_value('#sd-at'))
        typ(page, '#sd-at', '1325'); page.click('[data-act=saveEdit]'); page.wait_for_timeout(200)
        print('events after:', [t.replace('\n',' / ') for t in page.locator('.evrow.tap').all_inner_texts()])
        page.screenshot(path=f'{OUT}/e1-history.png', full_page=True)
        # delete the added climb
        page.locator('.evrow.tap', has_text='Climb @ 20.0 gph for 0:05').click(); page.click('[data-act=deleteEvent]'); page.click('[data-act=confirmYes]'); page.wait_for_timeout(200)
        print('after delete:', [t.split('\n')[0] for t in page.locator('.evrow.tap').all_inner_texts()])
        page.goto('http://localhost:8769/#fly'); page.wait_for_timeout(200)
        print('after:', levels(page), '| header:', page.inner_text('.top').replace('\n',' '))
        page.goto('http://localhost:8769/#plan'); page.wait_for_timeout(200)
        print('plan past rows:', [t.replace('\n',' / ') for t in page.locator('.legrow.past').all_inner_texts()])
        page.screenshot(path=f'{OUT}/e2-plan.png', full_page=True)
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
