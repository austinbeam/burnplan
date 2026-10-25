import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8796', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
S=OUT+'/'
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 1800})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:8796/'); page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        print('tabs:', page.locator('nav.tabs a').all_inner_texts())
        print('route:', page.evaluate('location.hash'), page.locator('#app h1, #app h2').first.inner_text())
        page.click('nav.tabs a:has-text("Fuel")'); page.wait_for_timeout(200)
        page.click('text=Start fueling'); page.wait_for_timeout(200)
        print('default request:', page.locator('[data-act=fuReq].on').inner_text().replace(chr(10),' '))
        page.locator('[data-act=fuReq][data-v=tabs]').dispatch_event('click'); page.wait_for_timeout(200)
        for t,v in {'LT':'5','LM':'6','RM':'7','RT':'4'}.items():
            page.fill('#fb-'+t, v); page.fill('#fg-'+t, str(int(v)+1))
        print('step tanks:', [page.locator(f'#fs-{i}').input_value() for i in range(4)])
        for i,r in enumerate(['12.2','25.0','37.1','48.0']):
            page.fill(f'#fr-{i}', r)
        for t,v in {'LT':'F','LM':'3/4','RM':'3/4','RT':'F'}.items(): page.fill('#fga-'+t, v)
        page.wait_for_timeout(800)
        print('draft ga:', page.evaluate("JSON.parse(localStorage['burnplan.v1']).fuelDraft.gaugeAfter"), page.locator('#fga-LT').count(), page.locator('#fga-LT').input_value())
        page.screenshot(path=S+'fuel_edit.png', full_page=True)
        print(page.inner_text('#app')[-900:])
        page.click('text=Save fueling'); page.wait_for_timeout(300)
        print('after save hash', page.evaluate('location.hash'))
        page.screenshot(path=S+'fuel_list.png', full_page=True)
        print(page.inner_text('#app')[:1200])
        page.click('nav.tabs a:has-text("Plan")'); page.wait_for_timeout(300)
        print('setup prefill:', page.locator('text=Prefilled').all_inner_texts(), [page.locator('#lv-'+t).input_value() for t in ['LT','LM','RM','RT']])
        page.click('nav.tabs a:has-text("Fuel")'); page.wait_for_timeout(200)
        page.screenshot(path=S+'fuel_home.png', full_page=True)
        print('FUEL HOME:', page.inner_text('#app')[:1500].replace(chr(10),' | '))
        page.goto('http://localhost:8796/#aircraft/N12345'); page.wait_for_timeout(200)
        page.fill('#tab-LM','17'); page.keyboard.press('Tab'); page.wait_for_timeout(200)
        print('tab ovr:', page.evaluate("JSON.parse(localStorage['burnplan.v1']).tails.N12345.overrides"))
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
