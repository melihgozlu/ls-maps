// LS Maps — GTA V Los Santos tarzı MapLibre stili.
// Vector karoları: OpenFreeMap (OpenMapTiles şeması, API anahtarı gerekmez).

(function () {
  "use strict";

  var TR_NAME = ["coalesce", ["get", "name:tr"], ["get", "name_tr"], ["get", "name"]];

  var C = {
    land:        "#2D332D",
    park:        "#273726",
    wood:        "#233322",
    sand:        "#454132",
    water:       "#17242C",
    building:    "#232829",
    buildingTop: "#1F2425",
    casing:      "#151819",
    local:       "#444B4B",
    secondary:   "#626866",
    primary:     "#8A8E89",
    trunk:       "#A3A69E",
    motorway:    "#BEC0B6",
    railway:     "#3D4343",
    boundary:    "#475148",
    label:       "#C8CFC6",
    labelDim:    "#8C958B",
    labelHalo:   "#141819"
  };

  window.GTA_STYLE = {
    version: 8,
    name: "GTA Map",
    sources: {
      omt: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet"
      }
    },
    sprite: "https://tiles.openfreemap.org/sprites/ofm_f384/ofm",
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.land } },

      {
        id: "landcover-wood",
        type: "fill",
        source: "omt",
        "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["wood", "forest"]]],
        paint: { "fill-color": C.wood, "fill-opacity": 0.9 }
      },
      {
        id: "landcover-grass",
        type: "fill",
        source: "omt",
        "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["grass", "scrub", "farmland"]]],
        paint: { "fill-color": C.park, "fill-opacity": 0.65 }
      },
      {
        id: "landcover-sand",
        type: "fill",
        source: "omt",
        "source-layer": "landcover",
        filter: ["==", ["get", "class"], "sand"],
        paint: { "fill-color": C.sand, "fill-opacity": 0.85 }
      },
      {
        id: "park",
        type: "fill",
        source: "omt",
        "source-layer": "park",
        paint: { "fill-color": C.park, "fill-opacity": 0.85 }
      },
      {
        id: "landuse-green",
        type: "fill",
        source: "omt",
        "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["park", "cemetery", "pitch", "stadium", "golf_course", "recreation_ground"]]],
        paint: { "fill-color": C.park, "fill-opacity": 0.8 }
      },

      {
        id: "water",
        type: "fill",
        source: "omt",
        "source-layer": "water",
        paint: { "fill-color": C.water }
      },
      {
        id: "waterway",
        type: "line",
        source: "omt",
        "source-layer": "waterway",
        paint: {
          "line-color": C.water,
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 14, 4, 18, 12]
        }
      },

      {
        id: "aeroway-runway",
        type: "line",
        source: "omt",
        "source-layer": "aeroway",
        filter: ["==", ["get", "class"], "runway"],
        paint: {
          "line-color": "#383E3D",
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, 3, 15, 22]
        }
      },

      {
        id: "building",
        type: "fill",
        source: "omt",
        "source-layer": "building",
        minzoom: 13,
        paint: {
          "fill-color": C.building,
          "fill-outline-color": C.buildingTop,
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 0.85]
        }
      },

      {
        id: "railway",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        filter: ["==", ["get", "class"], "rail"],
        paint: {
          "line-color": C.railway,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 15, 1.8],
          "line-dasharray": [4, 4]
        }
      },

      // --- Yol dış çizgileri ---
      {
        id: "road-local-casing",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 12,
        filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track", "residential", "unclassified"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.casing,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 12, 1.5, 15, 6, 18, 18]
        }
      },
      {
        id: "road-secondary-casing",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 9,
        filter: ["in", ["get", "class"], ["literal", ["secondary", "tertiary"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.casing,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 9, 1.6, 14, 7.5, 18, 22]
        }
      },
      {
        id: "road-primary-casing",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 7,
        filter: ["==", ["get", "class"], "primary"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.casing,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 7, 1.4, 14, 9.5, 18, 26]
        }
      },
      {
        id: "road-trunk-casing",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 6,
        filter: ["in", ["get", "class"], ["literal", ["trunk", "motorway"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.casing,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 6, 1.8, 14, 12, 18, 30]
        }
      },

      // --- Yol dolguları ---
      {
        id: "road-local",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 12,
        filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track", "residential", "unclassified"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.local,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 12, 0.7, 15, 4, 18, 14]
        }
      },
      {
        id: "road-secondary",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 9,
        filter: ["in", ["get", "class"], ["literal", ["secondary", "tertiary"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.secondary,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 9, 0.9, 14, 5.2, 18, 17]
        }
      },
      {
        id: "road-primary",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 7,
        filter: ["==", ["get", "class"], "primary"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.primary,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 7, 0.8, 14, 6.8, 18, 21]
        }
      },
      {
        id: "road-trunk",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 6,
        filter: ["==", ["get", "class"], "trunk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.trunk,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 6, 1.1, 14, 8.5, 18, 24]
        }
      },
      {
        id: "road-motorway",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 6,
        filter: ["==", ["get", "class"], "motorway"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.motorway,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 6, 1.3, 14, 9.5, 18, 26]
        }
      },

      // --- Sınırlar ---
      {
        id: "boundary-admin",
        type: "line",
        source: "omt",
        "source-layer": "boundary",
        filter: ["<=", ["get", "admin_level"], 4],
        paint: {
          "line-color": C.boundary,
          "line-width": 1,
          "line-dasharray": [3, 3]
        }
      },

      // --- Türkçe Etiketler ---
      {
        id: "water-name",
        type: "symbol",
        source: "omt",
        "source-layer": "water_name",
        layout: {
          "text-field": TR_NAME,
          "text-font": ["Noto Sans Italic"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 14, 14],
          "text-letter-spacing": 0.12
        },
        paint: {
          "text-color": "#4E6A78",
          "text-halo-color": C.water,
          "text-halo-width": 1.2
        }
      },
      {
        id: "road-name",
        type: "symbol",
        source: "omt",
        "source-layer": "transportation_name",
        minzoom: 13,
        layout: {
          "symbol-placement": "line",
          "text-field": TR_NAME,
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 17, 13],
          "text-transform": "uppercase",
          "text-letter-spacing": 0.06
        },
        paint: {
          "text-color": C.label,
          "text-halo-color": C.labelHalo,
          "text-halo-width": 1.6
        }
      },
      {
        id: "poi-label",
        type: "symbol",
        source: "omt",
        "source-layer": "poi",
        minzoom: 14,
        filter: ["<=", ["get", "rank"], 8],
        layout: {
          "text-field": TR_NAME,
          "text-font": ["Noto Sans Regular"],
          "text-size": 10.5,
          "text-offset": [0, 0.9],
          "text-anchor": "top",
          "text-max-width": 9
        },
        paint: {
          "text-color": C.labelDim,
          "text-halo-color": C.labelHalo,
          "text-halo-width": 1.3
        }
      },
      {
        id: "place-suburb",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        minzoom: 11,
        maxzoom: 16,
        filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood", "quarter"]]],
        layout: {
          "text-field": TR_NAME,
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 15, 13],
          "text-transform": "uppercase",
          "text-letter-spacing": 0.1
        },
        paint: {
          "text-color": C.labelDim,
          "text-halo-color": C.labelHalo,
          "text-halo-width": 1.6
        }
      },
      {
        id: "place-city",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        minzoom: 5,
        maxzoom: 14,
        filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
        layout: {
          "text-field": TR_NAME,
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 5, 11, 12, 17],
          "text-transform": "uppercase",
          "text-letter-spacing": 0.08
        },
        paint: {
          "text-color": C.label,
          "text-halo-color": C.labelHalo,
          "text-halo-width": 2
        }
      }
    ]
  };
})();
