import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
# Built-in types: a Cessna with a BOTH selector shows and plans Both; the PA-32 looks as before.
# Adding a tail confirms the cruise gph. Settings has a prefilled "Request an aircraft type" issue link.
import subprocess, time, sys
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8797', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:8797/')
        types = page.locator('#nt-type option').all_inner_texts()
        print('types:', len(types), '|', types[0], '|', types[-1])
        assert len(types) == 13
        assert page.input_value('#nt-cruise') == '15'
        page.select_option('#nt-type', 'c172s'); page.wait_for_timeout(100)
        print('172 cruise prefill:', page.input_value('#nt-cruise'))
        assert page.input_value('#nt-cruise') == '8.5'
        page.fill('#nt-tail', 'N172SP'); typ(page, '#nt-cruise', '9'); page.click('text=Add aircraft'); page.wait_for_timeout(200)
        tails = page.evaluate("JSON.parse(localStorage.getItem('burnplan.v1')).tails")
        print('tail saved:', tails['N172SP'])
        assert tails['N172SP']['overrides'] == {'burn': {'cruise': 9}}
        typ(page, '#s-ete', '130'); typ(page, '#s-fuel', '24')
        page.click('text=Build plan'); page.wait_for_timeout(200)
        legs = [x for x in page.locator('[data-leg-tank]').evaluate_all('els => els.map(e => e.value)')]
        opts = page.locator('[data-leg-tank="0"] option').all_inner_texts()
        print('plan legs:', legs, '| options', opts)
        assert legs == ['BOTH'] and opts == ['L', 'BOTH', 'R']
        page.screenshot(path=f'{OUT}/both-plan.png', full_page=True)
        page.click('text=Start flight'); page.wait_for_timeout(100)
        picks = page.locator('.tankpick button .t').all_inner_texts()
        print('takeoff tank picker:', picks, '| selected', page.locator('.tankpick button.sel .t').inner_text())
        assert picks == ['L', 'BOTH', 'R']
        typ(page, '#sd-at', '10000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(300)
        print('fly: both on', page.locator('.bothbtn.on').count(), '| gauges on', page.locator('.gauge.on').count())
        assert page.locator('.bothbtn.on').count() == 1 and page.locator('.gauge.on').count() == 2
        page.screenshot(path=f'{OUT}/both-fly.png', full_page=True)
        page.click('[data-act=tapTank][data-tank=L]'); page.wait_for_timeout(100)
        print('switch sheet picks:', page.locator('.tankpick button .t').all_inner_texts(), '| done btn', page.locator('.sheet [data-act=toggleDone]').count())
        page.click('[data-act=saveSwitch]'); page.wait_for_timeout(300)
        print('after switch to L: both on', page.locator('.bothbtn.on').count(), '| on gauge', page.locator('.gauge.on .nm').all_inner_texts())
        assert page.locator('.bothbtn.on').count() == 0
        page.click('.bothbtn'); page.wait_for_timeout(100)
        print('Both sheet: done button', page.locator('.sheet [data-act=toggleDone]').count())
        assert page.locator('.sheet [data-act=toggleDone]').count() == 0
        page.click('[data-act=saveSwitch]'); page.wait_for_timeout(300)
        assert page.locator('.bothbtn.on').count() == 1
        print('back on Both:', page.locator('.gauge.on .nm').all_inner_texts())
        # Settings: request link, and the PA-32 has no Both anywhere.
        page.goto('http://localhost:8797/#aircraft'); page.wait_for_timeout(200)
        href = page.get_attribute('#requestType', 'href')
        print('request link:', unquote(href)[:120].replace('\n', ' / '))
        assert href.startswith('https://github.com/austinbeam/burnplan/issues/new?') and 'N172SP' not in unquote(href)
        page.click('a.item:has-text("Piper PA-32 (mains + tips)")'); page.wait_for_timeout(100)
        print('PA-32 start options:', page.locator('#ty-start option').all_inner_texts())
        assert 'BOTH' not in page.locator('#ty-start option').all_inner_texts()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}); pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto('http://localhost:8797/'); pg.fill('#nt-tail', 'N12345'); pg.click('text=Add aircraft')
        typ(pg, '#s-ete', '146'); typ(pg, '#s-fuel', '39'); pg.click('text=Build plan'); pg.click('text=Start flight')
        print('PA-32 picker:', pg.locator('.tankpick button .t').all_inner_texts())
        assert pg.locator('.tankpick button .t').all_inner_texts() == ['LT', 'LM', 'RM', 'RT']
        typ(pg, '#sd-at', '10000'); pg.click('[data-act=saveStart]'); pg.wait_for_timeout(300)
        print('PA-32 fly: both buttons', pg.locator('.bothbtn').count(), '| gauges', pg.locator('.gauge').count())
        assert pg.locator('.bothbtn').count() == 0
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
