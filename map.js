// =========================
// CONFIG
// =========================

const ICON_BASE = "https://lacmta.github.io/metro-iconography/";

// Only routes listed here are drawn — anything else (missing/unknown route_code) is skipped.
const ROUTES = {
  801: { name: "A Line", letter: "A", color: "#0072BC", icon: ICON_BASE + "Service_ALine.svg" },
  802: { name: "B Line", letter: "B", color: "#EB131B", icon: ICON_BASE + "Service_BLine.svg" },
  803: { name: "C Line", letter: "C", color: "#58A738", icon: ICON_BASE + "Service_CLine.svg" },
  804: { name: "E Line", letter: "E", color: "#FDB913", icon: ICON_BASE + "Service_ELine2.svg" },
  805: { name: "D Line", letter: "D", color: "#A05DA5", icon: ICON_BASE + "Service_DLine.svg" },
  807: { name: "K Line", letter: "K", color: "#E56DB1", icon: ICON_BASE + "Service_KLine.svg" }
};

const POSITIONS_URL = "wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions";
const TRIP_UPDATES_URL = "wss://api.metro.net/ws/LACMTA_Rail/trip_updates";
const STALE_SECONDS = 120; // ignore positions older than this
const REMOVE_AFTER_MS = 3 * 60000; // drop trains / trip updates not heard from in this long
const ANIMATION_MS = 1000; // marker glide duration
const RECONNECT_MS = 5000;
const PING_MS = 30000;

const vehicles = {}; // vehicle id -> { marker, el, popup, routeCode, timestamp, lastSeen, data, anim }
const tripUpdates = {}; // vehicle id -> { tripId, routeId, directionId, startTime, relationship, stops, lastSeen }
let selectedId = null;

// =========================
// MAP
// =========================

function initMap() {
  const map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [-118.25, 34.05],
    zoom: 10,
    minZoom: 8
  });

  map.addControl(new maplibregl.NavigationControl(), "bottom-right");
  map.on("zoom", resizeMarkers);

  return map;
}

function markerSize() {
  return map.getZoom() >= 14 ? 28 : 18;
}

function resizeMarkers() {
  const size = markerSize();
  for (const id in vehicles) {
    vehicles[id].el.style.width = `${size}px`;
    vehicles[id].el.style.height = `${size}px`;
  }
}

// =========================
// MARKERS
// =========================

function styleMarker(el, route) {
  const size = markerSize();
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.borderRadius = "50%";
  el.style.background = `#fff url(${route.icon}) no-repeat center/cover`;
  el.style.boxShadow = `0 0 0 2px #fff, 0 1px 4px rgba(0,0,0,0.35)`;
  el.style.cursor = "pointer";
}

function createVehicle(id, route, data, lngLat, ts) {
  const el = document.createElement("div");
  el.className = "marker";
  el.dataset.vehicleId = id;
  el.dataset.route = data.route_code;
  styleMarker(el, route);

  const popup = new maplibregl.Popup({ offset: 14, className: "vehicle-popup", maxWidth: "none" });

  // Popup content is built when it opens, so it always shows the latest
  // position + trip update data.
  popup.on("open", () => {
    const vehicle = vehicles[id];
    if (!vehicle) return;

    const r = ROUTES[vehicle.routeCode];
    const v = vehicle.data.vehicle;
    const speed = v.position?.speed != null ? `${Math.round(v.position.speed * 2.23694)} mph` : "—";
    const time = v.timestamp ? new Date(parseInt(v.timestamp, 10) * 1000).toLocaleTimeString() : "—";

    // Next stop from the trip update: first stop whose arrival hasn't passed yet.
    let nextStop = "—";
    let eta = "";
    let arrives = "—";
    const tu = tripUpdates[id];
    if (tu && (!v.trip?.tripId || tu.tripId === v.trip.tripId)) {
      const now = Date.now() / 1000;
      const next = tu.stops.find((s) => s.time >= now - 30);
      if (next) {
        const mins = Math.max(0, Math.round((next.time - now) / 60));
        nextStop = next.stopId;
        eta = mins <= 0 ? "Now" : `${mins} min`;
        arrives = new Date(next.time * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      }
    }

    popup.setHTML(`
      <div class="vp" style="--route:${r.color}">
        <div class="vp-head">
          <img class="vp-icon" src="${r.icon}" alt="">
          <div>
            <div class="vp-title">${r.name}</div>
            <div class="vp-sub">Car ${id}</div>
          </div>
        </div>
        <div class="vp-next">
          <div>
            <span class="vp-next-label">Next stop</span>
            <span class="vp-next-stop">${nextStop}</span>
          </div>
          <span class="vp-eta">${eta}</span>
        </div>
        <dl class="vp-grid">
          <div><dt>Arrives</dt><dd>${arrives}</dd></div>
          <div><dt>Speed</dt><dd>${speed}</dd></div>
          <div><dt>Trip</dt><dd>${v.trip?.tripId ?? "—"}</dd></div>
          <div><dt>Updated</dt><dd>${time}</dd></div>
        </dl>
      </div>`);
  });

  const marker = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(lngLat).setPopup(popup).addTo(map);

  el.addEventListener("click", () => selectVehicle(id));

  vehicles[id] = {
    marker,
    el,
    popup,
    routeCode: String(data.route_code),
    timestamp: ts,
    lastSeen: Date.now(),
    data,
    anim: null
  };
}

function animateTo(vehicle, target) {
  if (vehicle.anim) cancelAnimationFrame(vehicle.anim);

  // No point animating in a background tab — just jump.
  if (document.hidden) {
    vehicle.marker.setLngLat(target);
    return;
  }

  const start = vehicle.marker.getLngLat();
  const dLng = target[0] - start.lng;
  const dLat = target[1] - start.lat;
  const t0 = performance.now();

  const step = (now) => {
    const p = Math.min((now - t0) / ANIMATION_MS, 1);
    const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    vehicle.marker.setLngLat([start.lng + dLng * eased, start.lat + dLat * eased]);
    vehicle.anim = p < 1 ? requestAnimationFrame(step) : null;
  };
  vehicle.anim = requestAnimationFrame(step);
}

function removeVehicle(id) {
  const v = vehicles[id];
  if (!v) return;
  if (v.anim) cancelAnimationFrame(v.anim);
  v.marker.remove();
  delete vehicles[id];
  if (selectedId === id) closeTripPanel();
}

function prune() {
  const now = Date.now();
  for (const id in vehicles) {
    if (now - vehicles[id].lastSeen > REMOVE_AFTER_MS) removeVehicle(id);
  }
  for (const id in tripUpdates) {
    if (now - tripUpdates[id].lastSeen > REMOVE_AFTER_MS) delete tripUpdates[id];
  }
  // keep "x min" countdowns fresh even if no new message arrived
  if (selectedId) renderTripPanel();
}

// =========================
// DATA — VEHICLE POSITIONS
// =========================

function handlePosition(data) {
  const v = data?.vehicle;
  if (!v || !v.position || !v.trip) return;

  const route = ROUTES[data.route_code];
  if (!route) return; // skip unknown routes — no grey dots

  const id = v.vehicle?.id || data.id;
  const lat = Number(v.position.latitude);
  const lng = Number(v.position.longitude);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const ts = parseInt(v.timestamp, 10) || 0;
  if (ts && Date.now() / 1000 - ts > STALE_SECONDS) return;

  const existing = vehicles[id];

  if (!existing) {
    createVehicle(id, route, data, [lng, lat], ts);
  } else {
    if (ts && existing.timestamp && ts <= existing.timestamp) return; // out-of-order/duplicate

    existing.timestamp = ts;
    existing.lastSeen = Date.now();
    existing.data = data;

    if (existing.routeCode !== String(data.route_code)) {
      existing.routeCode = String(data.route_code);
      existing.el.dataset.route = data.route_code;
      styleMarker(existing.el, route);
    }

    animateTo(existing, [lng, lat]);
  }

  if (id === selectedId) renderTripPanel();
  setUpdateTime();
}

// =========================
// DATA — TRIP UPDATES
// =========================

function handleTripUpdate(data) {
  const tu = data?.tripUpdate;
  const vehicleId = tu?.vehicle?.id;
  if (!tu || !vehicleId) return;

  // route_code comes through empty on this feed — use trip.routeId instead.
  const routeId = tu.trip?.routeId || data.route_code;
  if (!ROUTES[routeId]) return;

  const stops = (tu.stopTimeUpdate || [])
    .map((s) => {
      const rawDelay = s.arrival?.delay ?? s.departure?.delay;
      const delay = rawDelay != null ? parseInt(rawDelay, 10) : null;
      return {
        stopId: s.stopId,
        stopSequence: s.stopSequence,
        time: parseInt(s.arrival?.time || s.departure?.time, 10),
        delay: Number.isFinite(delay) ? delay : null, // seconds, + late / - early
        relationship: s.scheduleRelationship || "SCHEDULED"
      };
    })
    .filter((s) => Number.isFinite(s.time))
    .sort((a, b) => a.stopSequence - b.stopSequence);

  tripUpdates[vehicleId] = {
    tripId: tu.trip?.tripId,
    routeId,
    directionId: tu.trip?.directionId,
    startTime: tu.trip?.startTime,
    relationship: tu.trip?.scheduleRelationship || "SCHEDULED",
    stops,
    lastSeen: Date.now()
  };

  if (vehicleId === selectedId) renderTripPanel();
}

// =========================
// TRIP PANEL
// =========================

function selectVehicle(id) {
  if (selectedId && vehicles[selectedId]) vehicles[selectedId].el.classList.remove("is-selected");
  selectedId = id;
  vehicles[id]?.el.classList.add("is-selected");
  renderTripPanel(true);
}

function closeTripPanel() {
  if (selectedId && vehicles[selectedId]) vehicles[selectedId].el.classList.remove("is-selected");
  selectedId = null;
  const panel = document.getElementById("trippanel");
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = "";
  }
}

// Overall delay = delay at the next upcoming stop that reports one.
function delayStatus(trip, stops) {
  if (trip?.relationship === "CANCELED") return { cls: "canceled", label: "Canceled", detail: "" };

  const withDelay = stops.find((s) => s.delay != null);
  if (!withDelay) {
    return { cls: "unknown", label: "Delay unknown", detail: "Feed has predicted times only" };
  }

  const d = withDelay.delay;
  const mins = Math.round(Math.abs(d) / 60);
  if (Math.abs(d) < 60) return { cls: "on-time", label: "On time", detail: "" };
  if (d > 0) return { cls: mins >= 5 ? "very-late" : "late", label: `${mins} min late`, detail: `at ${withDelay.stopId}` };
  return { cls: "early", label: `${mins} min early`, detail: `at ${withDelay.stopId}` };
}

function renderTripPanel(resetScroll = false) {
  const panel = document.getElementById("trippanel");
  if (!panel) return;

  const vehicle = vehicles[selectedId];
  if (!vehicle) {
    closeTripPanel();
    return;
  }

  const r = ROUTES[vehicle.routeCode];
  const v = vehicle.data.vehicle;
  const tripId = v.trip?.tripId;
  const tu = tripUpdates[selectedId];
  const hasTrip = tu && (!tripId || tu.tripId === tripId);

  const now = Date.now() / 1000;
  const stops = hasTrip ? tu.stops.filter((s) => s.time >= now - 30) : [];
  const status = delayStatus(hasTrip ? tu : null, stops);
  const fmt = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const speed = v.position?.speed != null ? `${Math.round(v.position.speed * 2.23694)} mph` : "—";

  const list = stops.length
    ? `<ol class="tp-stops">${stops
        .map((s, i) => {
          const mins = Math.max(0, Math.round((s.time - now) / 60));
          const skipped = s.relationship === "SKIPPED";
          let delay = "";
          if (s.delay != null && Math.abs(s.delay) >= 60) {
            const m = Math.round(Math.abs(s.delay) / 60);
            delay = `<span class="tp-stop-delay ${s.delay > 0 ? "late" : "early"}">${s.delay > 0 ? "+" : "−"}${m} min</span>`;
          }
          return `
            <li class="tp-stop${i === 0 ? " is-next" : ""}${skipped ? " is-skipped" : ""}">
              <span class="tp-dot"></span>
              <span class="tp-stop-id">${s.stopId}</span>
              <span class="tp-stop-time">
                <strong>${skipped ? "Skipped" : mins <= 0 ? "Now" : `${mins} min`}</strong>
                <small>${fmt(s.time)}</small>
                ${delay}
              </span>
            </li>`;
        })
        .join("")}</ol>`
    : `<p class="tp-empty">${hasTrip ? "No upcoming stops reported." : "Waiting for trip updates…"}</p>`;

  // keep the list's scroll position across live re-renders
  const prevScroll = resetScroll ? 0 : panel.querySelector(".tp-stops")?.scrollTop || 0;

  panel.style.setProperty("--route", r.color);
  panel.innerHTML = `
    <div class="tp-head">
      <img class="tp-icon" src="${r.icon}" alt="">
      <div>
        <div class="tp-title">${r.name}</div>
        <div class="tp-sub">Car ${selectedId}${tripId ? ` · Trip ${tripId}` : ""}</div>
      </div>
      <button class="tp-close" type="button" aria-label="Close trip panel">×</button>
    </div>

    <div class="tp-status ${status.cls}">
      <span class="tp-status-label">${status.label}</span>
      <span class="tp-status-detail">${status.detail}</span>
    </div>

    <dl class="tp-meta">
      <div><dt>Speed</dt><dd>${speed}</dd></div>
      <div><dt>Direction</dt><dd>${hasTrip && tu.directionId != null ? tu.directionId : "—"}</dd></div>
      <div><dt>Started</dt><dd>${hasTrip && tu.startTime ? tu.startTime.slice(0, 5) : "—"}</dd></div>
    </dl>

    ${list}`;

  panel.hidden = false;
  panel.querySelector(".tp-close").addEventListener("click", closeTripPanel);

  const listEl = panel.querySelector(".tp-stops");
  if (listEl) listEl.scrollTop = prevScroll;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selectedId) closeTripPanel();
});

function setUpdateTime() {
  const div = document.getElementById("update-time");
  if (div) div.textContent = `Live · ${new Date().toLocaleTimeString()}`;

  const count = document.getElementById("vehicle-count");
  if (count) count.textContent = Object.keys(vehicles).length;
}

// =========================
// WEBSOCKET
// =========================

function connectFeed(url, onData) {
  const ws = new WebSocket(url);
  let pingTimer = null;

  ws.onopen = () => {
    console.log(`WebSocket connected: ${url}`);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, PING_MS);
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return; // non-JSON frames (e.g. pong)
    }
    try {
      onData(data);
    } catch (err) {
      console.error(`Error handling message from ${url}:`, err);
    }
  };

  ws.onerror = (err) => console.error(`WebSocket error: ${url}`, err);

  ws.onclose = () => {
    console.log(`WebSocket closed — reconnecting: ${url}`);
    clearInterval(pingTimer);
    setTimeout(() => connectFeed(url, onData), RECONNECT_MS);
  };

  return ws;
}

// =========================
// START
// =========================

const map = initMap();

map.on("load", () => {
  connectFeed(POSITIONS_URL, handlePosition);
  connectFeed(TRIP_UPDATES_URL, handleTripUpdate);
  setInterval(prune, 15000);
});