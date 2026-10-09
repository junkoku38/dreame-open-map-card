/**
 * dreame-open-map-card
 * ============================================================================
 * Carte carte interactive open-source pour l'intégration Home Assistant
 * "Tasshack/dreame-vacuum" (https://github.com/Tasshack/dreame-vacuum).
 *
 * Cette carte est une implémentation originale et indépendante. Elle ne
 * contient aucun code de la "Dreame Vacuum Card" (propriétaire) et ne requiert
 * aucune clé de licence. Elle consomme uniquement l'interface publique
 * déjà documentée par l'intégration MIT : l'entité `camera.map_data`
 * (endpoint `/api/camera_map_data_proxy/{entity_id}`) et les services
 * standard de l'intégration.
 *
 * Prérequis : activer l'entité "Données cartographiques actuelles"
 * (`camera.*_map_data`) dans la configuration de l'intégration : elle est
 * désactivée par défaut.
 *
 * Licence : MIT
 */

const CARD_VERSION = "0.1.0";

/* ------------------------------------------------------------------ *
 * Sémantique des couches de pixels (contrat de données de l'intégration)
 * `data` est un objet { couche: [x, y, longueur, x, y, longueur, ...] }
 * en runs horizontaux classés par y croissant (origine y = bas de l'image).
 * ------------------------------------------------------------------ */
const LAYER = {
  FLOOR: 0,        // sol cartographié hors pièces
  SEGMENT_MIN: 1,  // 1..62 : pixels de pièce (clé = identifiant de segment)
  SEGMENT_MAX: 62,
  OUTLINE_MIN: 101, // 101..162 : pixels de contour, pièce = clé - 100
  OUTLINE_MAX: 162,
  OBSTACLE_MIN: 201, // 201..231 : meubles/obstacles délimités
  OBSTACLE_MAX: 231,
  CARPET: 512,     // pixels de tapis
};

const SEGMENT_COLORS = [
  "rgb(99, 181, 245)",
  "rgb(245, 183, 74)",
  "rgb(120, 226, 205)",
  "rgb(176, 221, 88)",
  "rgb(228, 129, 213)",
  "rgb(101, 210, 111)",
  "rgb(255, 154, 141)",
  "rgb(163, 156, 244)",
  "rgb(255, 197, 79)",
  "rgb(92, 203, 240)",
  "rgb(233, 105, 163)",
  "rgb(140, 193, 105)",
  "rgb(255, 145, 100)",
  "rgb(93, 169, 245)",
  "rgb(207, 128, 227)",
  "rgb(108, 217, 160)",
];

const COLORS = {
  background: "var(--card-background-color, #ffffff)",
  unknownSpace: "transparent", // hors zone cartographiée
  floor: "#ece9e1",
  wall: "#9aa0a6",
  carpet: "rgba(178, 132, 84, 0.30)",
  obstacle: "#5c636e",
  path: "#1e88e5",
  pathMove: "#90a4ae",
  activeSegment: "rgba(30, 136, 229, 0.45)",
  selectedSegment: "rgba(255, 152, 0, 0.45)",
  selectedStroke: "#ef6c00",
  activeArea: "rgba(76, 175, 80, 0.30)",
  activeAreaStroke: "#43a047",
  pendingZone: "rgba(30, 136, 229, 0.30)",
  pendingZoneStroke: "#1e88e5",
  point: "#43a047",
  virtualWall: "#e53935",
  noGo: "rgba(229, 57, 53, 0.22)",
  noMop: "rgba(170, 47, 255, 0.22)",
  robot: "#1e88e5",
  charger: "#43a047",
  label: "#37474f",
};

const MODE_HINTS = {
  rooms: "Sélectionne des pièces (clic sur la carte ou sur les pastilles), puis « Nettoyer la sélection ».",
  zone: "Dessine un ou plusieurs rectangles à la souris/doigt, puis « Nettoyer la zone ».",
  goto: "Pose un ou plusieurs points puis « Aller au dernier point ».",
  follow: "Relie des points avec des clics successifs, puis « Suivre le chemin ».",
};

/* ------------------------------------------------------------------ *
 * Utilitaires
 * ------------------------------------------------------------------ */

/** base64 -> chaîne UTF-8 (les noms de pièces sont encodés ainsi). */
function b64ToUtf8(s) {
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    return "";
  }
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** Extrait r,g,b, a d'une couleur CSS "r,g,b, a" ou "#rgrbg". */
function colorParts(c, fallback) {
  if (typeof c === "string" && c.startsWith("#")) {
    const m = c.replace("#", "").match(/^[0-9a-f]{6}/i);
    if (m) {
      const n = parseInt(m[0], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return fallback;
  }
  if (typeof c === "string") {
    const m = c.match(/(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*([\d.]+))?/);
    if (m) {
      const a = m[4] === undefined || m[4] === "" ? 1 : parseFloat(m[4]);
      return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
    }
  }
  return fallback;
}

function parseCssColor(value, fallback) {
  // Renvoie [r, g, b, a]; supporte "var(--...)" résolu via l'élément hôte.
  if (typeof value === "string" && value.startsWith("var(")) {
    if (typeof window !== "undefined" && window.CSS && CSS.supports && CSS.supports("color", value)) {
      try {
        // Résolution via un élément temporaire hors écran.
        const probe = document.createElement("div");
        probe.style.color = value;
        probe.style.display = "none";
        document.body.appendChild(probe);
        const computed = getComputedStyle(probe).color;
        document.body.removeChild(probe);
        return colorParts(computed, fallback);
      } catch (e) {
        return fallback;
      }
    }
    return fallback;
  }
  const p = colorParts(value, null);
  return p || fallback;
}

/** chaîne (octets latin) -> octets, pour le parcours callApi non décodé. */
function bytesFromString(s) {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

/** Décompresse des octets gzip puis parse JSON (fallback : JSON direct). */
async function jsonFromBytes(bytes) {
  let buf = bytes;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("navigateur sans support gzip (DecompressionStream) — mets à jour le navigateur");
    }
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    buf = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder("utf-8").decode(buf));
}

/* ------------------------------------------------------------------ *
 * Géométrie de la carte
 * ------------------------------------------------------------------ */
class MapGeometry {
  constructor(data) {
    this.raw = data;
    this.empty = !data || !!data.empty_map || !data.size || !data.data;
    const size = (data && data.size) || [];
    this.left = Number(size[0]) || 0;   // coordonnée robot du pixel (0,0)
    this.top = Number(size[1]) || 0;
    this.width = Math.max(1, Math.round(Number(size[4]) || 1));
    this.height = Math.max(1, Math.round(Number(size[5]) || 1));
    this.grid = Number(size[6]) || 6;   // mm par pixel
    this.rotation = Number(size[7]) || 0;
    this.frameId = (data && data.frame_id) || 0;

    // couches de pixels : { "12": [x,y,n, x,y,n, ...], ... }
    this.layers = {};
    if (data && data.data && typeof data.data === "object") {
      for (const key of Object.keys(data.data)) {
        this.layers[Number(key)] = data.data[key];
      }
    }

    // segments : [id, x, y, type, nom_b64, index, color_index, voisins,
    //  floor_material, direction, visibilité, unmapped, ordre, suction,
    //  water, fois, mode, mop_route, route, wetness, [x0,y0,x1,y1], ...]
    this.segments = {};
    if (data && Array.isArray(data.segments)) {
      for (const s of data.segments) {
        if (!Array.isArray(s) || s.length < 7) continue;
        this.segments[Number(s[0])] = {
          id: Number(s[0]),
          x: s[1], y: s[2],
          type: s[3],
          name: s[4] ? b64ToUtf8(s[4]) : null,
          colorIndex: Number(s[6]) || 0,
          unmapped: !!s[11],
          order: s[12],
          bbox: Array.isArray(s[20]) && s[20].length === 4 ? s[20].map(Number) : null,
        };
      }
    }
    this.visibleSegments = Object.values(this.segments).filter((s) => !s.unmapped);

    this.activeSegments = (data && data.active_segments) || [];
    this.path = (data && data.path) || [];
    this.robot = (data && data.robot_position) || null;         // [x, y, a]
    this.charger = (data && data.charger_position) || null;     // [x, y, a]
    this.activeAreas = (data && data.active_areas) || [];       // [x0..y3] (8)
    this.virtualWalls = (data && data.virtual_walls) || [];     // [x0,y0,x1,y1]
    this.noGo = (data && data.no_go) || [];                     // [x0..angle] (9)
    this.noMop = (data && data.no_mop) || [];                   // ... ,angle, hidden (10)
    this.carpets = (data && data.carpets) || [];                // quads, 8 points
    this.points = (data && data.active_points) || [];           // [x, y]
  }

  /** coordonnée robot (mm) -> pixel raster (origine y en bas). */
  vacToPixel(x, y) {
    return [(x - this.left) / this.grid, (y - this.top) / this.grid];
  }

  /** pixel raster -> coordonnée robot (mm). */
  pixelToVac(px, py) {
    return [px * this.grid + this.left, py * this.grid + this.top];
  }

  /** couleur de remplissage d'un segment. */
  segmentColor(segId) {
    const seg = this.segments[segId];
    let idx = seg && seg.colorIndex ? seg.colorIndex : segId;
    idx = ((idx - 1) % SEGMENT_COLORS.length + SEGMENT_COLORS.length) % SEGMENT_COLORS.length;
    return SEGMENT_COLORS[idx];
  }
}

/* ------------------------------------------------------------------ *
 * La carte
 * ------------------------------------------------------------------ */
class DreameOpenMapCard extends HTMLElement {
  static getStubConfig() {
    return { entity: "", camera: "" };
  }

  constructor() {
    super();
    this._hass = null;
    this._config = null;
    this._mapData = null;
    this._geom = null;
    this._scale = 1;
    this._mode = "rooms";
    this._selectedRooms = new Set();
    this._pendingZones = [];
    this._pendingPoints = [];
    this._drag = null;
    this._repeats = 1;
    this._error = null;
    this._fetching = false;
    this._lastFrameId = -1;
    this._lastFetchAt = 0;
    this._fetchTimer = null;
    this._renderTimer = null;
    this._builtRoomEpoch = -1;
    this.attachShadow({ mode: "open" });
  }

  /* ------------------------ configuration ---------------------------- */
  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("dreame-open-map-card : « entity: vacuum.xxx » est requis.");
    }
    if (!config.camera) {
      throw new Error(
        "dreame-open-map-card : « camera: camera.xxx_map_data » est requis " +
        "(active l'entité « Données cartographiques actuelles » de l'intégration)."
      );
    }
    this._config = {
      update_interval: 5,
      controls: true,
      room_cleaning: true,
      zone_cleaning: true,
      goto: false,
      follow_path: false,
      title: null,
      show_room_labels: true,
      colors: null,
      segment_colors: null,
      ...config,
    };
    if (Array.isArray(this._config.segment_colors) && this._config.segment_colors.length) {
      SEGMENT_COLORS.length = 0;
      SEGMENT_COLORS.push(...this._config.segment_colors);
    }
    if (this._config.colors) {
      for (const k of Object.keys(COLORS)) {
        if (this._config.colors[k] !== undefined) COLORS[k] = this._config.colors[k];
      }
    }
    this._buildUI();
  }

  getCardSize() {
    return 12;
  }

  /* --------------------------- hass ---------------------------------- */
  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._updateStatus();
    if (!this._config) return;
    const need = first || this._refetchDue();
    if (need && !this._fetching && hass.connected) {
      this._fetchData();
    }
    this._scheduleFetchLoop();
    this._scheduleRender();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (this._hass) this._scheduleFetchLoop();
  }

  disconnectedCallback() {
    if (this._fetchTimer) clearTimeout(this._fetchTimer);
    this._fetchTimer = null;
    if (this._renderTimer) clearTimeout(this._renderTimer);
    this._renderTimer = null;
  }

  /* --------------------------- données ------------------------------- */
  _integratedUpdateMs() {
    // rafraîchit plus souvent quand le robot travaille
    const st = this._hass && this._hass.states ? this._hass.states[this._config.entity] : null;
    const busy = st && ["cleaning", "returning", "returning_to_base", "segment_cleaning"].includes(st.state);
    if (busy) return Math.min(2000, this._config.update_interval * 1000);
    return this._config.update_interval * 1000;
  }

  _refetchDue() {
    const now = Date.now();
    if (now - this._lastFetchAt < this._integratedUpdateMs() - 250) return false;
    return true;
  }

  _scheduleFetchLoop() {
    if (this._fetchTimer) clearTimeout(this._fetchTimer);
    if (!this.isConnected || !this._config) return;
    const delay = Math.max(1000, Math.min(2000, this._integratedUpdateMs()));
    this._fetchTimer = setTimeout(() => {
      if (this._hass && this._hass.connected && !document.hidden && this._refetchDue()) {
        this._fetchData();
      }
      this._scheduleFetchLoop();
    }, delay);
  }

  async _fetchData() {
    if (!this._hass || !this._config) return;
    this._fetching = true;
    this._lastFetchAt = Date.now();
    try {
      const json = await this._requestData();
      this._mapData = json && json.empty_map ? null : json;
      this._geom = this._mapData ? new MapGeometry(this._mapData) : null;
      this._error = null;
    } catch (e) {
      if (!this._error) {
        this._error = e && e.message ? e.message : String(e);
      }
      // ralentit en cas d'échec répété
      this._lastFetchAt = Date.now() + this._integratedUpdateMs();
    } finally {
      this._fetching = false;
      if (this._geom && this._geom.frameId !== this._lastFrameId) {
        this._lastFrameId = this._geom.frameId;
        this._selectedRooms = new Set(
          [...this._selectedRooms].filter((id) => this._geom.segments[id])
        );
        this._builtRoomEpoch = -1; // force la reconstruction des pastilles
      }
      this._scheduleRender();
    }
  }

  async _requestData() {
    const entity = encodeURIComponent(this._config.camera);
    // le serveur pose "Cache-Control: immutable" : cache-buster obligatoire
    const url = new URL(`/api/camera_map_data_proxy/${entity}`, location);
    url.searchParams.set("ts", String(Date.now()));
    if (this._hass.fetchWithAuth) {
      const resp = await this._hass.fetchWithAuth(url.toString());
      if (!resp.ok) throw new Error(`HTTP ${resp.status} sur camera_map_data_proxy`);
      return jsonFromBytes(new Uint8Array(await resp.arrayBuffer()));
    }
    // secours : callApi gère l'authentification et le décodage JSON
    const data = await this._hass.callApi("GET", `camera_map_data_proxy/${entity}?ts=${Date.now()}`);
    if (data && typeof data === "object") return data;
    if (typeof data === "string") return jsonFromBytes(bytesFromString(data));
    throw new Error("réponse inattendue du serveur de carte");
  }

  /* ------------------------------ UI --------------------------------- */
  _buildUI() {
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>
        :host {
          display: block;
          background: var(--card-background-color, #fff);
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 8px rgba(0,0,0,.12));
          border: 1px solid var(--ha-card-border-color, rgba(0,0,0,.08));
          overflow: hidden;
        }
        .header { display: flex; align-items: center; gap: 8px; padding: 12px 14px 4px; }
        .header .name { flex: 1; font-size: 1.05rem; font-weight: 600; color: var(--primary-text-color, #111); }
        .header .battery, .header .state { font-size: .8rem; color: var(--secondary-text-color, #666); }
        .toolbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 12px; }
        .toolbar button {
          background: var(--secondary-background-color, #eee);
          border: 0; border-radius: 999px; padding: 5px 12px;
          font: inherit; font-size: .8rem; cursor: pointer;
          color: var(--primary-text-color, #333);
        }
        .toolbar button.active {
          background: var(--primary-color, #1e88e5);
          color: var(--primary-text-color, #fff);
        }
        .mapwrap { position: relative; margin: 4px 10px 6px; }
        canvas { display: block; width: 100%; height: auto; border-radius: 8px;
                 touch-action: none; cursor: crosshair; background: transparent; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
        .chips button {
          border: 1px solid var(--divider-color, rgba(0,0,0,.12));
          background: transparent; color: var(--primary-text-color, #333);
          border-radius: 999px; padding: 3px 10px; font: inherit; font-size: .78rem; cursor: pointer;
        }
        .chips button.selected {
          background: var(--primary-color, #1e88e5);
          color: var(--primary-text-color, #fff);
          border-color: transparent;
        }
        .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; align-items: center; }
        .actions button, .vactions button {
          border: 0; border-radius: 999px; padding: 8px 14px;
          font: inherit; font-size: .82rem; cursor: pointer;
          background: var(--primary-color, #1e88e5); color: var(--primary-text-color, #fff);
        }
        .actions button.ghost, .vactions button.ghost {
          background: var(--secondary-background-color, #eee);
          color: var(--primary-text-color, #444);
        }
        .actions select {
          border: 1px solid var(--divider-color, rgba(0,0,0,.2));
          border-radius: 8px; padding: 7px 8px; font: inherit; font-size: .8rem;
          background: var(--card-background-color, #fff); color: var(--primary-text-color, #333);
        }
        .vactions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 12px; }
        .hint { font-size: .74rem; color: var(--secondary-text-color, #777); padding: 0 14px 10px; }
        .error { color: var(--error-color, #b3261e); font-size: .8rem; padding: 0 14px 10px; }
        .meta { font-size: .7rem; color: var(--secondary-text-color, #999); padding: 0 14px 10px; }
      </style>
      <div class="header">
        <span class="name"></span>
        <span class="state"></span>
        <span class="battery"></span>
      </div>
      <div class="toolbar"></div>
      <div class="mapwrap"><canvas></canvas></div>
      <div class="chips"></div>
      <div class="actions"></div>
      <div class="vactions"></div>
      <div class="error"></div>
      <div class="hint"></div>
      <div class="meta"></div>
    `;
    const canvas = root.querySelector("canvas");
    canvas.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this._onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this._onPointerUp(e));
    canvas.addEventListener("pointercancel", () => {
      this._drag = null;
      this._scheduleRender();
    });
    this._buildToolbar();
    this._buildChips();
    this._buildActions();
    this._buildVacControls();
    this._updateHint();
  }

  _buildToolbar() {
    const tb = this.shadowRoot.querySelector(".toolbar");
    tb.innerHTML = "";
    const mk = (label, mode, enabled) => {
      if (!enabled) return;
      const b = document.createElement("button");
      b.textContent = label;
      b.dataset.mode = mode;
      b.classList.toggle("active", this._mode === mode);
      b.addEventListener("click", () => {
        this._setMode(mode);
        tb.querySelectorAll("button").forEach((x) =>
          x.classList.toggle("active", x.dataset.mode === mode)
        );
      });
      tb.append(b);
    };
    mk("Pièces", "rooms", !!this._config.room_cleaning);
    mk("Zone", "zone", !!this._config.zone_cleaning);
    mk("Aller à", "goto", !!this._config.goto);
    mk("Chemin", "follow", !!this._config.follow_path);
  }

  _setMode(mode) {
    this._mode = mode;
    if (mode !== "rooms") this._selectedRooms.clear();
    this._drag = null;
    this._buildChips();
    this._buildActions();
    this._updateHint();
    this._scheduleRender();
  }

  _rebuildChipsIfDirty() {
    if (!this._geom) return;
    if (this._builtRoomEpoch === this._geom.frameId) return;
    this._builtRoomEpoch = this._geom.frameId;
    this._buildChips();
    this._updateHint();
  }

  _buildChips() {
    const wrap = this.shadowRoot.querySelector(".chips");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (this._mode !== "rooms" || !this._geom || !this._geom.visibleSegments.length) return;
    for (const seg of this._geom.visibleSegments) {
      const b = document.createElement("button");
      b.textContent = seg.name || `Pièce ${seg.id}`;
      b.classList.toggle("selected", this._selectedRooms.has(seg.id));
      b.addEventListener("click", () => {
        if (this._selectedRooms.has(seg.id)) this._selectedRooms.delete(seg.id);
        else this._selectedRooms.add(seg.id);
        b.classList.toggle("selected", this._selectedRooms.has(seg.id));
        this._scheduleRender();
      });
      wrap.append(b);
    }
  }

  _buildActions() {
    const row = this.shadowRoot.querySelector(".actions");
    if (!row) return;
    row.innerHTML = "";
    const mkBtn = (label, fn, ghost) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (ghost) b.classList.add("ghost");
      b.addEventListener("click", fn);
      row.append(b);
      return b;
    };
    const sel = document.createElement("select");
    sel.title = "Nombre de passages";
    for (const n of [1, 2, 3]) {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = `${n} passe${n > 1 ? "s" : ""}`;
      if (n === this._repeats) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener("change", () => (this._repeats = parseInt(sel.value, 10) || 1));

    if (this._mode === "rooms") {
      if (this._config.room_cleaning !== false) row.append(sel);
      mkBtn("Nettoyer la sélection", () => {
        if (!this._selectedRooms.size) return;
        this._callService("vacuum_clean_segment", {
          segments: [...this._selectedRooms],
          repeats: this._repeats,
        });
      });
      if (this._selectedRooms.size) {
        mkBtn("Tout désélect.", () => {
          this._selectedRooms.clear();
          this._buildChips();
          this._scheduleRender();
        }, true);
      }
    } else if (this._mode === "zone") {
      if (this._config.zone_cleaning !== false) row.append(sel);
      mkBtn("Nettoyer la zone", () => this._cleanZones());
      mkBtn("Effacer", () => {
        this._pendingZones = [];
        this._drag = null;
        this._scheduleRender();
      }, true);
    } else if (this._mode === "goto") {
      mkBtn("Aller au point", () => this._gotoLast());
      mkBtn("Effacer", () => {
        this._pendingPoints = [];
        this._scheduleRender();
      }, true);
    } else if (this._mode === "follow") {
      mkBtn("Suivre le chemin", () => {
        if (!this._pendingPoints.length) return;
        const pts = this._pendingPoints.map((p) => this._pixelToVacRounded(p));
        this._callService("vacuum_follow_path", { points: pts });
        this._pendingPoints = [];
        this._scheduleRender();
      });
      mkBtn("Effacer", () => {
        this._pendingPoints = [];
        this._scheduleRender();
      }, true);
    }
  }

  _buildVacControls() {
    const row = this.shadowRoot.querySelector(".vactions");
    if (!row) return;
    row.innerHTML = "";
    if (this._config.controls === false) return;
    const mk = (label, service, ghost) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (ghost) b.classList.add("ghost");
      b.addEventListener("click", () => {
        if (this._hass) this._hass.callService("vacuum", service, { entity_id: this._config.entity });
      });
      row.append(b);
    };
    mk("▶ Nettoyer", "start");
    mk("⏸ Pause", "pause", true);
    mk("⏹ Stop", "stop", true);
    mk("🏠 Base", "return_to_base", true);
    mk("📍 Localiser", "locate", true);
  }

  _updateHint() {
    const el = this.shadowRoot.querySelector(".hint");
    if (el) el.textContent = MODE_HINTS[this._mode] || "";
  }

  _updateStatus() {
    if (!this._hass || !this._config || !this.shadowRoot.querySelector) return;
    const st = this._hass.states ? this._hass.states[this._config.entity] : null;
    const nameEl = this.shadowRoot.querySelector(".header .name");
    const stEl = this.shadowRoot.querySelector(".header .state");
    const batEl = this.shadowRoot.querySelector(".header .battery");
    const errEl = this.shadowRoot.querySelector(".error");
    const metaEl = this.shadowRoot.querySelector(".meta");
    if (nameEl) {
      nameEl.textContent =
        this._config.title ||
        (st && st.attributes && st.attributes.friendly_name) ||
        this._config.entity;
    }
    if (stEl) stEl.textContent = st ? FRENCH_VACUUM_STATE[st.state] || st.state : "";
    if (batEl) {
      batEl.textContent =
        st && st.attributes && st.attributes.battery_level != null
          ? `🔋 ${st.attributes.battery_level}%`
          : "";
    }
    if (errEl) {
      let text = "";
      if (this._error) {
        text = `Carte : ${this._error}`;
      } else if (this._hass.states && !this._hass.states[this._config.camera]) {
        text =
          `Entité camera « ${this._config.camera} » introuvable. ` +
          "Active l'entité « Données cartographiques actuelles » de l'intégration (désactivée par défaut).";
      } else if (!this._geom) {
        text = "Carte vide ou indisponible pour le moment.";
      }
      errEl.textContent = text;
    }
    if (metaEl) {
      const secs = Math.round((Date.now() - this._lastFetchAt) / 1000);
      metaEl.textContent = this._lastFetchAt ? `/api/camera_map_data_proxy — maj il y a ${Math.max(0, secs)}s` : "";
    }
  }

  /* --------------------------- services ------------------------------ */
  _callService(service, fields) {
    if (!this._hass) return;
    return this._hass.callService("dreame_vacuum", service, {
      entity_id: this._config.entity,
      ...fields,
    });
  }

  _pixelToVacRounded(p) {
    const g = this._geom;
    if (!g) return [0, 0];
    const [x, y] = g.pixelToVac(p[0], p[1]);
    return [Math.round(x), Math.round(y)];
  }

  _cleanZones() {
    if (!this._drag || !this._geom) {
      if (!this._pendingZones.length) return;
    }
    const rects = [];
    for (const r of this._pendingZones) {
      rects.push(this._rectToVac(r));
    }
    if (this._drag) rects.push(this._rectToVac(this._drag));
    if (!rects.length) return;
    this._callService("vacuum_clean_zone", { zone: rects, repeats: this._repeats });
    this._pendingZones = [];
    this._drag = null;
    this._scheduleRender();
  }

  _rectToVac(r) {
    const g = this._geom;
    const x0 = Math.min(r.x0, r.x1);
    const x1 = Math.max(r.x0, r.x1);
    const y0 = Math.min(r.y0, r.y1);
    const y1 = Math.max(r.y0, r.y1);
    const a = g.pixelToVac(x0, y0);
    const b = g.pixelToVac(x1 + 1, y1 + 1);
    return [Math.round(a[0]), Math.round(a[1]), Math.round(b[0]), Math.round(b[1])];
  }

  _gotoLast() {
    if (!this._pendingPoints.length) return;
    const [x, y] = this._pixelToVacRounded(this._pendingPoints[this._pendingPoints.length - 1]);
    this._callService("vacuum_goto", { x, y });
    this._pendingPoints = [];
    this._scheduleRender();
  }

  /* ---------------------------- pointeur ----------------------------- */
  _eventToPixel(ev) {
    const g = this._geom;
    const canvas = this.shadowRoot.querySelector("canvas");
    if (!g || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const fx = (ev.clientX - rect.left) / rect.width * (g.width * this._scale);
    const fy = (ev.clientY - rect.top) / rect.height * (g.height * this._scale);
    const px = fx / this._scale;
    const py = g.height - fy / this._scale;
    return [clampInt(px, 0, g.width - 1), clampInt(py, 0, g.height - 1)];
  }

  _onPointerDown(ev) {
    const p = this._eventToPixel(ev);
    if (!p) return;
    const canvas = this.shadowRoot.querySelector("canvas");
    if (this._mode === "zone") {
      this._drag = { x0: p[0], y0: p[1], x1: p[0], y1: p[1] };
      if (canvas && canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
    } else if (this._mode === "rooms") {
      const id = this._segmentAt(p[0], p[1]);
      if (id !== null) {
        if (this._selectedRooms.has(id)) this._selectedRooms.delete(id);
        else this._selectedRooms.add(id);
        this._buildChips();
        this._scheduleRender();
      }
    } else if (this._mode === "goto") {
      this._pendingPoints = [p];
    } else if (this._mode === "follow") {
      this._pendingPoints.push(p);
    }
    this._buildActions();
    this._scheduleRender();
  }

  _onPointerMove(ev) {
    if (!this._drag) return;
    const p = this._eventToPixel(ev);
    if (!p) return;
    this._drag.x1 = p[0];
    this._drag.y1 = p[1];
    this._scheduleRender();
  }

  _onPointerUp() {
    const d = this._drag;
    if (!d) return;
    if (Math.abs(d.x1 - d.x0) > 1 || Math.abs(d.y1 - d.y0) > 1) {
      this._pendingZones.push({
        x0: Math.min(d.x0, d.x1),
        y0: Math.min(d.y0, d.y1),
        x1: Math.max(d.x0, d.x1),
        y1: Math.max(d.y0, d.y1),
      });
    }
    this._drag = null;
    this._scheduleRender();
  }

  /** id du segment raster sous le pixel (px,py) ou null. */
  _segmentAt(px, py) {
    const g = this._geom;
    if (!g) return null;
    for (const key of Object.keys(g.layers)) {
      const layer = Number(key);
      if (layer >= LAYER.SEGMENT_MIN && layer <= LAYER.SEGMENT_MAX) {
        if (this._runsContain(g.layers[key], px, py)) return layer;
      } else if (layer >= LAYER.OUTLINE_MIN && layer <= LAYER.OUTLINE_MAX) {
        const segId = layer - 100;
        if (this._runsContain(g.layers[key], px, py)) return segId;
      }
    }
    return null;
  }

  _runsContain(runs, x, y) {
    for (let i = 0; i + 2 < runs.length; i += 3) {
      const rx = runs[i], ry = runs[i + 1], n = runs[i + 2];
      if (ry > y) break;
      if (ry === y && x >= rx && x < rx + n) return true;
    }
    return false;
  }

  /* --------------------------- rendu --------------------------------- */
  _scheduleRender() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      try {
        this._render();
      } catch (e) {
        this._error = e && e.message ? e.message : String(e);
        this._updateStatus();
      }
      this._rebuildChipsIfDirty();
    }, 60);
  }

  _render() {
    const canvas = this.shadowRoot.querySelector("canvas");
    if (!canvas) return;
    this._updateStatus();
    const g = this._geom;

    if (!g || g.empty) {
      this._scale = 4;
      if (canvas.width !== 320) { canvas.width = 320; canvas.height = 180; }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#0000000a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#8a8a8a";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("carte vide ou indisponible", canvas.width / 2, canvas.height / 2);
      return;
    }

    // échelle entière : cible ~1100px sur le plus grand côté
    let scale = clampInt(1100 / Math.max(g.width, g.height), 1, 8);
    if (scale < 1) scale = 1;
    this._scale = scale;
    const W = g.width * scale;
    const H = g.height * scale;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const bg = parseCssColor(COLORS.background, [255, 255, 255]);
    ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    ctx.fillRect(0, 0, W, H);

    // repère raster : x vers la droite, y vers le HAUT (origine en bas à gauche)
    ctx.setTransform(scale, 0, 0, -scale, 0, H);

    const floor = colorParts(COLORS.floor, [236, 233, 225]);
    const wall = colorParts(COLORS.wall, [154, 160, 166]);
    const carpet = parseCssColor(COLORS.carpet, [178, 132, 84, 0.3]);
    const obstacle = colorParts(COLORS.obstacle, [92, 99, 110]);

    for (const key of Object.keys(g.layers)) {
      const layer = Number(key);
      const runs = g.layers[key];
      if (layer === LAYER.FLOOR) {
        this._paintRuns(ctx, runs, floor[0], floor[1], floor[2], 1);
      } else if (layer === LAYER.CARPET) {
        continue; // dessiné au-dessus des pièces
      } else if (layer >= LAYER.SEGMENT_MIN && layer <= LAYER.SEGMENT_MAX) {
        const rgb = colorParts(g.segmentColor(layer), [200, 210, 220]);
        this._paintRuns(ctx, runs, rgb[0], rgb[1], rgb[2], 1);
      } else if (layer >= LAYER.OUTLINE_MIN && layer <= LAYER.OUTLINE_MAX) {
        this._paintRuns(ctx, runs, wall[0], wall[1], wall[2], 1);
      } else if (layer >= LAYER.OBSTACLE_MIN && layer <= LAYER.OBSTACLE_MAX) {
        this._paintRuns(ctx, runs, obstacle[0], obstacle[1], obstacle[2], 1);
      }
    }

    // tapis (translucide)
    this._paintRuns(ctx, g.layers[LAYER.CARPET] || [], carpet[0], carpet[1], carpet[2], carpet[3] === undefined ? 1 : carpet[3]);

    // surbrillance : segments actifs (robot en cours) et sélection
    const hi = (ids, rgb, a) => {
      for (const id of ids) {
        const runs = g.layers[id];
        if (runs) this._paintRuns(ctx, runs, rgb[0], rgb[1], rgb[2], a);
      }
    };
    hi(g.activeSegments || [], [30, 136, 229], 0.45);
    hi([...this._selectedRooms], [255, 152, 0], 0.45);

    // vecteurs
    this._drawQuads(ctx, g);
    this._drawVirtualWalls(ctx, g);
    this._drawZonesAndPoints(ctx, g);
    this._drawPath(ctx, g);
    this._drawMarkers(ctx, g);

    // repasse en pixels écran pour les libellés (pas de texte dans le repère inversé)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this._config.show_room_labels !== false && g.width >= 40) {
      this._drawRoomLabels(ctx, g);
      this._drawDeviceLabels(ctx, g);
    }
  }

  /** peint une couche de runs : [x, y, n, ...] ; y en unités raster. */
  _paintRuns(ctx, runs, r, gr, b, a) {
    if (!runs || !runs.length) return;
    ctx.fillStyle = a >= 1 ? `rgb(${r | 0},${gr | 0},${b | 0})` : `rgba(${r | 0},${gr | 0},${b | 0},${a})`;
    for (let i = 0; i + 2 < runs.length; i += 3) {
      ctx.fillRect(runs[i], runs[i + 1], runs[i + 2], 1);
    }
  }

  _drawQuads(ctx, g) {
    const conv = (v) => g.vacToPixel(v[0], v[1]);
    for (const area of g.activeAreas || []) {
      this._strokeQuad(ctx, area.slice(0, 8).map(Number), COLORS.activeArea, COLORS.activeAreaStroke, conv);
    }
    for (const c of g.carpets || []) {
      if (Array.isArray(c) && c.length >= 8) {
        this._strokeQuad(ctx, c.slice(0, 8).map(Number), "rgba(178,132,84,0.18)", "rgba(178,132,84,0.6)", conv, true);
      }
    }
    for (const z of g.noGo || []) {
      this._strokeQuad(ctx, z.slice(0, 8).map(Number), COLORS.noGo, COLORS.virtualWall, conv);
    }
    for (const z of g.noMop || []) {
      if (Array.isArray(z) && z.length >= 10 && Number(z[9]) === 1) continue; // cachée
      this._strokeQuad(ctx, z.slice(0, 8).map(Number), COLORS.noMop, "#aa2fff", conv);
    }
  }

  _strokeQuad(ctx, values, fill, stroke, conv, noFill) {
    if (!values || values.length < 8) return;
    ctx.beginPath();
    for (let i = 0; i + 1 < 8; i += 2) {
      const [px, py] = conv([values[i], values[i + 1]]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    if (!noFill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  _drawVirtualWalls(ctx, g) {
    ctx.strokeStyle = COLORS.virtualWall;
    ctx.lineWidth = Math.max(0.8, 0.5);
    for (const w of g.virtualWalls || []) {
      if (!Array.isArray(w) || w.length < 4) continue;
      const [p0, p1] = [g.vacToPixel(w[0], w[1]), g.vacToPixel(w[2], w[3])];
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
    }
  }

  _drawZonesAndPoints(ctx, g) {
    ctx.lineWidth = 0.5;
    for (const r of [...this._pendingZones, ...(this._drag ? [this._drag] : [])]) {
      const x = Math.min(r.x0, r.x1);
      const y = Math.min(r.y0, r.y1);
      const w = Math.abs(r.x1 - r.x0) + 1;
      const h = Math.abs(r.y1 - r.y0) + 1;
      ctx.fillStyle = COLORS.pendingZone;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = COLORS.pendingZoneStroke;
      ctx.strokeRect(x, y, w, h);
    }
    ctx.fillStyle = COLORS.point;
    for (const p of this._pendingPoints) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], Math.max(1.2, 3), 0, Math.PI * 2);
      ctx.fill();
      if (g.grid) {
        // rayon utile autour du point d'aller à (visualisation)
        ctx.beginPath();
        ctx.arc(p[0], p[1], 20 / g.grid, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(67, 160, 71, 0.5)";
        ctx.stroke();
      }
    }
  }

  _drawPath(ctx, g) {
    if (!Array.isArray(g.path) || !g.path.length) return;
    const styles = [
      null,
      COLORS.path,          // S   : trajectoire principale
      COLORS.pathMove,      // W
      COLORS.pathMove,      // M
    ];
    ctx.lineWidth = 0.7;
    for (const entry of g.path) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const color = styles[entry[0]] || COLORS.pathMove;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 1; i + 1 < entry.length; i += 2) {
        const [px, py] = g.vacToPixel(Number(entry[i]), Number(entry[i + 1]));
        if (i === 1) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }

  _drawMarkers(ctx, g) {
    // chargeur
    if (g.charger && g.charger.length >= 2) {
      const [cx, cy] = g.vacToPixel(Number(g.charger[0]), Number(g.charger[1]));
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, 3), 0, Math.PI * 2);
      ctx.fillStyle = COLORS.charger;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 0.5;
      ctx.stroke();
      // triangle direction station
      if (g.charger[2] != null && !Number.isNaN(Number(g.charger[2]))) {
        const a = ((90 - Number(g.charger[2])) % 360 + 360) % 360;
        const rad = (a * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(
          cx + Math.cos(rad) * 6,
          cy - Math.sin(rad) * 6
        );
        ctx.strokeStyle = COLORS.charger;
        ctx.stroke();
      }
    }
    // robot
    if (g.robot && g.robot.length >= 2) {
      const [rx, ry] = g.vacToPixel(Number(g.robot[0]), Number(g.robot[1]));
      const a = g.robot[2] != null ? ((90 - Number(g.robot[2])) % 360 + 360) % 360 : null;
      ctx.beginPath();
      ctx.arc(rx, ry, Math.max(2, 3.4), 0, Math.PI * 2);
      ctx.fillStyle = COLORS.robot;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 0.7;
      ctx.stroke();
      if (a !== null && !Number.isNaN(a)) {
        const rad = (a * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(
          rx + Math.cos(rad) * Math.max(4.5, 7),
          ry - Math.sin(rad) * Math.max(4.5, 7)
        );
        ctx.strokeStyle = COLORS.robot;
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }
    }
  }

  /** étiquettes des pièces (repère écran). */
  _drawRoomLabels(ctx, g) {
    const scale = this._scale;
    ctx.font = `${Math.max(9, Math.round(scale * 2.6))}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(255,255,255,.85)";
    ctx.shadowBlur = 3;
    for (const seg of Object.values(g.segments)) {
      if (seg.unmapped) continue;
      let px, py;
      if (seg.bbox) {
        const [c1, c2] = g.vacToPixel(
          (seg.bbox[0] + seg.bbox[2]) / 2,
          (seg.bbox[1] + seg.bbox[3]) / 2
        );
        px = c1; py = c2;
      } else if (seg.x != null) {
        const [c1, c2] = g.vacToPixel(seg.x, seg.y);
        px = c1; py = c2;
      } else {
        continue;
      }
      const label = seg.name;
      if (!label) continue;
      const devX = px * scale;
      const devY = (g.height - py) * scale;
      if (devX < 8 || devX + 8 > g.width * scale || devY < 8 || devY + 8 > g.height * scale) continue;
      ctx.fillText(label, devX, devY);
    }
    ctx.shadowBlur = 0;
  }

  /** marqueurs device repère écran (icônes simples). */
  _drawDeviceLabels(ctx, g) {
    const scale = this._scale;
    ctx.font = `${Math.max(10, Math.round(scale * 3.2))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (g.robot && g.robot.length >= 2) {
      const [rx, ry] = g.vacToPixel(Number(g.robot[0]), Number(g.robot[1]));
      ctx.fillText("🤖", rx * scale, (g.height - ry) * scale);
    }
    if (g.charger && g.charger.length >= 2) {
      const [cx, cy] = g.vacToPixel(Number(g.charger[0]), Number(g.charger[1]));
      ctx.fillText("⚡", cx * scale, (g.height - cy) * scale - scale * 2);
    }
  }
}

const FRENCH_VACUUM_STATE = {
  cleaning: "Nettoyage",
  segment_cleaning: "Nettoyage de pièces",
  zone_cleaning: "Nettoyage de zone",
  spot_cleaning: "Nettoyage de spot",
  goto: "Aller à",
  follow_path: "Suivre un chemin",
  returning: "Retour à la base",
  returning_to_base: "Retour à la base",
  docked: "À la base",
  dormant: "En veille",
  idle: "Inactif",
  paused: "En pause",
  error: "Erreur",
  unavailable: "Indisponible",
  unknown: "Inconnu",
};

/* enregistrement ---------------------------------------------------------- */
if (typeof window !== "undefined") {
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "dreame-open-map-card",
    name: "Dreame Open Map Card",
    description:
      "Carte interactive (pièces / zones / aller à) pour l'intégration dreame-vacuum — open source, sans clé de licence.",
    preview: false,
    documentationURL: "https://github.com/junkoku38/dreame-open-map-card",
  });
  if (typeof customElements !== "undefined" && !customElements.get("dreame-open-map-card")) {
    customElements.define("dreame-open-map-card", DreameOpenMapCard);
  }
}

/* export volontairement absent : sans import ni export, ce fichier est
 * chargeable comme ressource « JavaScript Module » ET « JavaScript Legacy ». */