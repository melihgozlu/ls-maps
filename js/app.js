// LS Maps — GTA tarzı görünüme sahip Waze benzeri navigasyon.
// Ücretsiz servisler: OpenFreeMap (harita karoları), OSRM demo sunucusu (rotalama), Nominatim (arama).

(function () {
  "use strict";

  var OSRM_URL = "https://router.project-osrm.org/route/v1/driving/";
  var NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
  var DEFAULT_CENTER = [32.4932, 37.8746]; // Konya — GPS öncesi varsayılan merkez
  var OFF_ROUTE_METERS = 60;
  var OFF_ROUTE_SECONDS = 6;
  var ARRIVE_METERS = 28;
  var DEMO_SPEED_MPS = 17; // ~61 km/s
  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  // Ortak bildirim altyapısı (Supabase)
  var SUPA_URL = "https://powdosapvcvlrhpcggqz.supabase.co";
  var SUPA_KEY = "sb_publishable_4QnCoMp5Q86_hYCCGvGU3w_TwRVmNVF";
  // TomTom — canlı trafik
  var TOMTOM_KEY = "D6R8XYf9jmjbFIr4o1Nt3lhEWNuDfY9n";
  var TOMTOM_INCIDENTS = "https://api.tomtom.com/traffic/services/5/incidentDetails";
  var TOMTOM_ROUTE = "https://api.tomtom.com/routing/1/calculateRoute/";
  var ALERT_RADIUS_M = 500;          // bu mesafe içinde uyar
  var ALERT_REWARN_MS = 10 * 60 * 1000; // aynı nokta için 10 dk tekrar uyarma
  var POLICE_TTL_MS = 4 * 60 * 60 * 1000; // polis bildirimleri 4 saat geçerli

  var map, playerMarker, waypointMarker;
  var playerPos = null;        // [lng, lat]
  var playerHeading = 0;       // derece
  var playerSpeedMps = 0;
  var lastGpsPos = null;
  var hasGpsFix = false;
  var following = true;

  var route = null;            // { coords, cum, totalDist, totalDur, steps }
  var waypointLngLat = null;
  var customOrigin = null;     // [lng, lat] başlangıç ≠ mevcut konum olduğunda
  var originMarker = null;
  var navActive = false;
  var demoActive = false;
  var demoTraveled = 0;
  var demoLastTs = null;
  var demoRaf = null;
  var progressIdx = 0;         // eşleşen son segment indeksi
  var offRouteSince = null;
  var rerouting = false;
  var announcedForStep = {};   // stepIdx -> yapılan en yüksek anons seviyesi (1=uzak, 2=yakın, 3=şimdi)
  var voiceOn = true;
  var wakeLock = null;
  var arrived = false;

  var cameras = [], cameraFetchCenter = null, cameraBackoffUntil = 0;
  var police = [], policeFetchAt = 0;
  var incidents = [], incidentFetchCenter = null, incidentBackoffUntil = 0;
  var trafficOn = true;
  var warnedAt = {};        // uyarı id -> son uyarı zamanı
  var audioCtx = null;
  var alertHideTimer = null;
  var alertsReady = false;

  var $ = function (id) { return document.getElementById(id); };

  // ---------------- Geometri yardımcıları ----------------
  var R = 6371000;
  function toRad(d) { return d * Math.PI / 180; }

  function haversine(a, b) {
    var dLat = toRad(b[1] - a[1]);
    var dLng = toRad(b[0] - a[0]);
    var la1 = toRad(a[1]), la2 = toRad(b[1]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearingDeg(a, b) {
    var la1 = toRad(a[1]), la2 = toRad(b[1]);
    var dLng = toRad(b[0] - a[0]);
    var y = Math.sin(dLng) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function projectToSegment(p, a, b) {
    var cosLat = Math.cos(toRad(p[1]));
    var ax = a[0] * cosLat, ay = a[1];
    var bx = b[0] * cosLat, by = b[1];
    var px = p[0] * cosLat, py = p[1];
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    var qx = ax + t * dx, qy = ay + t * dy;
    var point = [qx / cosLat, qy];
    return { t: t, dist: haversine(p, point), point: point };
  }

  function fmtDist(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " M";
    var km = m / 1000;
    return (km < 10 ? km.toFixed(1) : Math.round(km)) + " KM";
  }

  function fmtDistSpoken(m) {
    if (m < 1000) return (Math.round(m / 50) * 50) + " metre";
    var km = m / 1000;
    if (km < 1.2) return "bir kilometre";
    if (km < 1.7) return "bir buçuk kilometre";
    return Math.round(km) + " kilometre";
  }

  function fmtDuration(s) {
    var min = Math.round(s / 60);
    if (min < 60) return min + " DK";
    return Math.floor(min / 60) + " SA " + (min % 60) + " DK";
  }

  function fmtEta(sRemaining) {
    var d = new Date(Date.now() + sRemaining * 1000);
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  // ---------------- Arayüz yardımcıları ----------------
  var toastTimer = null;
  function toast(msg, info) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.toggle("info", !!info);
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 3500);
  }

  function speak(text) {
    if (!voiceOn || !window.speechSynthesis) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "tr-TR";
      u.rate = 1.0;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* sesli yönlendirme desteklenmiyorsa yoksay */ }
  }

  // ---------------- İşaretçiler ----------------
  function makePlayerMarker() {
    var el = document.createElement("div");
    el.className = "player-marker";
    el.innerHTML =
      '<svg viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">' +
      '<polygon points="17,3 28,29 17,22.5 6,29" fill="#FFFFFF" stroke="#17191C" stroke-width="2.4" stroke-linejoin="round"/>' +
      "</svg>";
    return new maplibregl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" });
  }

  function makeWaypointMarker() {
    var shapes =
      '<rect x="15.5" y="3" width="13" height="38" rx="6.5"/>' +
      '<rect x="3" y="15.5" width="38" height="13" rx="6.5"/>' +
      '<circle cx="22" cy="22" r="8.5"/>';
    var el = document.createElement("div");
    el.className = "waypoint-marker";
    el.innerHTML =
      '<div class="waypoint-pulse"></div>' +
      '<svg class="waypoint-blip" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">' +
      '<g fill="#8F3FE0" stroke="#17191C" stroke-width="3">' + shapes + "</g>" +
      '<g fill="#8F3FE0">' + shapes + "</g>" +
      '<circle cx="22" cy="22" r="3.4" fill="#2A1740"/>' +
      "</svg>";
    return new maplibregl.Marker({ element: el, anchor: "center" });
  }

  // ---------------- Rota katmanları ----------------
  function addRouteLayers() {
    map.addSource("route", { type: "geojson", data: emptyLine() });
    map.addLayer({
      id: "route-glow",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#A868E8",
        "line-opacity": 0.25,
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 8, 16, 20, 19, 34]
      }
    });
    map.addLayer({
      id: "route-casing",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#5A2B94",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 5, 16, 11, 19, 20]
      }
    });
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#A868E8",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 3, 16, 7, 19, 13]
      }
    });
  }

  function makeShieldImage(fill) {
    var s = 2;
    var w = 24 * s, h = 18 * s, r = 5 * s, b = 1.5 * s;
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    function rr(x, y, ww, hh, rad) {
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + ww, y, x + ww, y + hh, rad);
      ctx.arcTo(x + ww, y + hh, x, y + hh, rad);
      ctx.arcTo(x, y + hh, x, y, rad);
      ctx.arcTo(x, y, x + ww, y, rad);
      ctx.closePath();
    }
    rr(0, 0, w, h, r); ctx.fillStyle = "#17191C"; ctx.fill();
    rr(b, b, w - 2 * b, h - 2 * b, r - b); ctx.fillStyle = "#F5F7F8"; ctx.fill();
    rr(2 * b, 2 * b, w - 4 * b, h - 4 * b, r - 2 * b); ctx.fillStyle = fill; ctx.fill();
    return { img: ctx.getImageData(0, 0, w, h), meta: {
      pixelRatio: s,
      content: [12, 10, 36, 26],
      stretchX: [[16, 32]],
      stretchY: [[14, 22]]
    } };
  }

  function addRoadShields() {
    var motorway = makeShieldImage("#3A66A8");
    var aroad = makeShieldImage("#37714E");
    map.addImage("shield-motorway", motorway.img, motorway.meta);
    map.addImage("shield-aroad", aroad.img, aroad.meta);
    map.addLayer({
      id: "road-shield",
      type: "symbol",
      source: "omt",
      "source-layer": "transportation_name",
      minzoom: 8,
      filter: ["all",
        ["has", "ref"],
        ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]]
      ],
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 400,
        "text-field": ["get", "ref"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 10.5,
        "icon-image": ["match", ["get", "class"], "motorway", "shield-motorway", "shield-aroad"],
        "icon-text-fit": "both",
        "icon-text-fit-padding": [3, 7, 3, 7],
        "icon-rotation-alignment": "viewport",
        "text-rotation-alignment": "viewport"
      },
      paint: { "text-color": "#FFFFFF" }
    });
  }

  // ---------------- Hız kameraları + polis uyarıları ----------------
  function makeBlipIcon(bg, glyph) {
    var s = 2, r = 30 * s / 2;
    var c = document.createElement("canvas");
    c.width = 30 * s; c.height = 30 * s;
    var ctx = c.getContext("2d");
    ctx.beginPath(); ctx.arc(r, r, 14 * s / 1, 0, Math.PI * 2); ctx.fillStyle = "#17191C"; ctx.fill();
    ctx.beginPath(); ctx.arc(r, r, 12.5 * s, 0, Math.PI * 2); ctx.fillStyle = "#F5F7F8"; ctx.fill();
    ctx.beginPath(); ctx.arc(r, r, 11 * s, 0, Math.PI * 2); ctx.fillStyle = bg; ctx.fill();
    ctx.font = (14 * s) + "px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(glyph, r, r + s);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  function pointsFC(list) {
    return { type: "FeatureCollection", features: list.map(function (it) {
      return { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: it.pos } };
    }) };
  }

  function addAlertLayers() {
    map.addImage("icon-camera", makeBlipIcon("#E8912D", "📷"), { pixelRatio: 2 });
    map.addImage("icon-police", makeBlipIcon("#3A66A8", "👮"), { pixelRatio: 2 });
    ["cameras", "police"].forEach(function (name) {
      map.addSource(name, { type: "geojson", data: pointsFC([]) });
      map.addLayer({
        id: name + "-layer",
        type: "symbol",
        source: name,
        minzoom: 9,
        layout: {
          "icon-image": name === "cameras" ? "icon-camera" : "icon-police",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.55, 16, 0.95],
          "icon-allow-overlap": true
        }
      });
    });
    alertsReady = true;
  }

  // ---------------- Canlı trafik (TomTom) ----------------
  var INCIDENT_CATS = {
    1:  { glyph: "💥", title: "İLERİDE KAZA VAR", alert: true },
    3:  { glyph: "⚠️", title: "İLERİDE TEHLİKE VAR", alert: true },
    5:  { glyph: "🧊", title: "İLERİDE BUZLANMA VAR", alert: true },
    7:  { glyph: "🚧", title: "İLERİDE ŞERİT KAPALI", alert: true },
    8:  { glyph: "⛔", title: "İLERİDE YOL KAPALI", alert: true },
    9:  { glyph: "🚧", title: "İLERİDE YOL ÇALIŞMASI", alert: true },
    11: { glyph: "🌊", title: "İLERİDE SU BASKINI", alert: true },
    14: { glyph: "🚗", title: "İLERİDE ARIZALI ARAÇ", alert: true }
  };

  function addTrafficLayers() {
    map.addSource("tomtom-flow", {
      type: "raster",
      tiles: ["https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=" + TOMTOM_KEY],
      tileSize: 256,
      maxzoom: 22
    });
    var beforeId = map.getLayer("road-name") ? "road-name" : undefined;
    map.addLayer({
      id: "tomtom-flow-layer",
      type: "raster",
      source: "tomtom-flow",
      paint: { "raster-opacity": 0.55 }
    }, beforeId);

    map.addImage("icon-incident", makeBlipIcon("#E5544B", "⚠"), { pixelRatio: 2 });
    map.addSource("incidents", { type: "geojson", data: pointsFC([]) });
    map.addLayer({
      id: "incidents-layer",
      type: "symbol",
      source: "incidents",
      minzoom: 8,
      layout: {
        "icon-image": "icon-incident",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 16, 0.95],
        "icon-allow-overlap": true
      }
    });
  }

  function setTraffic(on) {
    trafficOn = on;
    var vis = on ? "visible" : "none";
    if (map.getLayer("tomtom-flow-layer")) map.setLayoutProperty("tomtom-flow-layer", "visibility", vis);
    if (map.getLayer("incidents-layer")) map.setLayoutProperty("incidents-layer", "visibility", vis);
    var btn = $("btn-traffic");
    if (btn) btn.classList.toggle("off", !on);
  }

  function fetchIncidents(center) {
    var now = Date.now();
    if (now < incidentBackoffUntil) return;
    if (incidentFetchCenter && haversine(center, incidentFetchCenter) < 4000) return;
    incidentFetchCenter = center;
    var d = 0.12;
    var bbox = (center[0] - d) + "," + (center[1] - d) + "," + (center[0] + d) + "," + (center[1] + d);
    var fields = encodeURIComponent("{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay}}}");
    var url = TOMTOM_INCIDENTS + "?bbox=" + bbox + "&fields=" + fields +
      "&language=tr-TR&timeValidityFilter=present&key=" + TOMTOM_KEY;
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        incidents = [];
        (data.incidents || []).forEach(function (f, idx) {
          var cat = f.properties && f.properties.iconCategory;
          var meta = INCIDENT_CATS[cat];
          if (!meta) return;
          var g = f.geometry || {};
          var pos = null;
          if (g.type === "Point") pos = g.coordinates;
          else if (g.type === "LineString" && g.coordinates.length) pos = g.coordinates[Math.floor(g.coordinates.length / 2)];
          if (!pos) return;
          incidents.push({ id: "inc" + idx + "_" + Math.round(pos[0] * 1e4) + "_" + Math.round(pos[1] * 1e4),
            pos: pos, kind: "incident", title: meta.title, glyph: meta.glyph });
        });
        if (map.getSource("incidents")) map.getSource("incidents").setData(pointsFC(incidents));
      })
      .catch(function () {
        incidentFetchCenter = null;
        incidentBackoffUntil = Date.now() + 120000;
      });
  }

  function fetchCameras(center) {
    var now = Date.now();
    if (now < cameraBackoffUntil) return;
    if (cameraFetchCenter && haversine(center, cameraFetchCenter) < 5000) return;
    cameraFetchCenter = center;
    var d = 0.15;
    var bbox = (center[1] - d) + "," + (center[0] - d) + "," + (center[1] + d) + "," + (center[0] + d);
    var q = '[out:json][timeout:12];node["highway"="speed_camera"](' + bbox + ");out;";
    fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        cameras = (data.elements || []).map(function (el) {
          return { id: "cam" + el.id, pos: [el.lon, el.lat] };
        });
        if (map.getSource("cameras")) map.getSource("cameras").setData(pointsFC(cameras));
      })
      .catch(function () {
        cameraFetchCenter = null;
        cameraBackoffUntil = Date.now() + 60000;
      });
  }

  function fetchPolice(center) {
    if (Date.now() - policeFetchAt < 60000) return;
    policeFetchAt = Date.now();
    var since = new Date(Date.now() - POLICE_TTL_MS).toISOString();
    var d = 0.3;
    var url = SUPA_URL + "/rest/v1/ls_reports?select=id,lng,lat&kind=eq.police" +
      "&created_at=gte." + since +
      "&lat=gte." + (center[1] - d) + "&lat=lte." + (center[1] + d) +
      "&lng=gte." + (center[0] - d) + "&lng=lte." + (center[0] + d) + "&limit=200";
    fetch(url, { headers: { apikey: SUPA_KEY, Authorization: "Bearer " + SUPA_KEY } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (rows) {
        police = rows.map(function (r) { return { id: "pol" + r.id, pos: [r.lng, r.lat] }; });
        if (map.getSource("police")) map.getSource("police").setData(pointsFC(police));
      })
      .catch(function () { /* bildirim sunucusu çevrimdışı */ });
  }

  function submitPoliceReport() {
    if (!hasGpsFix || !playerPos) {
      toast("BİLDİRİM İÇİN GPS KONUMU GEREKLİ", true);
      return;
    }
    fetch(SUPA_URL + "/rest/v1/ls_reports", {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: "Bearer " + SUPA_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ kind: "police", lng: playerPos[0], lat: playerPos[1] })
    })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        toast("POLİS BİLDİRİLDİ — YAKINDAKİ SÜRÜCÜLER GÖRECEK", true);
        police.push({ id: "local" + Date.now(), pos: playerPos.slice() });
        if (map.getSource("police")) map.getSource("police").setData(pointsFC(police));
      })
      .catch(function () { toast("BİLDİRİM SERVİSİ ŞU AN ÇEVRİMDIŞI"); });
  }

  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) {}
  }

  function beepAlert(kind) {
    try {
      unlockAudio();
      if (!audioCtx) return;
      var n = kind === "camera" ? 2 : 1;
      var freq = kind === "camera" ? 880 : 620;
      for (var i = 0; i < n; i++) {
        var t = audioCtx.currentTime + i * 0.22;
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t); o.stop(t + 0.2);
      }
    } catch (e) {}
  }

  function showAlertBanner(kind, distM, item) {
    var el = $("alert-banner");
    el.classList.remove("hidden", "alert-camera", "alert-police", "alert-incident");
    var glyph, title, cls;
    if (kind === "camera") { glyph = "📷"; title = "İLERİDE HIZ KAMERASI"; cls = "alert-camera"; }
    else if (kind === "police") { glyph = "👮"; title = "İLERİDE POLİS BİLDİRİLDİ"; cls = "alert-police"; }
    else { glyph = (item && item.glyph) || "⚠️"; title = (item && item.title) || "İLERİDE OLAY VAR"; cls = "alert-incident"; }
    el.classList.add(cls);
    $("alert-icon").textContent = glyph;
    $("alert-title").textContent = title;
    $("alert-sub").textContent = fmtDist(distM);
    clearTimeout(alertHideTimer);
    alertHideTimer = setTimeout(function () { el.classList.add("hidden"); }, 8000);
  }

  function angleDiff(a, b) {
    return Math.abs((((a - b) % 360) + 540) % 360 - 180);
  }

  function spokenFor(kind, item) {
    if (kind === "camera") return "İleride hız kamerası var.";
    if (kind === "police") return "İleride polis kontrolü bildirildi.";
    var t = (item && item.title) || "İleride trafik olayı var";
    return t.charAt(0) + t.slice(1).toLocaleLowerCase("tr-TR") + ".";
  }

  function checkAlerts(pos, heading) {
    if (!alertsReady) return;
    fetchCameras(pos);
    fetchPolice(pos);
    fetchIncidents(pos);
    var now = Date.now();
    var lists = [
      { items: cameras, kind: "camera" },
      { items: police, kind: "police" },
      { items: incidents, kind: "incident" }
    ];
    for (var l = 0; l < lists.length; l++) {
      var items = lists[l].items, kind = lists[l].kind;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var dM = haversine(pos, it.pos);
        if (dM > ALERT_RADIUS_M) continue;
        if (typeof heading === "number" && dM > 120 && angleDiff(bearingDeg(pos, it.pos), heading) > 85) continue;
        if (warnedAt[it.id] && now - warnedAt[it.id] < ALERT_REWARN_MS) continue;
        warnedAt[it.id] = now;
        beepAlert(kind === "camera" ? "camera" : "police");
        speak(spokenFor(kind, it));
        showAlertBanner(kind, dM, it);
        return;
      }
    }
  }

  function emptyLine() {
    return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } };
  }

  function setRouteGeometry(coords) {
    map.getSource("route").setData({
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: coords }
    });
  }

  // ---------------- Rotalama ----------------
  function fetchRoute(from, to, cb) {
    var url = OSRM_URL + from[0] + "," + from[1] + ";" + to[0] + "," + to[1] +
      "?overview=full&geometries=geojson&steps=true";
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.routes || !data.routes.length) throw new Error("rota bulunamadı");
        var r0 = data.routes[0];
        var coords = r0.geometry.coordinates;
        var cum = [0];
        for (var i = 1; i < coords.length; i++) {
          cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
        }
        var steps = [];
        var legs = r0.legs || [];
        legs.forEach(function (leg) {
          (leg.steps || []).forEach(function (s) { steps.push(s); });
        });
        steps.forEach(function (s) {
          var loc = s.maneuver.location;
          var best = 0, bestD = Infinity;
          for (var i = 0; i < coords.length; i++) {
            var d = haversine(loc, coords[i]);
            if (d < bestD) { bestD = d; best = i; }
          }
          s._distAlong = cum[best];
        });
        cb(null, {
          coords: coords, cum: cum,
          totalDist: r0.distance, totalDur: r0.duration,
          steps: steps
        });
      })
      .catch(function (err) { cb(err); });
  }

  function fetchTrafficETA(from, to, cb) {
    var url = TOMTOM_ROUTE + from[1] + "," + from[0] + ":" + to[1] + "," + to[0] +
      "/json?traffic=true&travelMode=car&key=" + TOMTOM_KEY;
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        var s = data.routes && data.routes[0] && data.routes[0].summary;
        if (!s) throw new Error("özet yok");
        cb(null, { travelSec: s.travelTimeInSeconds, delaySec: s.trafficDelayInSeconds || 0 });
      })
      .catch(function (e) { cb(e); });
  }

  function applyTrafficETA(origin) {
    if (!waypointLngLat) return;
    fetchTrafficETA(origin, waypointLngLat, function (err, t) {
      if (err || !route) return;
      route.totalDur = t.travelSec;
      route.trafficDelaySec = t.delaySec;
      var badge = $("route-traffic");
      if (t.delaySec >= 60) {
        var mins = Math.round(t.delaySec / 60);
        badge.textContent = "+" + mins + " DK TRAFİK";
        badge.classList.remove("hidden");
      } else {
        badge.textContent = "YOL AÇIK";
        badge.classList.remove("hidden");
        badge.classList.add("clear");
      }
      if (!navActive) $("route-time").textContent = fmtDuration(route.totalDur);
    });
  }

  function arrowFor(step) {
    var t = step.maneuver.type, m = step.maneuver.modifier || "";
    if (t === "arrive") return "◉";
    if (t === "roundabout" || t === "rotary") return "⟳";
    if (m.indexOf("uturn") >= 0) return "↩";
    if (m === "left") return "←";
    if (m === "right") return "→";
    if (m === "slight left") return "↖";
    if (m === "slight right") return "↗";
    if (m === "sharp left") return "↰";
    if (m === "sharp right") return "↱";
    return "↑";
  }

  function translateModifier(m) {
    if (m === "left") return "sola";
    if (m === "right") return "sağa";
    if (m === "slight left") return "hafif sola";
    if (m === "slight right") return "hafif sağa";
    if (m === "sharp left") return "keskin sola";
    if (m === "sharp right") return "keskin sağa";
    if (m === "straight") return "düz";
    return m || "düz";
  }

  function instructionFor(step, spoken) {
    var t = step.maneuver.type, m = step.maneuver.modifier || "";
    var name = step.name || "";
    var onto = name ? (spoken ? " " + name + " yönüne" : name) : "";
    if (t === "depart") return spoken ? ("Yola çıkın" + (name ? ", " + name + " üzerinden" : "")) : (name || "YOLA ÇIKIN");
    if (t === "arrive") return spoken ? "Varış noktanıza ulaştınız" : "VARIŞ NOKTASI";
    if (t === "roundabout" || t === "rotary") {
      var exit = step.maneuver.exit || 1;
      return spoken ? ("Döner kavşaktan " + exit + ". çıkıştan çıkın" + onto) : (name || "DÖNER KAVŞAK");
    }
    if (m.indexOf("uturn") >= 0) return spoken ? "U dönüşü yapın" : (name || "U DÖNÜŞÜ");
    if (t === "merge") return spoken ? (translateModifier(m) + " şeride katılın" + onto) : (name || "ŞERİDE KATILIN");
    if (t === "on ramp") return spoken ? ("Bağlantı yoluna girin" + onto) : (name || "BAĞLANTI YOLU");
    if (t === "off ramp") return spoken ? ("Çıkıştan ayrılın" + onto) : (name || "ÇIKIŞ");
    if (t === "fork") return spoken ? ("Yol ayrımından " + translateModifier(m) + " devam edin" + onto) : (name || "YOL AYRIMI");
    if (m === "straight" || (t === "continue" && !m)) return spoken ? ("Düz devam edin" + onto) : (name || "DÜZ DEVAM EDİN");
    var dir = translateModifier(m);
    return spoken ? (dir + " dönün" + onto) : (name || dir.toLocaleUpperCase("tr-TR") + " DÖNÜN");
  }

  // ---------------- Rota noktası / rota kurulumu ----------------
  function setWaypoint(lngLat, label) {
    if (navActive) return;
    waypointLngLat = [lngLat.lng !== undefined ? lngLat.lng : lngLat[0],
                      lngLat.lat !== undefined ? lngLat.lat : lngLat[1]];
    if (!waypointMarker) waypointMarker = makeWaypointMarker();
    waypointMarker.setLngLat(waypointLngLat).addTo(map);
    $("to-input").value = label || "İŞARETLENEN NOKTA";
    saveRecent(label, waypointLngLat);
    hideSheet();
    $("hint").classList.add("hidden");
    speak("Rota noktası belirlendi.");
    requestRoute();
  }

  function resolveOrigin() {
    return customOrigin || playerPos || map.getCenter().toArray();
  }

  function setCustomOrigin(pos, label) {
    customOrigin = pos;
    $("from-input").value = pos ? (label || "İŞARETLENEN BAŞLANGIÇ") : "";
    if (pos) {
      if (!originMarker) {
        var el = document.createElement("div");
        el.className = "origin-marker";
        originMarker = new maplibregl.Marker({ element: el });
      }
      originMarker.setLngLat(pos).addTo(map);
    } else if (originMarker) {
      originMarker.remove();
      originMarker = null;
    }
    if (waypointLngLat) requestRoute();
  }

  function swapEnds() {
    if (!waypointLngLat) { toast("ÖNCE BİR VARIŞ NOKTASI SEÇİN", true); return; }
    if (navActive) return;
    var newDest = resolveOrigin().slice();
    var newDestLabel = customOrigin ? ($("from-input").value || "İŞARETLENEN BAŞLANGIÇ") : "KONUMUM";
    var newOrigin = waypointLngLat.slice();
    var newOriginLabel = $("to-input").value || "İŞARETLENEN NOKTA";
    waypointLngLat = newDest;
    waypointMarker.setLngLat(newDest);
    $("to-input").value = newDestLabel;
    setCustomOrigin(newOrigin, newOriginLabel);
  }

  function requestRoute() {
    var origin = (navActive && !demoActive && playerPos) ? playerPos : resolveOrigin();
    rerouting = true;
    fetchRoute(origin, waypointLngLat, function (err, r) {
      rerouting = false;
      if (err) {
        toast("ROTA SERVİSİNE ULAŞILAMIYOR — BİRAZDAN TEKRAR DENEYİN");
        return;
      }
      route = r;
      progressIdx = 0;
      announcedForStep = {};
      setRouteGeometry(r.coords);
      $("route-time").textContent = fmtDuration(r.totalDur);
      $("route-dist").textContent = fmtDist(r.totalDist);
      $("route-traffic").classList.add("hidden");
      $("route-traffic").classList.remove("clear");
      applyTrafficETA(origin);
      if (!navActive) {
        $("route-panel").classList.remove("hidden");
        $("nav-bar").classList.add("hidden");
        var b = new maplibregl.LngLatBounds();
        r.coords.forEach(function (c) { b.extend(c); });
        map.fitBounds(b, { padding: { top: 140, bottom: 160, left: 50, right: 50 }, pitch: 0, bearing: 0, duration: 700 });
      }
    });
  }

  function clearRoute() {
    route = null;
    waypointLngLat = null;
    if (waypointMarker) { waypointMarker.remove(); waypointMarker = null; }
    customOrigin = null;
    if (originMarker) { originMarker.remove(); originMarker = null; }
    $("from-input").value = "";
    $("to-input").value = "";
    $("dir-results").classList.add("hidden");
    setRouteGeometry([]);
    $("route-panel").classList.add("hidden");
    openSheet(false);
    renderRecents();
  }

  // ---------------- Başlangıç/Varış seçicileri ----------------
  function dirSearch(q, isFrom) {
    var box = $("dir-results");
    box.innerHTML = "";
    if (isFrom) {
      var mine = document.createElement("div");
      mine.className = "search-item";
      mine.innerHTML = '<div class="primary">◉ KONUMUNUZ</div><div class="secondary">GPS konumunu takip et</div>';
      mine.addEventListener("click", function () {
        box.classList.add("hidden");
        setCustomOrigin(null);
      });
      box.appendChild(mine);
    }
    if (q.length >= 3) {
      var center = map.getCenter();
      var url = NOMINATIM_URL + "?format=jsonv2&accept-language=tr&limit=5&q=" + encodeURIComponent(q) +
        "&viewbox=" + (center.lng - 1) + "," + (center.lat + 1) + "," + (center.lng + 1) + "," + (center.lat - 1) + "&bounded=0";
      fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (items) {
          items.forEach(function (it) {
            var parts = (it.display_name || "").split(",");
            var div = document.createElement("div");
            div.className = "search-item";
            div.innerHTML = '<div class="primary">' + escapeHtml(parts[0] || "?") + "</div>" +
              '<div class="secondary">' + escapeHtml(parts.slice(1, 4).join(",").trim()) + "</div>";
            div.addEventListener("click", function () {
              box.classList.add("hidden");
              var lngLat = [parseFloat(it.lon), parseFloat(it.lat)];
              if (isFrom) {
                setCustomOrigin(lngLat, parts[0]);
              } else {
                map.easeTo({ center: lngLat, zoom: 14, duration: 700 });
                setWaypoint(lngLat, parts[0]);
              }
            });
            box.appendChild(div);
          });
          if (box.children.length) box.classList.remove("hidden");
        })
        .catch(function () {});
    }
    box.classList.toggle("hidden", !box.children.length);
  }

  function attachDirSearch(inputId, isFrom) {
    var input = $(inputId), timer = null;
    input.addEventListener("focus", function () {
      input.select();
      if (isFrom) dirSearch(input.value.trim(), true);
    });
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () { dirSearch(input.value.trim(), isFrom); }, 450);
    });
  }

  // ---------------- Navigasyon ----------------
  function startNav(demo) {
    if (!route) return;
    if (!demo && !hasGpsFix) {
      toast("GPS SİNYALİ YOK — DEMO SÜRÜŞ BAŞLATILIYOR", true);
      demo = true;
    }
    navActive = true;
    arrived = false;
    demoActive = !!demo;
    following = true;
    document.body.classList.add("nav-on");
    $("speed-bubble").classList.add("hidden");
    $("route-panel").classList.add("hidden");
    $("nav-bar").classList.remove("hidden");
    $("turn-banner").classList.remove("hidden");
    acquireWakeLock();
    speak("Rota başlatıldı.");
    fetchCameras(demoActive ? route.coords[0] : (playerPos || route.coords[0]));
    fetchPolice(demoActive ? route.coords[0] : (playerPos || route.coords[0]));
    if (demoActive) {
      demoTraveled = 0;
      demoLastTs = null;
      if (!playerMarker) { playerMarker = makePlayerMarker(); playerMarker.setLngLat(route.coords[0]).addTo(map); }
      demoRaf = requestAnimationFrame(demoTick);
    } else if (playerPos) {
      updateNavigation(playerPos, playerHeading, playerSpeedMps);
    }
  }

  function stopNav(silent) {
    navActive = false;
    demoActive = false;
    document.body.classList.remove("nav-on");
    if (demoRaf) { cancelAnimationFrame(demoRaf); demoRaf = null; }
    $("nav-bar").classList.add("hidden");
    $("turn-banner").classList.add("hidden");
    releaseWakeLock();
    if (!silent) speak("Rota sonlandırıldı.");
    if (route) {
      $("route-panel").classList.remove("hidden");
      map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    }
  }

  function demoTick(ts) {
    if (!demoActive || !route) return;
    if (demoLastTs === null) demoLastTs = ts;
    var dt = Math.min((ts - demoLastTs) / 1000, 0.2);
    demoLastTs = ts;
    demoTraveled += DEMO_SPEED_MPS * dt;
    var total = route.cum[route.cum.length - 1];
    if (demoTraveled >= total) demoTraveled = total;

    var cum = route.cum, coords = route.coords;
    var i = progressIdx;
    while (i < cum.length - 2 && cum[i + 1] < demoTraveled) i++;
    progressIdx = i;
    var segLen = cum[i + 1] - cum[i];
    var t = segLen > 0 ? (demoTraveled - cum[i]) / segLen : 0;
    var pos = [
      coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
      coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t
    ];
    var heading = bearingDeg(coords[i], coords[i + 1]);
    updateNavigation(pos, heading, DEMO_SPEED_MPS, demoTraveled);
    checkAlerts(pos, heading);
    maybeStreetName(pos);
    maybeSpeedLimit(pos, heading);
    if (demoTraveled < total) demoRaf = requestAnimationFrame(demoTick);
  }

  function updateNavigation(pos, heading, speedMps, traveledOverride) {
    if (!route || !navActive || arrived) return;

    if (playerMarker) {
      playerMarker.setLngLat(pos);
      playerMarker.setRotation(heading);
    }

    var traveled, offDist = 0;
    if (traveledOverride !== undefined) {
      traveled = traveledOverride;
    } else {
      var best = { dist: Infinity, idx: 0, t: 0 };
      var from = Math.max(0, progressIdx - 3);
      var to = Math.min(route.coords.length - 2, progressIdx + 60);
      for (var i = from; i <= to; i++) {
        var pr = projectToSegment(pos, route.coords[i], route.coords[i + 1]);
        if (pr.dist < best.dist) best = { dist: pr.dist, idx: i, t: pr.t };
      }
      progressIdx = best.idx;
      offDist = best.dist;
      var segLen = route.cum[best.idx + 1] - route.cum[best.idx];
      traveled = route.cum[best.idx] + segLen * best.t;
    }

    var total = route.cum[route.cum.length - 1];
    var remaining = Math.max(0, total - traveled);

    // --- rotadan çıkma kontrolü ---
    if (traveledOverride === undefined) {
      if (offDist > OFF_ROUTE_METERS) {
        if (!offRouteSince) offRouteSince = Date.now();
        else if (Date.now() - offRouteSince > OFF_ROUTE_SECONDS * 1000 && !rerouting) {
          offRouteSince = null;
          toast("ROTA YENİDEN HESAPLANIYOR…", true);
          speak("Rota yeniden hesaplanıyor.");
          requestRoute();
          return;
        }
      } else {
        offRouteSince = null;
      }
    }

    // --- yaklaşan manevra ---
    var upcoming = null, upcomingIdx = -1;
    for (var s = 0; s < route.steps.length; s++) {
      if (route.steps[s]._distAlong > traveled + 4) { upcoming = route.steps[s]; upcomingIdx = s; break; }
    }
    if (!upcoming) { upcoming = route.steps[route.steps.length - 1]; upcomingIdx = route.steps.length - 1; }
    var distToTurn = Math.max(0, upcoming._distAlong - traveled);

    $("turn-arrow").textContent = arrowFor(upcoming);
    $("turn-dist").textContent = fmtDist(distToTurn);
    $("turn-street").textContent = instructionFor(upcoming, false);

    // --- sesli uyarılar ---
    var tier = announcedForStep[upcomingIdx] || 0;
    if (upcoming.maneuver.type !== "depart") {
      if (distToTurn < 40 && tier < 3) {
        announcedForStep[upcomingIdx] = 3;
        speak(instructionFor(upcoming, true));
      } else if (distToTurn < 210 && tier < 2) {
        announcedForStep[upcomingIdx] = 2;
        speak(fmtDistSpoken(distToTurn) + " sonra, " + instructionFor(upcoming, true).toLocaleLowerCase("tr-TR"));
      } else if (distToTurn < 900 && distToTurn > 300 && tier < 1) {
        announcedForStep[upcomingIdx] = 1;
        speak(fmtDistSpoken(distToTurn) + " sonra, " + instructionFor(upcoming, true).toLocaleLowerCase("tr-TR"));
      }
    }

    // --- alt bilgi çubuğu ---
    var remainingDur = route.totalDur * (remaining / Math.max(1, route.totalDist));
    $("nav-eta").textContent = fmtEta(remainingDur);
    $("nav-remaining").textContent = fmtDist(remaining);
    $("nav-speed").textContent = Math.round((speedMps || 0) * 3.6);

    // --- kamera takibi ---
    if (following) {
      map.easeTo({
        center: pos,
        bearing: heading,
        pitch: 55,
        zoom: 16.5,
        duration: traveledOverride !== undefined ? 90 : 900,
        easing: function (x) { return x; }
      });
    }

    // --- varış ---
    if (remaining < ARRIVE_METERS) {
      arrived = true;
      $("arrive").classList.remove("hidden");
      speak("Varış noktanıza ulaştınız.");
      setTimeout(function () {
        $("arrive").classList.add("hidden");
        stopNav(true);
        clearRoute();
      }, 3800);
    }
  }

  // ---------------- GPS ----------------
  function startGps() {
    if (!navigator.geolocation) {
      toast("BU CİHAZDA GPS YOK — HARİTAYA DOKUNARAK DEMO SÜRÜŞ KULLANABİLİRSİNİZ", true);
      return;
    }
    navigator.geolocation.watchPosition(function (p) {
      var pos = [p.coords.longitude, p.coords.latitude];
      var firstFix = !hasGpsFix;
      hasGpsFix = true;
      playerSpeedMps = p.coords.speed || 0;
      if (p.coords.heading !== null && !isNaN(p.coords.heading) && playerSpeedMps > 0.8) {
        playerHeading = p.coords.heading;
      } else if (lastGpsPos && haversine(lastGpsPos, pos) > 3) {
        playerHeading = bearingDeg(lastGpsPos, pos);
      }
      lastGpsPos = playerPos;
      playerPos = pos;

      if (!playerMarker) {
        playerMarker = makePlayerMarker();
        playerMarker.setLngLat(pos).addTo(map);
      }
      if (!navActive || !demoActive) {
        playerMarker.setLngLat(pos);
        playerMarker.setRotation(playerHeading);
      }
      if (firstFix) {
        map.easeTo({ center: pos, zoom: 15, duration: 800 });
        toast("GPS BAĞLANDI", true);
      }
      if (navActive && !demoActive) {
        updateNavigation(pos, playerHeading, playerSpeedMps);
      }
      if (!demoActive) {
        checkAlerts(pos, playerHeading);
        updateFreeDriveHud(pos, playerSpeedMps);
      }
    }, function () {
      if (!hasGpsFix) toast("GPS ALINAMIYOR — HARİTAYA DOKUNARAK DEMO SÜRÜŞ KULLANABİLİRSİNİZ", true);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  }

  // ---------------- Ekran uyanık tutma ----------------
  function acquireWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request("screen").then(function (wl) { wakeLock = wl; }).catch(function () {});
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && navActive) acquireWakeLock();
  });

  // ---------------- Alt çekmece: arama, son aramalar, kayıtlı yerler ----------------
  var searchTimer = null;
  var chipAssign = null; // 'home' | 'work'

  function loadJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }

  function getRecents() { return loadJson("lsmaps-recents", []); }

  function saveRecent(label, lngLat) {
    if (!label || label === "İŞARETLENEN NOKTA" || label === "KONUMUM" || label === "İŞARETLENEN BAŞLANGIÇ") return;
    var rec = getRecents().filter(function (r) { return r.label !== label; });
    rec.unshift({ label: label, lng: lngLat[0], lat: lngLat[1] });
    try { localStorage.setItem("lsmaps-recents", JSON.stringify(rec.slice(0, 6))); } catch (e) {}
  }

  function getPlaces() { return loadJson("lsmaps-places", {}); }

  function savePlace(slot, label, lngLat) {
    var p = getPlaces();
    p[slot] = { label: label, lng: lngLat[0], lat: lngLat[1] };
    try { localStorage.setItem("lsmaps-places", JSON.stringify(p)); } catch (e) {}
    refreshChips();
  }

  function refreshChips() {
    var p = getPlaces();
    $("chip-home").innerHTML = "&#127968; " + (p.home ? "EV" : "EVİ AYARLA");
    $("chip-work").innerHTML = "&#128188; " + (p.work ? "İŞ" : "İŞİ AYARLA");
  }

  function openSheet(expand) {
    $("sheet").classList.remove("hidden");
    if (expand) $("sheet").classList.add("open");
  }
  function collapseSheet() {
    $("sheet").classList.remove("open");
    $("search").blur();
  }
  function hideSheet() {
    collapseSheet();
    $("sheet").classList.add("hidden");
  }

  function sheetRow(icon, primary, secondary, onClick) {
    var div = document.createElement("div");
    div.className = "search-item";
    div.innerHTML = '<div class="primary">' + icon + " " + escapeHtml(primary) + "</div>" +
      (secondary ? '<div class="secondary">' + escapeHtml(secondary) + "</div>" : "");
    div.addEventListener("click", onClick);
    return div;
  }

  function renderRecents() {
    var box = $("search-results");
    box.innerHTML = "";
    var head = $("results-head");
    if (head) head.classList.add("hidden");
    var rec = getRecents();
    $("recents-label").classList.toggle("hidden", !rec.length);
    rec.forEach(function (r) {
      box.appendChild(sheetRow("&#128337;", r.label, null, function () {
        pickDestination([r.lng, r.lat], r.label);
      }));
    });
  }

  function pickDestination(lngLat, label) {
    if (chipAssign) {
      savePlace(chipAssign, label, lngLat);
      toast((chipAssign === "home" ? "EV" : "İŞ") + " KAYDEDİLDİ — GİTMEK İÇİN DOKUNUN", true);
      chipAssign = null;
      $("search").value = "";
      $("search").placeholder = "NEREYE?";
      renderRecents();
      return;
    }
    $("search").value = "";
    map.easeTo({ center: lngLat, zoom: 14, duration: 700 });
    setWaypoint(lngLat, label);
  }

  function chipTap(slot) {
    var p = getPlaces()[slot];
    if (p && !chipAssign) { pickDestination([p.lng, p.lat], p.label); return; }
    chipAssign = slot;
    var slotName = slot === "home" ? "EV" : "İŞ";
    $("search").placeholder = slotName + " ADRESİ İÇİN YER ARAYIN";
    openSheet(true);
    $("search").focus();
  }

  function chipReassign(slot) {
    chipAssign = slot;
    var slotName = slot === "home" ? "EV" : "İŞ";
    $("search").placeholder = "YENİ " + slotName + " ADRESİ ARAYIN";
    openSheet(true);
    $("search").focus();
    toast("ARAMADAN YENİ " + slotName + " KONUMUNU SEÇİN", true);
  }

  function onSearchInput() {
    var q = $("search").value.trim();
    clearTimeout(searchTimer);
    if (q.length) openSheet(true);
    if (q.length) $("results-head").classList.add("hidden");
    if (q.length < 3) { renderRecents(); return; }
    searchTimer = setTimeout(function () {
      var center = map.getCenter();
      var url = NOMINATIM_URL + "?format=jsonv2&accept-language=tr&limit=5&q=" + encodeURIComponent(q) +
        "&viewbox=" + (center.lng - 1) + "," + (center.lat + 1) + "," + (center.lng + 1) + "," + (center.lat - 1) + "&bounded=0";
      fetch(url, { headers: { "Accept": "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (items) {
          var box = $("search-results");
          box.innerHTML = "";
          $("recents-label").classList.add("hidden");
          items.forEach(function (it) {
            var parts = (it.display_name || "").split(",");
            box.appendChild(sheetRow("&#128205;", parts[0] || it.name || "?", parts.slice(1, 4).join(",").trim(), function () {
              pickDestination([parseFloat(it.lon), parseFloat(it.lat)], parts[0]);
            }));
          });
        })
        .catch(function () { toast("ARAMA ŞU AN KULLANILAMIYOR"); });
    }, 450);
  }

  // ---------------- Serbest sürüş HUD: hız balonu + sokak adı + hız sınırı ----------------
  var streetFetchAt = 0, streetFetchPos = null;
  var limitFetchAt = 0, limitFetchPos = null, currentLimitKmh = null;

  // OSM maxspeed etiketi -> km/s
  function parseMaxspeedKmh(v) {
    if (!v) return null;
    v = String(v).toLowerCase().trim();
    if (v.indexOf("national") >= 0 || v.indexOf("walk") >= 0 || v.indexOf("none") >= 0 || v.indexOf("signal") >= 0) return null;
    var mph = v.match(/(\d+)\s*mph/);
    if (mph) return Math.round(+mph[1] * 1.60934);
    var kmh = v.match(/(\d+)\s*km\/?h/);
    if (kmh) return +kmh[1];
    var bare = v.match(/^(\d+)$/);
    if (bare) return +bare[1];
    return null;
  }

  function inferLimitKmh(tags) {
    var explicit = parseMaxspeedKmh(tags.maxspeed);
    if (explicit) return explicit;
    var type = ((tags["maxspeed:type"] || tags["source:maxspeed"]) || "").toLowerCase();
    if (type) {
      if (type.indexOf("motorway") >= 0) return 130;
      if (type.indexOf("nsl_dual") >= 0 || type.indexOf("trunk") >= 0) return 110;
      if (type.indexOf("nsl_single") >= 0 || type.indexOf("rural") >= 0) return 90;
      if (type.indexOf("nsl_restricted") >= 0 || type.indexOf("urban") >= 0) return 50;
      var z = type.match(/zone:?(\d+)/);
      if (z) return +z[1];
    }
    if (tags.highway === "living_street") return 20;
    return null;
  }

  function nearestWayInfo(pos, geom) {
    var best = { dist: Infinity, bearing: null };
    for (var i = 0; i < geom.length - 1; i++) {
      var a = [geom[i].lon, geom[i].lat], b = [geom[i + 1].lon, geom[i + 1].lat];
      var pr = projectToSegment(pos, a, b);
      if (pr.dist < best.dist) { best.dist = pr.dist; best.bearing = bearingDeg(a, b); }
    }
    if (geom.length === 1) best.dist = haversine(pos, [geom[0].lon, geom[0].lat]);
    return best;
  }

  function setLimitSign(kmh) {
    currentLimitKmh = kmh;
    var sign = $("limit-sign");
    if (kmh) { $("limit-val").textContent = kmh; sign.classList.remove("hidden"); }
    else { sign.classList.add("hidden"); }
  }

  function maybeSpeedLimit(pos, heading) {
    var now = Date.now();
    if (now - limitFetchAt < 6000) return;
    if (limitFetchPos && haversine(pos, limitFetchPos) < 30) return;
    limitFetchAt = now;
    limitFetchPos = pos.slice();
    var q = "[out:json][timeout:10];way(around:40," + pos[1] + "," + pos[0] +
      ')[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];out tags geom 30;';
    fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var best = null, bestScore = Infinity;
        (data.elements || []).forEach(function (w) {
          if (!w.geometry || !w.tags) return;
          var kmh = inferLimitKmh(w.tags);
          if (!kmh) return;
          var info = nearestWayInfo(pos, w.geometry);
          if (info.dist > 42) return;
          var score = info.dist;
          if (typeof heading === "number" && info.bearing != null) {
            var d = Math.abs(((info.bearing - heading) % 360 + 360) % 360);
            if (d > 180) d = 360 - d;
            if (d > 90) d = 180 - d;
            score += (d / 90) * 18;
          }
          if (score < bestScore) { bestScore = score; best = kmh; }
        });
        setLimitSign(best);
      })
      .catch(function () {});
  }

  function maybeStreetName(pos) {
    var now = Date.now();
    if (now - streetFetchAt < 30000) return;
    if (streetFetchPos && haversine(pos, streetFetchPos) < 80) return;
    streetFetchAt = now;
    streetFetchPos = pos.slice();
    fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=tr&zoom=17&lat=" + pos[1] + "&lon=" + pos[0],
      { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var road = d.address && (d.address.road || d.address.pedestrian || d.address.neighbourhood);
        if (road) {
          $("street-pill").textContent = road.toLocaleUpperCase("tr-TR");
          $("street-pill").classList.remove("hidden");
        }
      })
      .catch(function () {});
  }

  function updateFreeDriveHud(pos, speedMps) {
    var kmh = Math.round((speedMps || 0) * 3.6);
    if (!navActive) {
      $("speed-val").textContent = kmh;
      $("speed-bubble").classList.remove("hidden");
    }
    // hız sınırı aşımı uyarısı (8 km/s tolerans)
    var over = currentLimitKmh && kmh > currentLimitKmh + 8;
    $("speed-val").classList.toggle("over", !!over);
    maybeStreetName(pos);
    maybeSpeedLimit(pos, playerHeading);
  }

  // ---------------- Yakındaki kategoriler ----------------
  var CATEGORIES = [
    { key: "fuel",       label: "Akaryakıt",       glyph: "⛽", sel: ['node["amenity"="fuel"]', 'way["amenity"="fuel"]'], radius: 6000, fuel: true },
    { key: "food",       label: "Yemek",           glyph: "🍴", sel: ['node["amenity"~"restaurant|fast_food"]', 'way["amenity"~"restaurant|fast_food"]'], radius: 4000 },
    { key: "parking",    label: "Otopark",         glyph: "🅿️", sel: ['node["amenity"="parking"]["access"!="private"]', 'way["amenity"="parking"]["access"!="private"]'], radius: 3000 },
    { key: "groceries",  label: "Market",          glyph: "🛒", sel: ['node["shop"~"supermarket|convenience"]', 'way["shop"~"supermarket|convenience"]'], radius: 4000 },
    { key: "coffee",     label: "Kafe",            glyph: "☕", sel: ['node["amenity"="cafe"]', 'way["amenity"="cafe"]'], radius: 4000 },
    { key: "shopping",   label: "Alışveriş",       glyph: "🛍️", sel: ['node["shop"~"mall|department_store"]', 'way["shop"~"mall|department_store"]'], radius: 7000 },
    { key: "pharmacies", label: "Eczane",          glyph: "💊", sel: ['node["amenity"="pharmacy"]', 'way["amenity"="pharmacy"]'], radius: 5000 },
    { key: "ev",         label: "Şarj İstasyonu",  glyph: "🔌", sel: ['node["amenity"="charging_station"]', 'way["amenity"="charging_station"]'], radius: 7000 },
    { key: "hospitals",  label: "Hastane",         glyph: "🏥", sel: ['node["amenity"="hospital"]', 'way["amenity"="hospital"]'], radius: 12000 },
    { key: "hotels",     label: "Otel",            glyph: "🏨", sel: ['node["tourism"="hotel"]', 'way["tourism"="hotel"]'], radius: 8000 },
    { key: "parks",      label: "Park",            glyph: "🌳", sel: ['node["leisure"="park"]', 'way["leisure"="park"]'], radius: 5000 },
    { key: "crisis",     label: "Acil Durum",      glyph: "🆘", sel: ['node["amenity"~"police|hospital|fire_station"]', 'way["amenity"~"police|hospital|fire_station"]'], radius: 14000 }
  ];
  function catByKey(k) { for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].key === k) return CATEGORIES[i]; return null; }

  var DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  function expandDays(sel) {
    var out = [];
    sel.split(",").forEach(function (part) {
      part = part.trim();
      var range = part.split("-");
      if (range.length === 2) {
        var a = DOW.indexOf(range[0]), b = DOW.indexOf(range[1]);
        if (a >= 0 && b >= 0) for (var i = a; i !== (b + 1) % 7; i = (i + 1) % 7) out.push(i);
      } else {
        var d = DOW.indexOf(part); if (d >= 0) out.push(d);
      }
    });
    return out;
  }

  function parseOpenState(oh) {
    if (!oh) return "unknown";
    oh = oh.trim();
    if (/24\s*\/\s*7/.test(oh) || /00:00-24:00/.test(oh) && !/;/.test(oh) && !/Mo|Tu|We|Th|Fr|Sa|Su/.test(oh)) return "open";
    var now = new Date();
    var today = now.getDay() === 0 ? 6 : now.getDay() - 1;
    var mins = now.getHours() * 60 + now.getMinutes();
    var rules = oh.split(";");
    var parseable = false, openNow = false;
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r].trim();
      if (!rule || /PH|SH|easter|week|sunset|sunrise/i.test(rule)) continue;
      var mDays = rule.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*[-,]\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))*)/);
      var days = null, rest = rule;
      if (mDays) { days = expandDays(mDays[1]); rest = rule.slice(mDays[1].length).trim(); }
      if (days && days.indexOf(today) < 0) continue;
      if (/off|closed/i.test(rest)) { parseable = true; continue; }
      var times = rest.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/g);
      if (!times) continue;
      parseable = true;
      for (var t = 0; t < times.length; t++) {
        var mm = times[t].match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
        var start = +mm[1] * 60 + +mm[2], end = +mm[3] * 60 + +mm[4];
        if (end === 0) end = 1440;
        var inRange = end > start ? (mins >= start && mins < end) : (mins >= start || mins < end);
        if (inRange) openNow = true;
      }
    }
    if (openNow) return "open";
    return parseable ? "closed" : "unknown";
  }

  var catFetchToken = 0;
  var fuelPrices = null, fuelPricesTried = false;

  function loadFuelPrices() {
    if (fuelPricesTried) return Promise.resolve(fuelPrices);
    fuelPricesTried = true;
    return fetch("data/fuel_prices.json")
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { fuelPrices = j.stations || []; return fuelPrices; })
      .catch(function () { fuelPrices = null; return null; });
  }

  function matchFuelPrice(pos) {
    if (!fuelPrices) return null;
    var best = null, bestD = 250;
    for (var i = 0; i < fuelPrices.length; i++) {
      var s = fuelPrices[i];
      if (typeof s.lat !== "number" || typeof s.lng !== "number") continue;
      var d = haversine(pos, [s.lng, s.lat]);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best || !best.e10) return null;
    return "£" + (best.e10 / 100).toFixed(2);
  }

  function goToPlace(pos, name) {
    chipAssign = null;
    closeCatScreen();
    $("search").value = "";
    map.easeTo({ center: pos, zoom: 14, duration: 700 });
    setWaypoint(pos, name);
  }

  function placeRow(p) {
    var div = document.createElement("div");
    div.className = "search-item place-item";
    var badge = p.status === "open" ? '<span class="st-open">AÇIK</span>'
      : p.status === "closed" ? '<span class="st-closed">KAPALI</span>' : "";
    var price = p.price ? '<span class="st-price">' + escapeHtml(p.price) + "</span>" : "";
    div.innerHTML =
      '<div class="place-main"><div class="primary">' + p.glyph + " " + escapeHtml(p.name) + "</div>" +
      '<div class="secondary">' + fmtDist(p.dist) + "</div></div>" +
      '<div class="place-meta">' + price + badge + "</div>";
    div.addEventListener("click", function () { goToPlace(p.pos, p.name); });
    return div;
  }

  function showResultsHeader(cat) {
    $("recents-label").classList.add("hidden");
    var head = $("results-head");
    head.classList.remove("hidden");
    $("results-title").textContent = cat.glyph + " YAKINDAKİ " + cat.label.toLocaleUpperCase("tr-TR");
  }

  function runCategory(catKey) {
    var cat = catByKey(catKey);
    if (!cat) return;
    closeCatScreen();
    openSheet(true);
    showResultsHeader(cat);
    var box = $("search-results");
    box.innerHTML = '<div class="place-loading">Yakındaki ' + cat.label.toLocaleLowerCase("tr-TR") + " noktaları aranıyor…</div>";
    var center = playerPos || map.getCenter().toArray();
    var token = ++catFetchToken;
    var around = cat.sel.map(function (s) { return s + "(around:" + cat.radius + "," + center[1] + "," + center[0] + ");"; }).join("");
    var q = "[out:json][timeout:20];(" + around + ");out center 40;";
    var pricesReady = cat.fuel ? loadFuelPrices() : Promise.resolve(null);
    fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) { return pricesReady.then(function () { return data; }); })
      .then(function (data) {
        if (token !== catFetchToken) return;
        var places = [];
        (data.elements || []).forEach(function (el) {
          var t = el.tags || {};
          var pos = el.type === "node" ? [el.lon, el.lat] : (el.center ? [el.center.lon, el.center.lat] : null);
          if (!pos) return;
          var name = t.name || t.brand || t.operator || cat.label;
          places.push({
            name: name, pos: pos, glyph: cat.glyph,
            dist: haversine(center, pos),
            status: parseOpenState(t.opening_hours),
            price: cat.fuel ? matchFuelPrice(pos) : null
          });
        });
        var seen = {}, uniq = [];
        places.sort(function (a, b) { return a.dist - b.dist; });
        places.forEach(function (p) {
          var k = p.name + "@" + Math.round(p.pos[0] * 1e4) + "," + Math.round(p.pos[1] * 1e4);
          if (seen[k]) return; seen[k] = 1; uniq.push(p);
        });
        uniq = uniq.slice(0, 20);
        box.innerHTML = "";
        if (!uniq.length) { box.innerHTML = '<div class="place-loading">Yakında sonuç bulunamadı.</div>'; return; }
        uniq.forEach(function (p) { box.appendChild(placeRow(p)); });
      })
      .catch(function () {
        if (token !== catFetchToken) return;
        box.innerHTML = '<div class="place-loading">Yerler yüklenemedi — tekrar deneyin.</div>';
      });
  }

  function exitCategoryResults() {
    $("results-head").classList.add("hidden");
    renderRecents();
  }

  function buildCatScreen() {
    var list = $("cat-screen-list");
    list.innerHTML = "";
    CATEGORIES.forEach(function (cat) {
      var row = document.createElement("div");
      row.className = "cat-row";
      row.innerHTML = '<span class="cat-row-glyph">' + cat.glyph + "</span>" +
        '<span class="cat-row-label">' + cat.label + "</span>" +
        '<span class="cat-row-arrow">›</span>';
      row.addEventListener("click", function () { runCategory(cat.key); });
      list.appendChild(row);
    });
  }
  function openCatScreen() {
    if (!$("cat-screen-list").children.length) buildCatScreen();
    $("cat-screen").classList.remove("hidden");
  }
  function closeCatScreen() { $("cat-screen").classList.add("hidden"); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------------- Mobil cihaz kontrolü ----------------
  function isStandalone() {
    return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) ||
           window.navigator.standalone === true;
  }

  function isMobileDevice() {
    var touch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
    var coarse = window.matchMedia && matchMedia("(pointer: coarse)").matches;
    return touch && coarse;
  }

  function setupDesktopBar() {
  }

  function showMapError() {
    $("hint").classList.add("hidden");
    var div = document.createElement("div");
    div.className = "map-error";
    div.innerHTML =
      '<div class="map-error-card">' +
      '<div class="gate-title">HARİTA BURADA AÇILAMIYOR</div>' +
      '<div class="map-error-text">Bu tarayıcıda donanım hızlandırma (WebGL) kapalı olduğu için ' +
      "harita motoru başlatılamıyor. Tarayıcı ayarlarından donanım hızlandırmayı açın " +
      "veya uygulamayı telefonunuzda kullanın.</div>" +
      '<button id="map-error-send" class="btn-send">TELEFONA GÖNDER</button>' +
      "</div>";
    document.body.appendChild(div);
    var sendBtn = $("btn-send");
    $("map-error-send").addEventListener("click", function () {
      if (sendBtn) sendBtn.click();
    });
  }

  // ---------------- Başlatma ----------------
  function init() {

    if ("serviceWorker" in navigator &&
        (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
    try {
      map = new maplibregl.Map({
        container: "map",
        style: window.GTA_STYLE,
        center: DEFAULT_CENTER,
        zoom: 12.5,
        attributionControl: false
      });
    } catch (e) {
      showMapError();
      return;
    }
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: "&copy; OpenStreetMap katkıda bulunanları &middot; OpenFreeMap &middot; OSRM"
    }), "bottom-left");

    window.__lsmap = map;
    window.__lsdebug = {
      injectCamera: function (lng, lat) {
        cameras.push({ id: "dbg-cam" + Date.now(), pos: [lng, lat] });
        if (map.getSource("cameras")) map.getSource("cameras").setData(pointsFC(cameras));
      },
      injectPolice: function (lng, lat) {
        police.push({ id: "dbg-pol" + Date.now(), pos: [lng, lat] });
        if (map.getSource("police")) map.getSource("police").setData(pointsFC(police));
      },
      injectIncident: function (lng, lat, title, glyph) {
        incidents.push({ id: "dbg-inc" + Date.now(), pos: [lng, lat], kind: "incident",
          title: title || "İLERİDE KAZA VAR", glyph: glyph || "💥" });
        if (map.getSource("incidents")) map.getSource("incidents").setData(pointsFC(incidents));
      },
      trafficState: function () { return { trafficOn: trafficOn, incidents: incidents.length }; }
    };

    map.on("load", function () {
      addRouteLayers();
      addRoadShields();
      addAlertLayers();
      addTrafficLayers();
      startGps();
      fetchIncidents(map.getCenter().toArray());
      var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
      if (isIos && !isStandalone() && !localStorage.getItem("lsmaps-install-hint")) {
        localStorage.setItem("lsmaps-install-hint", "1");
        setTimeout(function () { toast("YÜKLE: PAYLAŞ → ANA EKRANA EKLE", true); }, 2500);
      }
    });

    map.on("click", function (e) {
      if ($("sheet").classList.contains("open")) {
        collapseSheet();
        renderRecents();
        return;
      }
      setWaypoint(e.lngLat);
    });

    map.on("dragstart", function () { if (navActive) following = false; });

    $("btn-go").addEventListener("click", function () { startNav(false); });
    $("btn-demo").addEventListener("click", function () { startNav(true); });
    $("btn-cancel").addEventListener("click", function () { clearRoute(); });
    $("btn-end").addEventListener("click", function () { stopNav(); });
    $("btn-recenter").addEventListener("click", function () {
      following = true;
      var target = navActive && demoActive ? null : playerPos;
      if (navActive) return;
      if (target) map.easeTo({ center: target, zoom: 15, duration: 600 });
      else toast("HENÜZ GPS KONUMU ALINAMADI", true);
    });
    $("btn-north").addEventListener("click", function () {
      following = false;
      map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
    });
    $("btn-traffic").addEventListener("click", function () {
      setTraffic(!trafficOn);
      toast(trafficOn ? "CANLI TRAFİK AÇIK" : "CANLI TRAFİK KAPALI", true);
    });
    $("btn-voice").addEventListener("click", function () {
      voiceOn = !voiceOn;
      this.classList.toggle("off", !voiceOn);
      toast(voiceOn ? "SESLİ YÖNLENDİRME AÇIK" : "SESLİ YÖNLENDİRME KAPALI", true);
      if (!voiceOn && window.speechSynthesis) window.speechSynthesis.cancel();
    });
    $("search").addEventListener("input", onSearchInput);
    $("search").addEventListener("focus", function () { openSheet(true); });
    $("search").addEventListener("pointerdown", function () { openSheet(true); });
    $("sheet-handle").addEventListener("click", function () {
      $("sheet").classList.toggle("open");
    });
    ["home", "work"].forEach(function (slot) {
      var chip = $("chip-" + slot);
      chip.addEventListener("click", function () { chipTap(slot); });
      chip.addEventListener("contextmenu", function (e) { e.preventDefault(); chipReassign(slot); });
    });
    refreshChips();
    renderRecents();

    var presets = document.querySelectorAll("#cat-presets .cat-chip[data-cat]");
    Array.prototype.forEach.call(presets, function (btn) {
      btn.addEventListener("click", function () { runCategory(btn.getAttribute("data-cat")); });
    });
    $("cat-more-btn").addEventListener("click", openCatScreen);
    $("cat-screen-back").addEventListener("click", closeCatScreen);
    $("cat-screen-close").addEventListener("click", closeCatScreen);
    $("results-back").addEventListener("click", exitCategoryResults);

    attachDirSearch("from-input", true);
    attachDirSearch("to-input", false);
    $("btn-swap").addEventListener("click", swapEnds);

    $("btn-report").addEventListener("click", function () {
      $("report-sheet").classList.toggle("hidden");
    });
    $("report-police").addEventListener("click", function () {
      $("report-sheet").classList.add("hidden");
      submitPoliceReport();
    });
    $("report-cancel").addEventListener("click", function () {
      $("report-sheet").classList.add("hidden");
    });

    document.addEventListener("pointerdown", unlockAudio, { once: true });
  }

  init();
})();
