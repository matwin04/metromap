const vehicles = {};

const routeColors = {
  unknown: "#888888",
  // add real route codes as you learn them, e.g.:
  // "801": "#eb131b", // Blue Line
  // "802": "#58a738", // Expo/A Line
};

function initMap() {
  const map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [-118.25, 34.05],
    zoom: 10
  });

  map.on("load", () => {
    map.addSource("trains", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });

    map.addLayer({
      id: "trains-layer",
      type: "circle",
      source: "trains",
      paint: {
        "circle-radius": 6,
        "circle-color": ["get", "color"],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#ffffff"
      }
    });
  });

  return map;
}

function connectVehicleFeed(map) {
  const ws = new WebSocket("wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions");

  ws.onopen = () => console.log("WebSocket connected");

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const vehicle = data.vehicle;
      if (!vehicle || !vehicle.position) return;

      const id = vehicle.vehicle?.id || data.id;
      const lat = vehicle.position.latitude;
      const lng = vehicle.position.longitude;
      const route = data.route_code || "unknown";

      vehicles[id] = {
        coordinates: [lng, lat],
        color: routeColors[route] || routeColors.unknown,
        data: JSON.stringify(data)
      };

      const features = Object.values(vehicles).map((v) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: v.coordinates },
        properties: { color: v.color, data: v.data }
      }));

      const source = map.getSource("trains");
      if (source) {
        source.setData({
          type: "FeatureCollection",
          features
        });
      }
    } catch (err) {
      console.error("WebSocket error:", err);
    }
  };

  ws.onclose = () => console.log("WebSocket closed");
  ws.onerror = (err) => console.error("WebSocket error event:", err);

  return ws;
}

const map = initMap();
map.on("load", () => {
  connectVehicleFeed(map);
});