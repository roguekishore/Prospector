/* ============================================================
   MOCKS — stand-ins for the real captures.

   The pipeline writes data/<vertical>/<domain>/{mobile,desktop,full}.png.
   app.js probes for those first; these CSS rebuilds render only when
   a PNG is absent, so dropping real captures in overrides them with
   no code change.

   Mobile deliberately renders a 980px layout squeezed into 390px —
   that is what a page with no <meta viewport> actually looks like on
   a phone, and it is the single most sellable fact in the report.
   ============================================================ */

/* Device frames. `full` is shorter than a real full-page capture because
   the CSS rebuilds below only model above-the-fold plus one section; real
   PNGs dropped into data/ are drawn at their own aspect ratio instead. */
const BASE = { desktop:{w:1440,h:900}, mobile:{w:390,h:844}, full:{w:1440,h:1800} };

/* Width a page lays out at on a phone when it declares no <meta viewport>.
   The browser pretends the screen is ~980px and scales the result down —
   which is exactly why these sites are unreadable on mobile. */
const LEGACY_VIEWPORT = { w:980, h:2120 };

/* Shared photographic fills, gradients only.
   Each ends in ';' so a property may follow it at any call site. */
const PHOTO = {
  kitchen:`background:
    radial-gradient(120% 90% at 18% 42%, #f3ece2 0 26%, transparent 27%),
    linear-gradient(180deg,#5c2230 0 34%, #7a3040 34% 52%, #d9c3a5 52% 74%, #b08d63 74% 100%),
    linear-gradient(90deg,#3a1720 0 22%, #6b2a38 22% 100%);`,
  oldschool:`background:
    repeating-linear-gradient(90deg, rgba(255,255,255,.14) 0 3px, transparent 3px 46px),
    linear-gradient(180deg,#9aa9b4 0 8%, #7d8f9d 8% 62%, #8a7f6e 62% 78%, #6e5f4e 78% 100%),
    linear-gradient(90deg,#6f7f8c,#a8b6c0);`,
  aioffice:`background:
    repeating-linear-gradient(112deg, rgba(255,255,255,.30) 0 2px, transparent 2px 34px),
    radial-gradient(60% 40% at 30% 22%, rgba(255,255,255,.34) 0 40%, transparent 41%),
    linear-gradient(160deg,#0b1b52 0 40%, #123a9c 40% 72%, #2a63d6 72% 100%);`,
  room:`background:
    radial-gradient(90% 70% at 70% 30%, #e8dfd2 0 30%, transparent 31%),
    linear-gradient(180deg,#cdbfae 0 46%, #8e7a63 46% 70%, #5f5044 70% 100%);`,
  loft:`background:
    linear-gradient(180deg,#f4f1ec 0 52%, #e2dcd3 52% 100%),
    linear-gradient(90deg,#efe9e1,#ddd4c8);`,
};

const ICONS = {
  ph:'&#9743;', wa:'&#9993;', mail:'&#9993;', fb:'f', ig:'&#9634;',
  home:'&#8962;', user:'&#9679;', gear:'&#9881;', doc:'&#9636;', rss:'&#8767;', play:'&#9654;',
};

/* ---------------- blitzglobe.com ---------------- */

function mockBlitzglobe(){ return `
<div class="mk" style="width:100%;height:100%;background:#fff;position:relative;overflow:hidden;font-family:Georgia,'Times New Roman',serif">

  <!-- maroon header -->
  <div style="background:#5c1f3d;padding:10px 34px 0">
    <div style="display:flex;justify-content:flex-end;gap:26px;font-size:13px;color:#f0dce6;padding-bottom:8px">
      <span>&#9993; info@blitzglobe.com</span><span>&#9742; +91 9159695555</span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:14px">
      <div style="line-height:1">
        <div style="font-size:30px;font-weight:700;color:#e8b830;letter-spacing:-.5px">Blitz globe<sup style="font-size:11px">&#8482;</sup></div>
        <div style="font-size:12px;color:#f7e6c0;font-style:italic;letter-spacing:2px;margin-top:2px">Interior Architect</div>
      </div>
      <div style="display:flex;gap:30px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#fff;letter-spacing:.6px">
        <span>HOME</span><span>ABOUT</span><span>SERVICE</span><span>GALLERY</span><span>BLOG</span><span>CONTACT</span>
      </div>
    </div>
  </div>

  <!-- hero photo -->
  <div style="position:relative;height:560px;${PHOTO.oldschool}">
    <!-- window rows on the building -->
    <div style="position:absolute;left:4%;right:4%;top:22%;height:34%;
      background:repeating-linear-gradient(90deg,#c8d2da 0 44px,#7d8f9d 44px 52px);opacity:.75"></div>
    <div style="position:absolute;left:4%;right:4%;top:58%;height:22%;
      background:repeating-linear-gradient(90deg,#b9c4cd 0 44px,#6f8190 44px 52px);opacity:.6"></div>

    <!-- green caption banner -->
    <div style="position:absolute;left:32%;bottom:64px;background:#3fa22a;border-radius:34px;
      padding:12px 44px;color:#fff;font-size:40px;font-weight:700;letter-spacing:.5px;
      font-family:'Comic Sans MS',Georgia,serif;text-shadow:0 2px 3px rgba(0,0,0,.3)">
      Govt school ooty before
    </div>

    <!-- slider dots -->
    <div style="position:absolute;left:0;right:0;bottom:22px;display:flex;justify-content:center;gap:14px">
      ${Array.from({length:9},(_,i)=>`<i style="width:11px;height:11px;border-radius:50%;
        background:${i===0?'#fff':'rgba(255,255,255,.45)'};display:block"></i>`).join('')}
    </div>

    <!-- floating social rail, left -->
    <div style="position:absolute;left:0;top:70px;display:flex;flex-direction:column">
      ${[['#f0b323','&#9742;'],['#25d366','&#9993;'],['#2f80ed','&#9993;'],['#3b5998','f'],['#c13584','&#9634;']]
        .map(([c,g])=>`<div style="width:58px;height:62px;background:${c};display:grid;place-items:center;
          color:#fff;font-size:22px">${g}</div>`).join('')}
    </div>
  </div>

  <!-- below the fold -->
  <div style="padding:46px 34px;text-align:center">
    <div style="font-size:15px;color:#8a6a76;letter-spacing:4px;text-transform:uppercase">welcome to</div>
    <div style="font-size:34px;color:#5c1f3d;font-weight:700;margin-top:8px">Blitz Globe Interior Architect</div>
    <div style="width:70px;height:3px;background:#e8b830;margin:16px auto"></div>
    <p style="max-width:760px;margin:0 auto;font-size:15px;line-height:1.9;color:#6b6b6b">
      We are one of the leading interior architect in Coimbatore providing complete turnkey
      solutions for residential and commercial projects across Tamil Nadu since 2009.
    </p>
  </div>
</div>`; }

/* ---------------- happyhomesinteriors.com ---------------- */

function mockHappyhomes(){ return `
<div class="mk" style="width:100%;height:100%;background:#fff;position:relative;overflow:hidden;font-family:Arial,Helvetica,sans-serif">

  <!-- topbar -->
  <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 30px;
    font-size:13px;color:#4a4a4a;border-bottom:1px solid #eee">
    <div style="display:flex;gap:26px">
      <span style="color:#c8811f">&#9742;</span><span>+91 9994311447</span>
      <span style="color:#c8811f">&#9906;</span><span>Coimbatore, TN, India.</span>
    </div>
    <div style="display:flex;gap:26px">
      <span style="color:#c8811f">&#9201;</span><span>Mon - Sat 8.00AM - 10.00PM</span>
      <span style="color:#c8811f">&#9993;</span><span>happyhomesinteriorscbe@gmail.com</span>
    </div>
  </div>

  <!-- logo + nav -->
  <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 30px">
    <div style="display:flex;align-items:center;gap:10px">
      <div style="width:64px;height:58px;position:relative">
        <div style="position:absolute;inset:8px 6px 14px;border:3px solid #2d5fa8;border-radius:4px"></div>
        <div style="position:absolute;left:4px;right:4px;top:0;height:22px;background:#2d5fa8;
          clip-path:polygon(50% 0,100% 100%,0 100%)"></div>
        <div style="position:absolute;left:18px;bottom:20px;width:26px;height:13px;
          border-bottom:3px solid #2d5fa8;border-radius:0 0 26px 26px"></div>
      </div>
      <div style="line-height:1.1">
        <div style="font-size:21px;font-weight:700;color:#2d5fa8;font-style:italic">Happy Homes</div>
        <div style="font-size:9px;color:#2d5fa8;letter-spacing:.5px">Interiors Works &amp; Designing</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:22px;font-size:14px;font-weight:700;color:#1a1a1a">
      <span>HOME</span><span>PROFILE &#9662;</span><span>PROJECTS</span><span>SERVICES &#9662;</span>
      <span>DESIGN GALLERY &#9662;</span><span>CONTACT US</span>
      <span style="background:#c8811f;color:#fff;padding:13px 26px;border-radius:30px;font-size:13px">GET A QUOTE</span>
    </div>
  </div>

  <!-- hero -->
  <div style="position:relative;height:620px;${PHOTO.kitchen}">
    <!-- cabinet seams -->
    <div style="position:absolute;left:24%;right:0;top:0;height:34%;
      background:repeating-linear-gradient(90deg,transparent 0 118px,rgba(0,0,0,.22) 118px 121px)"></div>
    <!-- fridge -->
    <div style="position:absolute;left:3%;top:24%;width:20%;height:62%;
      background:linear-gradient(90deg,#e7e2d8,#cfc8bb);border-radius:3px">
      <div style="position:absolute;left:8%;right:8%;top:46%;height:4px;background:#b9b2a4"></div>
      <div style="position:absolute;right:10%;top:52%;bottom:8%;width:5px;background:#9e968a"></div>
    </div>

    <!-- slide numbers -->
    <div style="position:absolute;left:5%;top:44%;font-size:62px;font-weight:700;
      color:transparent;-webkit-text-stroke:2px rgba(200,129,31,.85);line-height:.95">01<br>02</div>

    <!-- framed headline -->
    <div style="position:absolute;left:30%;top:22%;width:33%;border:3px solid #c8811f;padding:40px 34px 46px">
      <div style="font-size:46px;font-weight:700;color:#141414;line-height:1.18;letter-spacing:-.5px">
        INTERIOR DESIGNS<br>FROM THE<br>FUTURE
      </div>
      <div style="display:inline-block;margin-top:30px;background:#c8811f;color:#fff;
        padding:15px 30px;font-size:14px;font-weight:700;letter-spacing:.6px">BOOK A SITE VISIT</div>
    </div>

    <!-- play button -->
    <div style="position:absolute;left:36%;bottom:34px;width:66px;height:66px;border-radius:50%;
      background:#c8811f;display:grid;place-items:center;color:#fff;font-size:24px;padding-left:5px">&#9654;</div>

    <!-- right floating rail -->
    <div style="position:absolute;right:0;top:36%;display:flex;flex-direction:column;align-items:flex-end">
      <div style="background:#c8811f;color:#fff;padding:15px 20px;font-size:14px;font-weight:700;
        display:flex;gap:12px;align-items:center">HOME &#8962;</div>
      ${['&#9679;','&#9881;','&#9636;','&#8767;','&#9742;','&#9993;'].map((g,i)=>`
        <div style="width:56px;height:56px;background:${i===5?'#25d366':'#fff'};
          color:${i===5?'#fff':'#666'};display:grid;place-items:center;font-size:19px;
          border-bottom:1px solid #eee">${g}</div>`).join('')}
    </div>
  </div>

  <!-- video strip below fold -->
  <div style="padding:22px 26%">
    <div style="height:150px;background:linear-gradient(135deg,#2a2a6e,#6a3f8f 55%,#c05a7a);
      display:grid;place-items:center">
      <div style="width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.9);
        display:grid;place-items:center;color:#333;font-size:20px;padding-left:4px">&#9654;</div>
    </div>
  </div>
</div>`; }

/* ---------------- bestinterior.co ---------------- */

function mockBestinterior(){ return `
<div class="mk" style="width:100%;height:100%;background:#463a37;position:relative;overflow:hidden;
  font-family:'Arial Narrow',Impact,Arial,sans-serif">

  <!-- hero card -->
  <div style="margin:44px 40px 0;background:#c9c6c3;border-radius:24px;overflow:hidden;
    display:flex;height:430px;box-shadow:0 8px 0 rgba(0,0,0,.18)">
    <div style="width:44%;${PHOTO.aioffice}position:relative">
      <div style="position:absolute;left:8%;right:8%;top:14%;height:6px;background:rgba(255,255,255,.85);
        box-shadow:0 60px 0 rgba(255,255,255,.7),0 130px 0 rgba(255,255,255,.5)"></div>
      <div style="position:absolute;left:10%;right:18%;bottom:12%;height:30%;
        background:repeating-linear-gradient(90deg,rgba(255,255,255,.55) 0 50px,transparent 50px 96px)"></div>
    </div>
    <div style="flex:1;padding:52px 46px">
      <div style="font-size:50px;font-weight:700;color:#0b0b0b;line-height:1.08;letter-spacing:-1px">
        Bestinterior.co - Transform your space with Best Interior's Expert Design..
      </div>
      <p style="margin-top:26px;font-family:Arial,sans-serif;font-size:17px;line-height:1.55;color:#3d3d3d">
        Discover personalized interior solutions that blend style, comfort, and functionality.
        We create spaces that truly reflect who you are.
      </p>
    </div>
  </div>

  <!-- second section, tan on brown -->
  <div style="padding:74px 58px 0">
    <div style="font-size:52px;font-weight:700;color:#d8b99a;line-height:1.12;letter-spacing:-.5px">
      Why Choose Best Interior? The Power of Professional Interior Design
    </div>
    <p style="margin-top:26px;max-width:70%;font-family:Arial,sans-serif;font-size:16px;
      line-height:1.7;color:#a89b92">
      Professional interior design transforms not just how a space looks, but how it functions
      and feels for the people who use it every day.
    </p>
  </div>
</div>`; }

/* ---------------- generic dated agency template ---------------- */

function mockGenericDated(seed){
  const hues = ['#2f4858','#5c3a2e','#1f3d2b','#3d2f4f','#4a3b1f'];
  const acc  = ['#d9a02b','#c0564a','#5a9e5a','#8a6fb0','#c9a227'];
  const h = hues[seed % hues.length], a = acc[seed % acc.length];
  return `
<div class="mk" style="width:100%;height:100%;background:#fff;position:relative;overflow:hidden;
  font-family:Arial,Helvetica,sans-serif">
  <div style="background:${h};padding:8px 30px;display:flex;justify-content:space-between;
    font-size:12px;color:rgba(255,255,255,.82)">
    <span>&#9742; +91 422 xxx xxxx &nbsp;&nbsp; &#9993; info@example.com</span>
    <span>Mon - Sat 9.00 - 20.00</span>
  </div>
  <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 30px;
    border-bottom:3px solid ${a}">
    <div style="font-size:26px;font-weight:700;color:${h};font-style:italic">Interior&nbsp;Works</div>
    <div style="display:flex;gap:22px;font-size:13px;font-weight:700;color:#333">
      <span>HOME</span><span>ABOUT US</span><span>SERVICES</span><span>GALLERY</span>
      <span>PROJECTS</span><span>CONTACT</span>
      <span style="background:${a};color:#fff;padding:10px 20px;border-radius:2px">ENQUIRE NOW</span>
    </div>
  </div>
  <div style="position:relative;height:500px;${PHOTO.room}">
    <div style="position:absolute;left:8%;top:28%;max-width:46%">
      <div style="font-size:15px;color:${a};letter-spacing:5px;text-transform:uppercase">welcome</div>
      <div style="font-size:52px;font-weight:700;color:#1d1d1d;line-height:1.1;margin-top:10px;
        text-shadow:0 2px 6px rgba(255,255,255,.6)">WE BUILD<br>BEAUTIFUL<br>INTERIORS</div>
      <div style="display:inline-block;margin-top:24px;background:${a};color:#fff;
        padding:14px 30px;font-size:13px;font-weight:700;letter-spacing:1px">READ MORE &#8594;</div>
    </div>
    <div style="position:absolute;left:0;right:0;bottom:18px;display:flex;justify-content:center;gap:12px">
      ${Array.from({length:4},(_,i)=>`<i style="width:10px;height:10px;border-radius:50%;
        background:${i===0?'#fff':'rgba(255,255,255,.5)'};display:block"></i>`).join('')}
    </div>
    <div style="position:absolute;left:0;top:60px;display:flex;flex-direction:column">
      ${[['#f0b323','&#9742;'],['#25d366','&#9993;'],['#3b5998','f']].map(([c,g])=>`
        <div style="width:52px;height:56px;background:${c};display:grid;place-items:center;
          color:#fff;font-size:20px">${g}</div>`).join('')}
    </div>
  </div>
  <div style="display:flex;gap:26px;padding:44px 30px">
    ${['Residential','Commercial','Modular Kitchen'].map(t=>`
      <div style="flex:1;border:1px solid #e3e3e3;padding:26px;text-align:center">
        <div style="width:54px;height:54px;border-radius:50%;background:${a};margin:0 auto 16px"></div>
        <div style="font-size:18px;font-weight:700;color:#222">${t}</div>
        <p style="font-size:13px;color:#777;line-height:1.7;margin-top:8px">
          Complete turnkey solutions delivered on time and within budget.</p>
      </div>`).join('')}
  </div>
</div>`; }

/* ---------------- generic modern (nothing to sell) ---------------- */

function mockGenericModern(){ return `
<div class="mk" style="width:100%;height:100%;background:#fbfaf8;position:relative;overflow:hidden;
  font-family:'Helvetica Neue',Inter,Arial,sans-serif">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:26px 56px">
    <div style="font-size:17px;font-weight:600;letter-spacing:-.2px;color:#14100e">urban nest</div>
    <div style="display:flex;gap:34px;font-size:14px;color:#55504c">
      <span>Work</span><span>Studio</span><span>Journal</span>
      <span style="border:1px solid #14100e;border-radius:40px;padding:8px 20px;color:#14100e">Enquire</span>
    </div>
  </div>
  <div style="padding:70px 56px 0;max-width:62%">
    <div style="font-size:64px;line-height:1.05;letter-spacing:-2.5px;color:#14100e;font-weight:400">
      Quiet interiors for<br>Coimbatore homes.
    </div>
    <p style="margin-top:28px;font-size:17px;line-height:1.65;color:#6a645f;max-width:70%">
      A small studio working on residential and workspace interiors, one project at a time.
    </p>
  </div>
  <div style="display:flex;gap:2px;margin-top:60px;height:420px">
    <div style="flex:2;${PHOTO.loft}"></div>
    <div style="flex:1;${PHOTO.room}"></div>
  </div>
</div>`; }

/* ---------------- registry ---------------- */

const MOCKS = {
  'blitzglobe':      mockBlitzglobe,
  'happyhomes':      mockHappyhomes,
  'bestinterior':    mockBestinterior,
  'generic-dated':   mockGenericDated,
  'generic-modern':  mockGenericModern,
};

/**
 * Render a mock into a device frame and scale it into the available box.
 *
 * view 'mobile' on a site with no <meta viewport> renders the 980px legacy
 * layout squeezed into a 390px frame — the real phone experience, and the
 * single most sellable fact in the report.
 *
 * mode 'contain' fits the whole frame (review deck).
 * mode 'cover'   fills the width and crops the bottom (grid thumbnails).
 */
function renderMock(lead, view, boxW, boxH, mode){
  if(!(boxW > 0) || !(boxH > 0)) return '';

  const fn = MOCKS[lead.mock] || mockGenericDated;
  const html = fn.length ? fn(lead.domain.length) : fn();

  const responsive = lead.signals.viewport === 'present' && lead.signals.overflow === '0px';

  let frameW, frameH, srcW, srcH;
  if(view === 'mobile'){
    frameW = BASE.mobile.w; frameH = BASE.mobile.h;
    // No <meta viewport> means the page lays out at the legacy 980px
    // fallback width and the phone scales the whole thing down.
    srcW = responsive ? BASE.mobile.w : LEGACY_VIEWPORT.w;
    srcH = responsive ? BASE.mobile.h : LEGACY_VIEWPORT.h;
  } else if(view === 'full'){
    frameW = BASE.desktop.w; frameH = BASE.full.h;
    srcW = BASE.desktop.w;   srcH = BASE.full.h;
  } else {
    frameW = BASE.desktop.w; frameH = BASE.desktop.h;
    srcW = 1440; srcH = 900;
  }

  // inner scale squeezes the source layout into the device frame
  const squeeze = frameW / srcW;

  // outer scale places the device frame in the available box
  const fit = mode === 'cover'
    ? boxW / frameW
    : Math.min(boxW / frameW, boxH / frameH);

  return `
    <div class="stage" style="width:${frameW * fit}px;height:${frameH * fit}px">
      <div class="site" style="width:${srcW}px;height:${srcH}px;transform:scale(${squeeze * fit})">
        ${html}
      </div>
    </div>`;
}
