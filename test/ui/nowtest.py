import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8771', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
JS = """() => {
  const bar = document.querySelectorAll('.barwrap .bar')[1];
  const kids = [...bar.children].map(d => [parseFloat(d.style.flex), d.style.background]);
  const tot = kids.reduce((a,k)=>a+k[0],0);
  const m = document.querySelector('.nowmark'); const pct = m ? parseFloat(m.style.left) : 0;
  let acc = 0, before = null, after = null;
  for (const [w,c] of kids) { if (acc/tot*100 < pct - 0.1) before = c; if (after===null && acc/tot*100 >= pct - 0.1) after = c; acc += w; }
  return {pct, before, after};
}"""
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8771/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.fill('#s-ete', '4:33'); page.fill('#s-fuel', '70.9'); page.locator('#s-fuel').dispatch_event('input')
        page.click('text=Build plan'); page.clock.run_for(100*60*1000)
        page.click('text=Start flight'); page.locator('#sd-at').fill('1:20'); page.locator('#sd-at').dispatch_event('input')
        page.click('[data-act=sdSofar][data-v=manual]'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        # 40 min later switch to LT without rebuilding, then stay on LT 40 more minutes
        page.clock.run_for(40*60*1000)
        page.click('[data-act=tapTank][data-tank=LT]'); page.uncheck('[data-sd=rebuild]'); page.click('[data-act=saveSwitch]')
        page.clock.run_for(40*60*1000)
        page.goto('http://localhost:8771/#plan'); page.wait_for_timeout(200)
        print('bar:', page.evaluate("() => [...document.querySelectorAll('.barwrap .bar')[1].children].map(d => d.style.background.replace('var(--tk-','').replace(')','') + ' ' + Math.round(parseFloat(d.style.flex)))")); print('whole:', page.evaluate(JS), '| axis:', page.inner_text('.axis').replace('\n',' '))
        page.screenshot(path=f'{OUT}/now1.png', full_page=True); print('table:', [t.split(chr(10))[:4] for t in page.locator('.legrow:not(.head)').all_inner_texts()]); print('offplan:', page.locator('.legs .issue').count())
        page.click('[data-act=planView][data-v=remaining]'); page.wait_for_timeout(100)
        print('remaining axis:', page.inner_text('.axis').replace('\n',' '))
        page.screenshot(path=f'{OUT}/now2.png')
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
