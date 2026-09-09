import { Application, Controller } from '../../node_modules/@hotwired/stimulus/dist/stimulus.js';
class Character extends Controller {
  connect() { this.variant = new URLSearchParams(location.search).get('variant') || 'a'; this.show(); }
  show() {
    const copy = {a:['A · The tiny show-off','Hops over the wordmark, struts along the header, does a wobbly victory spin, then hurries home.'],b:['B · The sneeze','Takes a curious stroll, winds up an enormous sneeze, gets knocked backwards, then pretends nothing happened.'],c:['C · The moonwalk','Walks out normally, spots an imaginary audience, then moonwalks all the way back.']}[this.variant];
    this.element.querySelector('#name').textContent=copy[0]; this.element.querySelector('#rationale').textContent=copy[1];
    this.element.querySelectorAll('[data-variant]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.variant===this.variant)));
    history.replaceState(null,'','?variant='+this.variant);
  }
  choose(e) { this.reset(); this.variant=e.currentTarget.dataset.variant; this.show(); }
  previous() { this.step(-1); } next() { this.step(1); }
  step(n) { this.reset(); this.variant='abc'[('abc'.indexOf(this.variant)+n+3)%3]; this.show(); }
  key(e) { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; if(e.key==='ArrowRight')this.next(); if(e.key==='ArrowLeft')this.previous(); if(e.key==='Escape')this.reset(); }
  play() {
    if(this.running) return;
    if(matchMedia('(prefers-reduced-motion: reduce)').matches) {this.element.querySelector('#status').textContent='Reduced motion is on — our little friend is staying home.'; return;}
    this.running=true; const stage=this.element.querySelector('#stage'); stage.dataset.routine=this.variant; stage.classList.add('running');
    this.element.querySelector('#status').textContent='Out for a little mischief…';
    this.timer=setTimeout(()=>this.reset(),8500);
  }
  reset() { clearTimeout(this.timer); this.running=false; this.element.querySelector('#stage').classList.remove('running'); this.element.querySelector('#status').textContent='Home. Click the header icon or play again.'; }
  theme(e) {document.documentElement.dataset.theme=e.target.value;}
  disconnect() {clearTimeout(this.timer);}
}
Application.start().register('character',Character);
