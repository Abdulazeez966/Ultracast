'use strict';
// The wavy connection ring on the Control page. Faster link = livelier waves. Purely cosmetic.
(function (root) {
  function create(canvas) {
    var ctx = canvas.getContext('2d');
    var state = { mbps: 0, active: false }, t = 0, running = false, raf = 0;
    function color() { return getComputedStyle(document.documentElement).getPropertyValue('--ac').trim() || '#22D3EE'; }
    function draw() {
      var w = canvas.clientWidth || 300, h = canvas.clientHeight || 300, dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      var cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 18;
      var amp = state.active ? 3 + Math.min(9, state.mbps / 12) : 0;
      var col = color();
      for (var k = 0; k < 3; k++) {
        ctx.beginPath();
        for (var i = 0; i <= 180; i++) {
          var a = i / 180 * Math.PI * 2;
          var rr = r - k * 7 + Math.sin(a * (5 + k * 2) + t * (1 + k * .4)) * amp * (1 - k * .25);
          var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.globalAlpha = state.active ? 0.9 - k * 0.3 : 0.25;
        ctx.lineWidth = 2 - k * 0.4; ctx.strokeStyle = col; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    function loop() { t += 0.03; draw(); raf = requestAnimationFrame(loop); }
    return {
      set: function (s) { state.mbps = s.mbps || 0; state.active = !!s.active; },
      start: function () { if (!running) { running = true; loop(); } },
      stop: function () { running = false; cancelAnimationFrame(raf); },
      draw: draw
    };
  }
  root.UltraRing = { create: create };
})(typeof window !== 'undefined' ? window : this);
