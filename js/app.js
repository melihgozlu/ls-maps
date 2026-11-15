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
    if (!el) return;
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
      layout: { "line-cap": "round
