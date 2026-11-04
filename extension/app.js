/* Print Still Wins: D3 dashboard extension for Tableau.
   Views (set by <body data-view>): "peach" grid, "map" (peach glyphs on a layered world map), "scatter" (distance from parity),
   "shape" (renders one peach for exporting Tableau custom shapes).
   Inside Tableau it reads summary data from any dashboard worksheet that has Country, Format and Share fields,
   follows filters and mark selection, and pushes selection back. Outside Tableau it runs on built-in sample data. */
(function () {
  "use strict";
  const VIEW = document.body.dataset.view;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const params = new URLSearchParams(location.search);

  const SAMPLE = [
    ["Germany", 58.0, 10.4], ["France", 52.1, 7.5], ["Spain", 49.3, 14.3], ["United Kingdom", 48.7, 20.0],
    ["Australia", 41.2, 15.9], ["Japan", 40.1, 17.3], ["United States", 44.5, 22.7], ["India", 24.5, 5.6],
    ["South Korea", 34.6, 16.8], ["China", 32.0, 24.4]
  ].map(([c, print, ebook]) => ({ c, print, ebook }));
  // Anchor points (lon, lat) and ISO 3166 numeric ids for the world-atlas topology.
  const GEO = {
    "Germany": { ll: [10.4, 51.1], id: "276" }, "France": { ll: [2.4, 46.6], id: "250" }, "Spain": { ll: [-3.7, 40.2], id: "724" },
    "United Kingdom": { ll: [-1.8, 52.8], id: "826" }, "Australia": { ll: [134.5, -25.5], id: "036" }, "Japan": { ll: [138.5, 36.5], id: "392" },
    "United States": { ll: [-98.5, 39.5], id: "840" }, "India": { ll: [78.9, 22.5], id: "356" }, "South Korea": { ll: [127.9, 36.4], id: "410" },
    "China": { ll: [103.8, 35.0], id: "156" }
  };
  const COLORS = { print: "#1479AE", ebook: "#2A9D4E", printTint: "#E2EFF7", ink: "#0F1B26", ink2: "#44525F", ink3: "#6B7884", grid: "#E6EBEF", rule: "#DCE2E7" };

  let DATA = [], selected = new Set(), inTableau = false, worksheets = [];
  const short = c => ({ "United Kingdom": "UK", "United States": "US", "South Korea": "S. Korea" }[c] || c);
  function enrich(rows) {
    rows.forEach(d => { d.gap = +(d.print - d.ebook).toFixed(1); d.ratio = d.ebook / d.print * 10; });
    [...rows].sort((a, b) => b.gap - a.gap).forEach((d, i) => d.rank = i + 1);
    return rows;
  }

  /* ---------------- Tableau data ---------------- */
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
  async function readSheet(ws) {
    let table;
    if (ws.getSummaryDataReaderAsync) {
      const reader = await ws.getSummaryDataReaderAsync(undefined, { ignoreSelection: true });
      table = await reader.getAllPagesAsync(); await reader.releaseAsync();
    } else table = await ws.getSummaryDataAsync({ ignoreSelection: true });
    const names = table.columns.map(c => c.fieldName);
    const iC = names.findIndex(n => /^country$/i.test(n)), iF = names.findIndex(n => /^format$/i.test(n)),
      iS = names.findIndex(n => /share\)?$/i.test(n) && /share/i.test(n) && !/country|row/i.test(n));
    if (iC < 0 || iF < 0 || iS < 0) return null;
    const by = new Map();
    table.data.forEach(r => {
      const c = r[iC].value, f = String(r[iF].value), v = +r[iS].value;
      if (!by.has(c)) by.set(c, { c, print: NaN, ebook: NaN });
      const pct = v <= 1 ? v * 100 : v;
      if (/print/i.test(f)) by.get(c).print = +pct.toFixed(1); else if (/e-?book/i.test(f)) by.get(c).ebook = +pct.toFixed(1);
    });
    const rows = [...by.values()].filter(d => isFinite(d.print) && isFinite(d.ebook));
    return rows.length ? rows : null;
  }
  async function loadFromTableau() {
    for (const ws of worksheets) { try { const rows = await readSheet(ws); if (rows) return rows; } catch (e) { /* try next sheet */ } }
    return null;
  }
  async function init() {
    try {
      if (!window.tableau || !tableau.extensions) throw new Error("no api");
      await withTimeout(tableau.extensions.initializeAsync(), 5000);
      inTableau = true;
      worksheets = tableau.extensions.dashboardContent.dashboard.worksheets;
      const rows = await loadFromTableau();
      DATA = enrich(rows || SAMPLE.map(d => ({ ...d })));
      setBadge(rows ? "Live data from Tableau" : "Sample data (no Country/Format/Share sheet found)");
      worksheets.forEach(ws => {
        ws.addEventListener(tableau.TableauEventType.FilterChanged, refresh);
        ws.addEventListener(tableau.TableauEventType.MarkSelectionChanged, () => syncSelection(ws));
      });
    } catch (e) {
      DATA = enrich(SAMPLE.map(d => ({ ...d })));
      setBadge("Preview: sample data (open inside Tableau for live data)");
    }
    render(true);
    let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => render(false), 120); }).observe(document.getElementById("chart"));
  }
  async function refresh() { const rows = await loadFromTableau(); if (rows) { DATA = enrich(rows); render(true); } }
  async function syncSelection(ws) {
    try {
      const sel = await ws.getSelectedMarksAsync(); selected = new Set();
      sel.data.forEach(t => { const i = t.columns.findIndex(c => /^country$/i.test(c.fieldName)); if (i >= 0) t.data.forEach(r => selected.add(r[i].value)); });
      applySelection();
    } catch (e) { /* ignore */ }
  }
  async function pushSelection(country) {
    selected = selected.has(country) && selected.size === 1 ? new Set() : new Set([country]);
    applySelection();
    if (!inTableau) return;
    for (const ws of worksheets) {
      try {
        if (selected.size) await ws.selectMarksByValueAsync([{ fieldName: "Country", value: [...selected] }], tableau.SelectionUpdateType.Replace);
        else await ws.clearSelectedMarksAsync();
      } catch (e) { /* sheet without Country */ }
    }
  }
  function applySelection() {
    const has = selected.size > 0;
    d3.selectAll("[data-country]").classed("dim", function () { return has && !selected.has(this.dataset.country); })
      .classed("sel", function () { return has && selected.has(this.dataset.country); });
  }
  function setBadge(t) { const b = document.getElementById("badge"); if (b) b.textContent = t; }

  /* ---------------- shared tooltip ---------------- */
  const tip = document.getElementById("tip");
  const tipHTML = d => `<b>${d.c} <span class="muted">· #${d.rank}</span></b>
    <div class="r"><span>Printed books</span><span>${d.print.toFixed(1)}%</span></div>
    <div class="r"><span>E-books</span><span>${d.ebook.toFixed(1)}%</span></div>
    <div class="r"><span>Print lead</span><span>${d.gap.toFixed(1)} pts</span></div>
    <div class="r"><span>E-book per 10 print</span><span>${d.ratio.toFixed(1)}</span></div>`;
  function showTip(evt, d) {
    if (!tip) return; tip.innerHTML = tipHTML(d); tip.classList.add("on");
    const W = innerWidth, H = innerHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = evt.clientX + 14, y = evt.clientY - th - 10;
    if (x + tw > W - 4) x = evt.clientX - tw - 14; if (y < 4) y = evt.clientY + 16; if (y + th > H) y = H - th - 4;
    tip.style.left = Math.max(4, x) + "px"; tip.style.top = y + "px";
  }
  const hideTip = () => tip && tip.classList.remove("on");

  /* ---------------- fruit glyphs (peach + orange) ---------------- */
  const defs = d3.select("body").insert("svg", ":first-child").attr("width", 0).attr("height", 0).attr("aria-hidden", "true")
    .style("position", "absolute").append("defs");
  function grad(type, id, stops, attrs) {
    const g = defs.append(type).attr("id", id); Object.entries(attrs).forEach(([k, v]) => g.attr(k, v));
    g.selectAll("stop").data(stops).join("stop").attr("offset", s => s[0]).attr("stop-color", s => s[1]).attr("stop-opacity", s => s[2] ?? 1);
  }
  const PEACH = {
    skin: [[0, "#e9505a"], [.38, "#f4775f"], [.72, "#ffab6e"], [1, "#ffc97a"]],
    shadeX: [[0, "#ffffff", 0], [.84, "#d9573f", 0], [.95, "#c44a33", .35], [1, "#a83b28", .6]],
    shadeY: [[0, "#ffffff", .22], [.15, "#ffffff", 0], [.72, "#b8452f", 0], [1, "#9c3622", .45]],
    flesh: [[0, "#ffd27a"], [.6, "#ffbd5c"], [1, "#f9a646"]],
    halo: [[0, "#d9413b", .9], [.5, "#ea6446", .5], [1, "#f6904f", 0]],
    stone: [[0, "#c47a4a"], [.55, "#94502c"], [1, "#66301a"]],
    leaf: [[0, "#a3d063"], [1, "#4c8b2b"]],
    rim: "#ef7a52", crease: "#c2463a", ridge: "#4f220d", stem: "#6d4428", vein: "#3f7a22"
  };
  const ORANGE = {
    skinX: [[0, "#ffb45c"], [.06, "#ffa640"], [.15, "#f99a2a"], [.8, "#f38f1f"], [.88, "#e5800f"], [.93, "#d06e08"], [.97, "#b85c05"], [1, "#a14f04"]],
    skinY: [[0, "#ffd9a8", .6], [.13, "#ffc27a", 0], [.7, "#f38f1f", 0], [.88, "#c9620a", .45], [1, "#a54f05", .8]],
    coreR: [[0, "#e3f5b0"], [.3, "#d2ee8e"], [.55, "#b5e05e"], [.8, "#8fcc3a"], [.93, "#74bb2c"], [1, "#66b026"]],
    coreX: [[0, "#3f7f1a", 1], [.07, "#4f9222", .85], [.2, "#7db83a", .35], [.4, "#b5e05e", 0]],
    coreY: [[0, "#4a8a1f", .9], [.12, "#6fae2e", .45], [.28, "#b5e05e", 0]]
  };
  grad("radialGradient", "pk-skin", PEACH.skin, { cx: .78, cy: .2, r: 1.05 });
  grad("linearGradient", "pk-shade-x", PEACH.shadeX, { x1: 0, x2: 1, y1: 0, y2: 0 });
  grad("linearGradient", "pk-shade-y", PEACH.shadeY, { x1: 0, x2: 0, y1: 0, y2: 1 });
  grad("radialGradient", "pk-flesh", PEACH.flesh, { cx: 0, cy: .5, r: 1.05 });
  grad("radialGradient", "pk-halo", PEACH.halo, { cx: 0, cy: .5, r: 1 });
  grad("radialGradient", "pk-stone", PEACH.stone, { cx: .2, cy: .38, r: .95 });
  grad("linearGradient", "pk-leaf", PEACH.leaf, { x1: 0, x2: 1, y1: 0, y2: 1 });
  grad("linearGradient", "or-skin-x", ORANGE.skinX, { x1: 0, x2: 1, y1: 0, y2: 0 });
  grad("linearGradient", "or-skin-y", ORANGE.skinY, { x1: 0, x2: 0, y1: 0, y2: 1 });
  grad("radialGradient", "or-core-r", ORANGE.coreR, { cx: .47, cy: .5, r: .56 });
  grad("linearGradient", "or-core-x", ORANGE.coreX, { x1: 0, x2: 1, y1: 0, y2: 0 });
  grad("linearGradient", "or-core-y", ORANGE.coreY, { x1: 0, x2: 0, y1: 0, y2: 1 });
  defs.append("filter").attr("id", "fs-shadow").attr("x", "-25%").attr("y", "-25%").attr("width", "160%").attr("height", "160%")
    .append("feDropShadow").attr("dx", 2.5).attr("dy", 3.5).attr("stdDeviation", 2.6).attr("flood-color", "#a08a7a").attr("flood-opacity", .5);

  // All glyph geometry is drawn around (0,0) so it can be placed anywhere (grid cell or map point).
  const peachHalf = (r, s, close = true) => `M0,${-.82 * r} C${s * .28 * r},${-1.04 * r} ${s * .98 * r},${-.98 * r} ${s * r},${-.08 * r} C${s * 1.02 * r},${.62 * r} ${s * .5 * r},${r} 0,${1.05 * r}${close ? " Z" : ""}`;
  const stoneHalf = w => { const h = w * 1.25; return `M0,${-h} C${w * 1.15},${-h * .8} ${w * 1.15},${h * .8} 0,${h} Z`; };
  const half = (r, side) => `M0,${-r} A${r},${r} 0 0 ${side} 0,${r} Z`;
  const arc = r => `M0,${-r} A${r},${r} 0 0 1 0,${r}`;
  let clipN = 0, fruitStyle = "peach";
  try { if (localStorage.getItem("pswFruit") === "orange") fruitStyle = "orange"; } catch (e) { }
  function drawPeach(g, rP, rE) {
    const f = g.append("g").attr("class", "fruitG").attr("filter", "url(#fs-shadow)");
    ["pk-skin", "pk-shade-x", "pk-shade-y"].forEach(id => f.append("path").attr("d", peachHalf(rP, -1)).attr("fill", `url(#${id})`));
    f.append("path").attr("d", `M${-.04 * rP},${-.8 * rP} C${-.4 * rP},${-.5 * rP} ${-.44 * rP},${.3 * rP} ${-.18 * rP},${.96 * rP}`)
      .attr("fill", "none").attr("stroke", PEACH.crease).attr("stroke-width", Math.max(1, rP * .022)).attr("opacity", .35).attr("stroke-linecap", "round");
    f.append("ellipse").attr("cx", -rP * .52).attr("cy", -rP * .42).attr("rx", rP * .17).attr("ry", rP * .09).attr("fill", "#fff").attr("opacity", .3)
      .attr("transform", `rotate(-40 ${-rP * .52} ${-rP * .42})`);
    f.append("path").attr("d", peachHalf(rP, 1)).attr("fill", "url(#pk-flesh)");
    f.append("path").attr("d", peachHalf(rP, 1, false)).attr("fill", "none").attr("stroke", PEACH.rim).attr("stroke-width", Math.max(1.5, rP * .04));
    const id = "pk-clip-" + (++clipN);
    f.append("clipPath").attr("id", id).append("path").attr("d", peachHalf(rP - 1, 1));
    const cg = f.append("g").attr("clip-path", `url(#${id})`).append("g").attr("class", "coreG");
    const w = rE * .9;
    if (w > 0) {
      const h = w * 1.25;
      cg.append("path").attr("d", stoneHalf(w * 1.55)).attr("fill", "url(#pk-halo)");
      cg.append("path").attr("d", stoneHalf(w)).attr("fill", "url(#pk-stone)");
      [[.12, -.7, .38, .12, .22, .42], [.32, -.2, .32, .14, .06, .42], [.16, .32, .32, .06, .12, .32]].forEach(([a, b, qx, qy, ex, ey]) =>
        cg.append("path").attr("d", `M${w * a},${h * b} q${w * qx},${h * qy} ${w * ex},${h * ey}`).attr("fill", "none")
          .attr("stroke", PEACH.ridge).attr("stroke-width", Math.max(.8, w * .07)).attr("stroke-linecap", "round").attr("opacity", .45));
    }
    f.append("path").attr("d", `M${.02 * rP},${-.82 * rP} C${.03 * rP},${-.93 * rP} ${.07 * rP},${-1.0 * rP} ${.1 * rP},${-1.06 * rP}`)
      .attr("fill", "none").attr("stroke", PEACH.stem).attr("stroke-width", Math.max(1.5, rP * .055)).attr("stroke-linecap", "round");
    const lx = .06 * rP, ly = -.97 * rP;
    f.append("path").attr("d", `M${lx},${ly} C${lx + .22 * rP},${ly - .3 * rP} ${lx + .56 * rP},${ly - .22 * rP} ${lx + .72 * rP},${ly - .06 * rP} C${lx + .52 * rP},${ly + .1 * rP} ${lx + .22 * rP},${ly + .1 * rP} ${lx},${ly} Z`).attr("fill", "url(#pk-leaf)");
    return f;
  }
  function drawOrange(g, rP, rE) {
    rP *= 1.06; rE *= 1.06;
    const f = g.append("g").attr("class", "fruitG").attr("filter", "url(#fs-shadow)");
    ["or-skin-x", "or-skin-y"].forEach(id => f.append("path").attr("d", half(rP, 0)).attr("fill", `url(#${id})`));
    f.append("ellipse").attr("cx", -rP * .5).attr("cy", -rP * .48).attr("rx", rP * .17).attr("ry", rP * .09).attr("fill", "#fff").attr("opacity", .38)
      .attr("transform", `rotate(-38 ${-rP * .5} ${-rP * .48})`);
    f.append("path").attr("d", half(rP, 1)).attr("fill", "#fff6e6");
    f.append("path").attr("d", arc(rP - 1)).attr("fill", "none").attr("stroke", "#f3d9b0").attr("stroke-width", Math.max(1.5, rP * .03));
    const cg = f.append("g").attr("class", "coreG");
    if (rE > 0) {
      ["or-core-r", "or-core-x", "or-core-y"].forEach(id => cg.append("path").attr("d", half(rE, 1)).attr("fill", `url(#${id})`));
      cg.append("path").attr("d", arc(rE)).attr("fill", "none").attr("stroke", "#f0fbd0").attr("stroke-width", 1.2).attr("opacity", .9);
    }
    return f;
  }
  const drawFruit = (g, rP, rE) => (fruitStyle === "orange" ? drawOrange : drawPeach)(g, rP, rE);
  // Grow-in: fruit pops from 30% with a back-out ease, then the centre grows from the cut.
  function animateFruit(sel, delay) {
    if (reduce) return;
    sel.select(".fruitG").interrupt().attr("transform", "scale(.3)").attr("opacity", 0)
      .transition().delay(delay).duration(700).ease(d3.easeBackOut.overshoot(1.5)).attr("transform", "scale(1)").attr("opacity", 1);
    sel.select(".coreG").interrupt().attr("transform", "scale(0)")
      .transition().delay((d, i) => (typeof delay === "function" ? delay(d, i) : delay) + 450).duration(650).ease(d3.easeCubicOut).attr("transform", "scale(1)");
  }

  /* ---------------- view: peach grid ---------------- */
  let sortKey = "gap";
  const SORTS = { gap: (a, b) => b.gap - a.gap, print: (a, b) => b.print - a.print, ebook: (a, b) => b.ebook - a.ebook, ratio: (a, b) => b.ratio - a.ratio };
  function renderGrid(animate) {
    const host = d3.select("#chart"); host.selectAll("*").remove();
    const W = host.node().clientWidth, H = host.node().clientHeight;
    const n = DATA.length, cols = W < 520 ? 2 : W < 860 ? 3 : 5, rows = Math.ceil(n / cols);
    const cw = W / cols, ch = H / rows, labelH = 40;
    const rMax = Math.max(12, Math.min(cw * .42, (ch - labelH) / 2.35));
    const r = d3.scaleSqrt().domain([0, d3.max(DATA, d => d.print)]).range([0, rMax]);
    const svg = host.append("svg").attr("width", W).attr("height", H).attr("role", "img").attr("aria-label", "Sliced fruit chart, one fruit per country");
    const order = [...DATA].sort(SORTS[sortKey]);
    const pos = (d) => { const i = order.indexOf(d); return [cw * (i % cols) + cw / 2, ch * Math.floor(i / cols) + labelH * .55 + (ch - labelH) / 2]; };
    const cells = svg.selectAll("g.cell").data(order, d => d.c).join("g").attr("class", "cell").attr("data-country", d => d.c)
      .attr("transform", d => `translate(${pos(d)})`).style("cursor", "pointer");
    cells.append("rect").attr("class", "hit").attr("x", -cw / 2 + 4).attr("y", -(ch - labelH) / 2 - labelH * .55).attr("width", cw - 8).attr("height", ch - 8).attr("rx", 10);
    cells.append("text").attr("class", "val").attr("y", -(ch - labelH) / 2 - labelH * .55 + 18).attr("text-anchor", "middle")
      .html(d => `<tspan class="vp">${d.print.toFixed(1)}%</tspan><tspan class="sep" dx="6">·</tspan><tspan class="ve" dx="6">${d.ebook.toFixed(1)}%</tspan>`);
    cells.each(function (d) { drawFruit(d3.select(this).append("g").attr("class", "glyph"), r(d.print), r(d.ebook)); });
    cells.append("text").attr("class", "nm").attr("y", (ch - labelH) / 2 + 2).attr("text-anchor", "middle")
      .html(d => `<tspan class="rk">#${order.indexOf(d) + 1}</tspan><tspan dx="5">${d.c}</tspan>`);
    cells.on("mousemove", (e, d) => showTip(e, d)).on("mouseleave", hideTip).on("click", (e, d) => pushSelection(d.c));
    if (animate) animateFruit(cells.select(".glyph"), (d, i) => i * 85);
    applySelection();
    // re-order with a smooth slide (positions are SVG transforms, so D3 interpolates them directly)
    d3.selectAll("[data-sort]").on("click", function () {
      sortKey = this.dataset.sort; d3.selectAll("[data-sort]").attr("aria-pressed", function () { return this.dataset.sort === sortKey; });
      const o2 = [...DATA].sort(SORTS[sortKey]);
      const p2 = d => { const i = o2.indexOf(d); return [cw * (i % cols) + cw / 2, ch * Math.floor(i / cols) + labelH * .55 + (ch - labelH) / 2]; };
      cells.select(".rk").text(d => "#" + (o2.indexOf(d) + 1));
      cells.transition().duration(reduce ? 0 : 750).delay((d, i) => reduce ? 0 : o2.indexOf(d) * 30).ease(d3.easeCubicInOut).attr("transform", d => `translate(${p2(d)})`);
      order.splice(0, order.length, ...o2);
    });
  }

  /* ---------------- view: peach map (layered) ---------------- */
  let world = null;
  const layers = { graticule: true, countries: true, leaders: true, fruit: true, labels: true };
  async function getWorld() {
    if (world) return world;
    const topo = await d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json");
    world = topojson.feature(topo, topo.objects.countries);
    world.features = world.features.filter(f => f.id !== "010"); // drop Antarctica
    return world;
  }
  async function renderMap(animate) {
    const host = d3.select("#chart"); host.selectAll("*").remove();
    const W = host.node().clientWidth, H = host.node().clientHeight;
    const svg = host.append("svg").attr("width", W).attr("height", H).attr("role", "img").attr("aria-label", "World map with a sliced peach on each of ten markets");
    let geo;
    try { geo = await getWorld(); } catch (e) { svg.append("text").attr("x", 16).attr("y", 28).attr("class", "nm").text("Map data could not load. Check the network connection."); return; }
    const proj = d3.geoEqualEarth().fitExtent([[8, 8], [W - 8, H - 8]], geo);
    const path = d3.geoPath(proj);
    const byId = new Map(DATA.map(d => [GEO[d.c] && GEO[d.c].id, d]));
    const color = d3.scaleSequential(d3.interpolateRgb(COLORS.printTint, COLORS.print)).domain([20, 60]);

    // Layer 1: sphere + graticule
    const gGrat = svg.append("g").attr("class", "layer-graticule");
    gGrat.append("path").attr("d", path({ type: "Sphere" })).attr("fill", "#F7FAFC").attr("stroke", COLORS.rule);
    gGrat.append("path").attr("d", path(d3.geoGraticule10())).attr("fill", "none").attr("stroke", COLORS.grid).attr("stroke-width", .6);
    // Layer 2: countries (the ten markets shaded by print share)
    const gC = svg.append("g").attr("class", "layer-countries");
    gC.selectAll("path").data(geo.features).join("path").attr("d", path)
      .attr("fill", f => byId.has(f.id) ? color(byId.get(f.id).print) : "#E9EDF1").attr("stroke", "#fff").attr("stroke-width", .5)
      .attr("data-country", f => byId.has(f.id) ? byId.get(f.id).c : null)
      .style("cursor", f => byId.has(f.id) ? "pointer" : null)
      .on("mousemove", (e, f) => byId.has(f.id) && showTip(e, byId.get(f.id))).on("mouseleave", hideTip)
      .on("click", (e, f) => byId.has(f.id) && pushSelection(byId.get(f.id).c));

    // Glyph placement: anchor at the country, then a force layout separates overlapping fruits (Europe).
    const rMax = Math.max(14, Math.min(W, H * 1.8) * .045);
    const r = d3.scaleSqrt().domain([0, d3.max(DATA, d => d.print)]).range([0, rMax]);
    // Collision radius covers the whole peach incl. leaf and the label under it; a weak pull keeps each fruit near its country.
    const nodes = DATA.filter(d => GEO[d.c]).map(d => { const [ax, ay] = proj(GEO[d.c].ll); return { d, ax, ay, x: ax, y: ay, r: r(d.print) * 1.32 + 8 }; });
    const sim = d3.forceSimulation(nodes).stop()
      .force("x", d3.forceX(n => n.ax).strength(.05)).force("y", d3.forceY(n => n.ay).strength(.05))
      .force("collide", d3.forceCollide(n => n.r).strength(1).iterations(6));
    for (let i = 0; i < 500; i++) sim.tick();
    nodes.forEach(n => { n.x = Math.max(n.r, Math.min(W - n.r, n.x)); n.y = Math.max(n.r * 1.2, Math.min(H - n.r, n.y)); });

    // Layer 3: leader lines + anchor dots
    const gL = svg.append("g").attr("class", "layer-leaders");
    gL.selectAll("line").data(nodes).join("line").attr("x1", n => n.ax).attr("y1", n => n.ay).attr("x2", n => n.x).attr("y2", n => n.y)
      .attr("stroke", COLORS.ink3).attr("stroke-width", 1).attr("opacity", n => Math.hypot(n.x - n.ax, n.y - n.ay) > 4 ? .7 : 0);
    gL.selectAll("circle").data(nodes).join("circle").attr("cx", n => n.ax).attr("cy", n => n.ay).attr("r", 2.5).attr("fill", COLORS.ink);
    // Layer 4: fruit glyphs
    const gF = svg.append("g").attr("class", "layer-fruit");
    const glyphs = gF.selectAll("g.mk").data(nodes).join("g").attr("class", "mk").attr("data-country", n => n.d.c)
      .attr("transform", n => `translate(${n.x},${n.y})`).style("cursor", "pointer");
    glyphs.each(function (n) { drawFruit(d3.select(this).append("g").attr("class", "glyph"), r(n.d.print), r(n.d.ebook)); });
    glyphs.on("mousemove", (e, n) => showTip(e, n.d)).on("mouseleave", hideTip).on("click", (e, n) => pushSelection(n.d.c));
    // Layer 5: labels
    const gT = svg.append("g").attr("class", "layer-labels");
    gT.selectAll("text").data(nodes).join("text").attr("class", "maplbl").attr("data-country", n => n.d.c)
      .attr("x", n => n.x).attr("y", n => n.y + r(n.d.print) * 1.12 + 13).attr("text-anchor", "middle").text(n => short(n.d.c));

    // Layer legend (sequential scale)
    const lg = svg.append("g").attr("class", "legend-g").attr("transform", `translate(14,${H - 44})`);
    const lw = 150, gid = "lg-grad";
    const lgr = defs.select("#" + gid).empty() ? defs.append("linearGradient").attr("id", gid) : defs.select("#" + gid);
    lgr.selectAll("stop").data([0, 1]).join("stop").attr("offset", d => d).attr("stop-color", d => color(20 + d * 40));
    lg.append("text").attr("class", "lgt").attr("y", -6).text("Print share (country fill)");
    lg.append("rect").attr("width", lw).attr("height", 8).attr("rx", 2).attr("fill", `url(#${gid})`);
    lg.selectAll("text.tk").data([20, 40, 60]).join("text").attr("class", "tk").attr("x", v => (v - 20) / 40 * lw).attr("y", 22)
      .attr("text-anchor", (v, i) => i === 0 ? "start" : i === 2 ? "end" : "middle").text(v => v + "%");

    applyLayers(false);
    applySelection();
    if (animate && !reduce) {
      // Entrance: countries fade up by print share, then each fruit drops in from its anchor along the leader line.
      gC.selectAll("path").attr("opacity", 0).transition().duration(700).delay(f => byId.has(f.id) ? 200 + byId.get(f.id).rank * 40 : 0).attr("opacity", 1);
      gL.selectAll("line").attr("x2", n => n.ax).attr("y2", n => n.ay).transition().delay((n, i) => 500 + n.d.rank * 90).duration(600).ease(d3.easeCubicOut)
        .attr("x2", n => n.x).attr("y2", n => n.y);
      glyphs.attr("transform", n => `translate(${n.ax},${n.ay})`).transition().delay(n => 500 + n.d.rank * 90).duration(700).ease(d3.easeCubicOut)
        .attr("transform", n => `translate(${n.x},${n.y})`);
      animateFruit(glyphs.select(".glyph"), n => 500 + n.d.rank * 90);
      gT.selectAll("text").attr("opacity", 0).transition().delay(n => 1100 + n.d.rank * 90).duration(400).attr("opacity", 1);
    }
  }
  function applyLayers(animate) {
    Object.entries(layers).forEach(([k, on]) => {
      d3.select(".layer-" + k).transition().duration(animate && !reduce ? 350 : 0).style("opacity", on ? 1 : 0)
        .on("end", function () { d3.select(this).style("pointer-events", on ? null : "none"); });
    });
  }
  d3.selectAll("[data-layer]").on("change", function () { layers[this.dataset.layer] = this.checked; applyLayers(true); });

  /* ---------------- view: scatter ---------------- */
  function renderScatter(animate) {
    const host = d3.select("#chart"); host.selectAll("*").remove();
    const W = host.node().clientWidth, H = host.node().clientHeight, m = { l: 44, r: 14, t: 18, b: 40 };
    const x = d3.scaleLinear().domain([0, 60]).range([m.l, W - m.r]), y = d3.scaleLinear().domain([0, 30]).range([H - m.b, m.t]);
    const svg = host.append("svg").attr("width", W).attr("height", H).attr("role", "img").attr("aria-label", "Scatter of e-book share against print share with parity lines");
    svg.append("g").selectAll("line").data(d3.range(0, 61, 10)).join("line").attr("x1", x).attr("x2", x).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", COLORS.grid);
    svg.append("g").selectAll("line").data(d3.range(0, 31, 10)).join("line").attr("y1", y).attr("y2", y).attr("x1", m.l).attr("x2", W - m.r).attr("stroke", COLORS.grid);
    svg.append("g").selectAll("text").data(d3.range(0, 61, 10)).join("text").attr("class", "tk").attr("x", x).attr("y", H - m.b + 16).attr("text-anchor", "middle").text(d => d + "%");
    svg.append("g").selectAll("text").data(d3.range(0, 31, 10)).join("text").attr("class", "tk").attr("x", 0).attr("y", d => y(d) + 4).text(d => d + "%");
    svg.append("text").attr("class", "tk").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text("PRINT SHARE →");
    svg.append("text").attr("class", "tk").attr("x", m.l + 8).attr("y", m.t + 12).text("↑ E-BOOK SHARE");
    const rays = [{ k: 10, l: "parity" }, { k: 5, l: "5 per 10" }, { k: 2.5, l: "2.5 per 10" }].map(r => { const xe = Math.min(60, 30 / (r.k / 10)); return { ...r, xe, ye: r.k / 10 * xe }; });
    const rl = svg.append("g").selectAll("line").data(rays).join("line").attr("x1", x(0)).attr("y1", y(0)).attr("x2", r => x(r.xe)).attr("y2", r => y(r.ye))
      .attr("stroke", r => r.k === 10 ? COLORS.ink2 : COLORS.ink3).attr("stroke-width", r => r.k === 10 ? 1.5 : 1).attr("opacity", r => r.k === 10 ? .9 : .55);
    svg.append("g").selectAll("text").data(rays).join("text").attr("class", "tk")
      .attr("x", r => r.k === 10 ? x(r.xe) + 8 : x(r.xe) - 6).attr("y", r => r.k === 10 ? y(r.ye) + 12 : r.k === 5 ? y(r.ye) + 18 : y(r.ye) - 8)
      .attr("text-anchor", r => r.k === 10 ? "start" : "end").text(r => r.l);
    const pts = svg.append("g").selectAll("circle").data(DATA).join("circle").attr("data-country", d => d.c)
      .attr("cx", d => x(d.print)).attr("cy", d => y(d.ebook)).attr("r", 7).attr("fill", COLORS.print).attr("stroke", "#fff").attr("stroke-width", 2);
    const labels = DATA.map(d => { const w = short(d.c).length * 7 + 8; return { d, w, ax: x(d.print), ay: y(d.ebook), x: x(d.print) + w / 2 + 10, y: y(d.ebook) - 14, r: w / 2 * .62 + 3 }; });
    const anchors = DATA.map(d => ({ fx: x(d.print), fy: y(d.ebook), r: 11, fixed: true }));
    const sim = d3.forceSimulation([...anchors, ...labels]).stop()
      .force("collide", d3.forceCollide(n => n.r).strength(.9).iterations(3))
      .force("x", d3.forceX(n => n.fixed ? n.fx : n.ax + n.w / 2 + 10).strength(n => n.fixed ? 0 : .12))
      .force("y", d3.forceY(n => n.fixed ? n.fy : n.ay - 14).strength(n => n.fixed ? 0 : .12));
    for (let i = 0; i < 260; i++) sim.tick();
    labels.forEach(l => { l.x = Math.max(m.l + l.w / 2, Math.min(W - m.r - l.w / 2, l.x)); l.y = Math.max(m.t + 10, Math.min(H - m.b - 6, l.y)); });
    const lt = svg.append("g").selectAll("text").data(labels).join("text").attr("class", "maplbl").attr("data-country", l => l.d.c)
      .attr("x", l => l.x).attr("y", l => l.y + 4).attr("text-anchor", "middle").text(l => short(l.d.c));
    const del = d3.Delaunay.from(DATA, d => x(d.print), d => y(d.ebook));
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("mousemove", e => { const [px, py] = d3.pointer(e), d = DATA[del.find(px, py)]; pts.attr("r", p => p === d ? 10 : 7); showTip(e, d); })
      .on("mouseleave", () => { pts.attr("r", 7); hideTip(); })
      .on("click", e => { const [px, py] = d3.pointer(e); pushSelection(DATA[del.find(px, py)].c); });
    applySelection();
    if (animate && !reduce) {
      rl.each(function () { const L = this.getTotalLength(); d3.select(this).attr("stroke-dasharray", `${L} ${L}`).attr("stroke-dashoffset", L); })
        .transition().delay((d, i) => i * 180).duration(900).ease(d3.easeCubicInOut).attr("stroke-dashoffset", 0);
      const order = [...DATA].sort((a, b) => a.print - b.print);
      pts.attr("cy", y(0)).attr("opacity", 0).transition().delay(d => 500 + order.indexOf(d) * 90).duration(900)
        .ease(d3.easeElasticOut.amplitude(1).period(.55)).attr("cy", d => y(d.ebook)).attr("opacity", 1);
      lt.attr("opacity", 0).transition().delay(l => 1500 + order.indexOf(l.d) * 60).duration(450).attr("opacity", 1);
    }
  }

  /* ---------------- view: single shape (for Tableau custom-shape export) ---------------- */
  function renderShape() {
    const name = params.get("c") || "Germany", d = DATA.find(x => x.c === name) || DATA[0];
    if (params.get("style") === "orange") fruitStyle = "orange";
    const S = 200, svg = d3.select("#chart").append("svg").attr("width", S).attr("height", S);
    const r = d3.scaleSqrt().domain([0, d3.max(DATA, x => x.print)]).range([0, 80]);
    // Every shape uses the same scale (largest market = 80px radius) so Tableau's shape size stays comparable.
    drawFruit(svg.append("g").attr("transform", `translate(100,${104})`), r(d.print), r(d.ebook));
  }

  /* ---------------- controls + dispatch ---------------- */
  d3.selectAll("[data-fstyle]").attr("aria-pressed", function () { return this.dataset.fstyle === fruitStyle; }).on("click", function () {
    fruitStyle = this.dataset.fstyle; try { localStorage.setItem("pswFruit", fruitStyle); } catch (e) { }
    d3.selectAll("[data-fstyle]").attr("aria-pressed", function () { return this.dataset.fstyle === fruitStyle; }); render(true);
  });
  d3.select("#replay").on("click", () => render(true));
  function render(animate) {
    hideTip();
    if (VIEW === "peach") renderGrid(animate);
    else if (VIEW === "map") renderMap(animate);
    else if (VIEW === "scatter") renderScatter(animate);
    else if (VIEW === "shape") renderShape();
  }
  if (VIEW === "shape") { DATA = enrich(SAMPLE.map(d => ({ ...d }))); render(false); } else init();
})();
