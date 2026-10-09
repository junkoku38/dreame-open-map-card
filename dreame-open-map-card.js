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

const CARD_VERSION = "0.3.1";

if (typeof console !== "undefined" && typeof console.info === "function") {
  console.info(
    "%c dreame-open-map-card %c v" + CARD_VERSION + " ",
    "background:#1e88e5;color:#fff;border-radius:4px 0 0 4px;padding:2px 5px;",
    "background:#43a047;color:#fff;border-radius:0 4px 4px 0;padding:2px 5px;"
  );
}

/* ------------------------------------------------------------------ *
 * Sémantique des couches de pixels (contrat de données de l'intégration)
 * `data` est un objet { couche: [x, y, longueur, x, y, longueur, ...] }
 * en runs horizontaux classés par y croissant (origine y = bas de l'image).
 * ------------------------------------------------------------------ */
const LAYER = {
  OUTSIDE: 0,      // hors carte : jamais dessiné (sémantique MapPixelType)
  SEGMENT_MIN: 1,  // 1..62 : pixels de pièce (clé = identifiant de segment)
  SEGMENT_MAX: 62, // (2..14 = types wifi d'une camera wifi : jamais branchée ici)
  OUTLINE_MIN: 101, // 101..162 : pixels de contour, pièce = clé - 100 (100+segment_id)
  OUTLINE_MAX: 162,
  OBSTACLE_WALL: 251, // pixels d'obstacle
  DIRTY_AREA: 250, // zones sales : ignoré (pas d'échelle de teinte)
  CLEAN_AREA: 249, // ignoré idem
  UNKNOWN: 252,    // ignoré
  NEW_SEGMENT: 253, // ignoré
  FLOOR: 254,      // sol cartographié hors pièces
  WALL: 255,       // murs (fines bordures autour des pièces)
};

const DEFAULT_SEGMENT_COLORS = [
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
  carpetStroke: "rgba(178, 132, 84, 0.6)",
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
  constructor(data, segmentColors) {
    this.raw = data;
    this.empty = !data || !!data.empty_map || !data.size || !data.data;
    const size = (data && data.size) || [];
    this.left = Number(size[0]) || 0;   // coordonnée robot du pixel (0,0)
    this.top = Number(size[1]) || 0;
    this.width = Math.max(1, Math.round(Number(size[4]) || 1));
    this.height = Math.max(1, Math.round(Number(size[5]) || 1));
    this.grid = Number(size[6]) || 50;  // mm par pixel (protocole Dreame : toujours 50)
    this.rotation = Number(size[7]) || 0;
    this.frameId = (data && data.frame_id) || 0;
    this.version = Number(data && data.version) || 0;

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
          // s[10] = visibilité (false : pièce cachée — sémantique de l'intégration)
          hidden: s[10] === false,
          // Number(null) = 0 : il faut distinguer « absent » (null) d'un vrai 0
          colorIndex: s[6] == null ? null : Number(s[6]),
          unmapped: !!s[11],
          order: s[12],
          bbox: Array.isArray(s[20]) && s[20].length === 4 ? s[20].map(Number) : null,
        };
      }
    }
    this.hiddenSegments = new Set(
      Object.values(this.segments).filter((s) => s.hidden).map((s) => s.id)
    );
    this.visibleSegments = Object.values(this.segments)
      .filter((s) => !s.unmapped && !s.hidden)
      .sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id));
    this._segmentColors = Array.isArray(segmentColors) && segmentColors.length
      ? segmentColors
      : DEFAULT_SEGMENT_COLORS;

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

  /** couleur de remplissage d'un segment.
   * Sémantique de l'intégration : color_index = index de table (0 valide) ;
   * les cartes version 3 appliquent la permutation [0,2,3,1] (map.py:6603). */
  segmentColor(segId) {
    const seg = this.segments[segId];
    let idx = seg && seg.colorIndex != null && Number.isFinite(seg.colorIndex)
      ? seg.colorIndex : segId;
    if (Number(this.raw && this.raw.version) === 3) {
      const p = [0, 2, 3, 1];
      idx = Number.isInteger(idx) && idx >= 0 && idx < p.length ? p[idx] : idx;
    }
    idx = ((idx % this._segmentColors.length) + this._segmentColors.length) % this._segmentColors.length;
    return this._segmentColors[idx];
  }
}

/* ------------------------------------------------------------------ *
 * La carte
 * ------------------------------------------------------------------ */
class DreameOpenMapCard extends HTMLElement {
  static getStubConfig(hass, entities) {
    if (!hass || !hass.states) return { entity: "vacuum.robot", camera: "camera.robot_map_data" };
    const pool = Array.isArray(entities) && entities.length ? entities : Object.keys(hass.states);
    const vacuum = pool.find((e) => e.startsWith("vacuum.") && hass.states[e]);
    if (!vacuum) return { entity: "vacuum.robot", camera: "camera.robot_map_data" };
    // caméra : celle qui partage le nom de l'aspirateur, sinon la première map_data
    const slug = vacuum.slice("vacuum.".length);
    const cams = pool.filter((e) => e.startsWith("camera.") && /map/i.test(e) && hass.states[e]);
    const camera =
      cams.find((c) => c.includes(slug)) ||
      cams.find((c) => /map_data/i.test(c)) ||
      cams[0] ||
      `camera.${slug}_map_data`;
    return { entity: vacuum, camera };
  }

  static getConfigElement() {
    if (typeof document === "undefined" || !document.createElement) return null;
    return document.createElement("dreame-open-map-card-editor");
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
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
      debug: false,
      ...config,
    };
    // normalisation : (nombre ou chaîne numérique) positif → borné 1..120, sinon défaut 5
    {
      const raw = this._config.update_interval;
      const n = typeof raw === "number" ? raw
        : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      this._config.update_interval =
        Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(120, Math.round(n))) : 5;
    }
    // couleurs par instance (jamais globales : plusieurs cartes/cobots possibles)
    this._colors = { ...COLORS, ...(this._config.colors || {}) };
    this._segmentColors =
      Array.isArray(this._config.segment_colors) && this._config.segment_colors.length
        ? [...this._config.segment_colors]
        : [...DEFAULT_SEGMENT_COLORS];
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
    if (need && !this._fetching && hass.connected && !document.hidden) {
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
    const idle = ["docked", "dormant", "idle", "paused", "error", "unavailable", "unknown"];
    const busy = st && !idle.includes(st.state);
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
      this._geom = this._mapData ? new MapGeometry(this._mapData, this._segmentColors) : null;
      this._error = null;
    } catch (e) {
      // dernier message conservé (plus informatif que le premier)
      this._error = e && e.message ? e.message : String(e);
      // ralentit en cas d'échec répété
      this._lastFetchAt = Date.now() + this._integratedUpdateMs();
    } finally {
      this._fetching = false;
      if (this._geom && this._geom.frameId !== this._lastFrameId) {
        this._lastFrameId = this._geom.frameId;
        this._selectedRooms = new Set(
          [...this._selectedRooms].filter((id) => {
            const s = this._geom.segments[id];
            return s && !s.unmapped && !s.hidden;
          })
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
    const stages = [];
    try {
      const resp = await this._hass.fetchWithAuth(url.toString());
      if (!resp.ok) {
        throw new Error(
          `HTTP ${resp.status} sur /api/camera_map_data_proxy` +
          (resp.status === 401 ? " (authentification refusée, recharger la page F5)" : "")
        );
      }
      return await jsonFromBytes(new Uint8Array(await resp.arrayBuffer()));
    } catch (e1) {
      stages.push("fetch: " + (e1 && e1.message ? e1.message : e1));
    }
    try {
      const data = await this._hass.callApi("GET", `camera_map_data_proxy/${entity}?ts=${Date.now()}`);
      if (data && typeof data === "object") return data;
      if (typeof data === "string") return jsonFromBytes(bytesFromString(data));
      stages.push("callApi: réponse inattendue (" + typeof data + ")");
    } catch (e2) {
      const detail =
        e2 && (e2.error || e2.message) ? (e2.error || e2.message) : String(e2);
      stages.push("callApi: " + detail);
    }
    const detail = stages.join(" ;; ");
    if (typeof console !== "undefined" && console.warn) {
      console.warn("dreame-open-map-card : échec de récupération des données de carte —", detail);
    }
    throw new Error(
      "Échec de récupération des données de la carte. La carte réessaie automatiquement." +
      (this._config && this._config.debug ? ` Détails : ${detail}` : "")
    );
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
          color: var(--primary-text-color, #111);
          overflow: hidden;
        }
        .header { display: flex; align-items: center; gap: 10px; padding: 12px 14px 4px; }
        .hicon {
          flex: none; width: 34px; height: 34px; border-radius: 10px;
          display: grid; place-items: center;
          background: color-mix(in srgb, var(--primary-color, #1e88e5) 13%, transparent);
          color: var(--primary-color, #1e88e5);
        }
        .hicon ha-icon { --mdc-icon-size: 20px; }
        .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
        .header .name {
          font-size: 1rem; font-weight: 600; letter-spacing: .005em;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          color: var(--primary-text-color, #111);
        }
        .header .sub { display: flex; align-items: center; gap: 8px; min-width: 0;
                       font-size: .78rem; color: var(--secondary-text-color, #666); }
        .header .state { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .header .battery { flex: none; margin-left: auto; display: inline-flex; align-items: center;
                           user-select: none; -webkit-user-select: none; }
        .header .battery ha-icon { --mdc-icon-size: 15px; margin-right: 1px; }
        .toolbar {
          display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px;
          margin: 4px 12px 8px; border-radius: 12px; max-width: calc(100% - 24px);
          background: rgba(127,127,127,.10); box-sizing: border-box;
        }
        .toolbar button {
          border: 0; border-radius: 9px; padding: 6px 13px;
          font: inherit; font-size: .8rem; cursor: pointer;
          color: var(--secondary-text-color, #555);
          background: transparent;
          transition: background .15s ease, color .15s ease, box-shadow .15s ease;
          user-select: none; -webkit-user-select: none;
        }
        button:disabled { opacity: .38; cursor: default; }
        .toolbar button.active {
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #111);
          box-shadow: 0 1px 3px rgba(0,0,0,.16);
        }
        .mapwrap {
          position: relative; margin: 4px 12px 8px;
          border-radius: 14px; overflow: hidden;
          border: 1px solid var(--divider-color, rgba(0,0,0,.08));
          background: var(--secondary-background-color, #f6f5f2);
        }
        canvas { display: block; width: 100%; height: auto;
                 touch-action: none; cursor: crosshair; background: transparent; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
        .chips button {
          border: 1px solid transparent;
          background: rgba(127,127,127,.10); color: var(--primary-text-color, #333);
          border-radius: 999px; padding: 4px 11px; font: inherit; font-size: .78rem; cursor: pointer;
          max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          transition: background .15s ease, border-color .15s ease;
          user-select: none; -webkit-user-select: none;
        }
        .chips button.selected {
          background: color-mix(in srgb, var(--primary-color, #1e88e5) 20%, transparent);
          border-color: color-mix(in srgb, var(--primary-color, #1e88e5) 55%, transparent);
          color: var(--primary-text-color, #222);
          font-weight: 600;
        }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 12px 6px; align-items: center; }
        .actions button, .vactions button {
          border: 0; border-radius: 10px; height: 36px; padding: 0 14px;
          font: inherit; font-size: .82rem; font-weight: 500; cursor: pointer;
          background: var(--primary-color, #1e88e5); color: var(--primary-text-color, #fff);
          box-shadow: 0 1px 2px rgba(0,0,0,.18);
          transition: filter .15s ease, transform .06s ease;
          user-select: none; -webkit-user-select: none;
        }
        .actions button:not(:disabled):hover, .vactions button:not(:disabled):hover { filter: brightness(1.07); }
        .actions button:not(:disabled):active, .vactions button:not(:disabled):active { transform: translateY(1px); }
        .actions button.ghost, .vactions button.ghost {
          background: rgba(127,127,127,.12); color: var(--primary-text-color, #333); box-shadow: none;
        }
        .actions select, .vactions select {
          height: 36px; border-radius: 10px; padding: 0 8px; font: inherit; font-size: .82rem;
          border: 1px solid var(--divider-color, rgba(0,0,0,.15));
          background: var(--card-background-color, #fff); color: var(--primary-text-color, #333);
        }
        .vactions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 12px 10px; }
        .hint { font-size: .74rem; color: var(--secondary-text-color, #777); padding: 0 14px 8px; }
        .error { color: var(--error-color, #b3261e); font-size: .8rem; padding: 0 14px 8px; }
        .notice { color: var(--secondary-text-color, #777); font-size: .8rem; padding: 0 14px 8px; }
        .notice:empty { display: none; }
        .error:empty { display: none; }
        .meta { font-size: .68rem; letter-spacing: .02em; color: var(--secondary-text-color, #999); padding: 0 14px 10px; }
        button:focus-visible, select:focus-visible, canvas:focus-visible {
          outline: 2px solid var(--primary-color, #1e88e5); outline-offset: 2px;
        }
        @media (prefers-reduced-motion: reduce) {
          .toolbar button, .chips button, .actions button, .vactions button { transition: none; }
        }
      </style>
      <div class="header">
        <span class="hicon" aria-hidden="true"><ha-icon icon="mdi:robot-vacuum"></ha-icon></span>
        <span class="who">
          <span class="name"></span>
          <span class="sub">
            <span class="state"></span>
            <span class="battery"></span>
          </span>
        </span>
      </div>
      <div class="toolbar"></div>
      <div class="mapwrap"><canvas role="img" aria-label="Carte du robot"></canvas></div>
      <div class="chips"></div>
      <div class="actions"></div>
      <div class="vactions"></div>
      <div class="error"></div>
      <div class="notice"></div>
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
    // pas de zombies : les zones/points en attente n'appartiennent qu'à leur mode
    this._pendingZones = [];
    this._pendingPoints = [];
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
      b.title = b.textContent;
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
    const mkBtn = (label, fn, ghost, disabled) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (ghost) b.classList.add("ghost");
      b.disabled = !!disabled;
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
      }, false, !this._selectedRooms.size);
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
      mkBtn("Aller au point", () => this._gotoLast(), false, !this._pendingPoints.length);
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
      }, false, !this._pendingPoints.length);
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
    if (!this._hass || !this._config || !this.shadowRoot || !this.shadowRoot.querySelector) return;
    const st = this._hass.states ? this._hass.states[this._config.entity] : null;
    const nameEl = this.shadowRoot.querySelector(".header .name");
    const stEl = this.shadowRoot.querySelector(".header .state");
    const batEl = this.shadowRoot.querySelector(".header .battery");
    const errEl = this.shadowRoot.querySelector(".error");
    const noticeEl = this.shadowRoot.querySelector(".notice");
    const metaEl = this.shadowRoot.querySelector(".meta");
    if (nameEl) {
      nameEl.textContent =
        this._config.title ||
        (st && st.attributes && st.attributes.friendly_name) ||
        this._config.entity;
    }
    if (stEl) stEl.textContent = st ? FRENCH_VACUUM_STATE[st.state] || st.state : "";
    const canvasEl = this.shadowRoot.querySelector("canvas");
    if (canvasEl) {
      const who = this._config.title || (st && st.attributes && st.attributes.friendly_name) || this._config.entity;
      canvasEl.setAttribute("aria-label", `Carte du robot ${who}`);
    }
    if (batEl) {
      // batterie : l'attribut standard HA est battery_level, mais l'intégration
      // dreame-vacuum n'expose que battery (vérifié sur l'entité réelle)
      const a = st && st.attributes ? st.attributes : null;
      const raw = a && a.battery_level != null ? a.battery_level : a && a.battery != null ? a.battery : null;
      const bat = raw == null ? NaN : Math.round(Number(raw));
      batEl.textContent = "";
      if (Number.isFinite(bat)) {
        const pct = Math.max(0, Math.min(100, bat));
        const charging = st && st.state === "docked" && pct < 100;
        const step = Math.max(10, Math.round(pct / 10) * 10);
        const icon =
          charging ? `mdi:battery-charging-${Math.min(100, step)}`
          : pct >= 95 ? "mdi:battery"
          : `mdi:battery-${Math.max(10, Math.min(90, step))}`;
        const ic = document.createElement("ha-icon");
        ic.setAttribute("icon", icon);
        ic.style.color = pct <= 20 ? "#e53935" : pct <= 50 ? "#ef6c00" : "";
        const pctTxt = document.createElement("span");
        pctTxt.textContent = ` ${pct} %`;
        batEl.appendChild(ic);
        batEl.appendChild(pctTxt);
        batEl.title = charging ? `En charge — ${pct} %` : `Batterie ${pct} %`;
      }
    }
    if (errEl) {
      // rouge réservé aux VRAIES erreurs (échec réseau/rendu, entité absente)
      errEl.textContent = this._error
        ? `Carte : ${this._error}`
        : this._hass.states && !this._hass.states[this._config.camera]
        ? `Entité camera « ${this._config.camera} » introuvable. ` +
          "Active l'entité « Données cartographiques actuelles » de l'intégration (désactivée par défaut)."
        : "";
    }
    if (noticeEl) {
      // attente / carte vide = information neutre, pas une erreur
      let text = "";
      if (!this._error) {
        const camState = this._hass.states ? this._hass.states[this._config.camera] : null;
        if (camState && ["unavailable", "unknown"].includes(camState.state)) {
          text = `En attente de la première donnée de carte (caméra : « ${camState.state} »)…`;
        } else if (!this._geom) {
          text = "Carte vide ou indisponible pour le moment.";
        }
      }
      noticeEl.textContent = text;
    }
    if (metaEl) {
      const secs = Math.round((Date.now() - this._lastFetchAt) / 1000);
      metaEl.textContent = this._lastFetchAt ? `maj il y a ${Math.max(0, secs)}s` : "";
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
    const g = this._geom;
    if (!g) return;
    if (!this._pendingZones.length && !this._drag) return;
    const rects = [];
    for (const r of [...this._pendingZones, ...(this._drag ? [this._drag] : [])]) {
      rects.push(this._rectToVac(r));
    }
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
    // HiDPI : backing store multiplié par le devicePixelRatio, repère logique inchangé
    const dpr = Math.max(1, Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1));
    this._dpr = dpr;
    const W = Math.round(g.width * scale * dpr);
    const H = Math.round(g.height * scale * dpr);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const bg = parseCssColor(this._colors.background, [255, 255, 255]);
    ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // repère raster : x vers la droite, y vers le HAUT (origine en bas à gauche)
    ctx.setTransform(scale * dpr, 0, 0, -scale * dpr, 0, H);

    const floor = colorParts(this._colors.floor, [236, 233, 225]);
    const wall = colorParts(this._colors.wall, [154, 160, 166]);
    const obstacle = colorParts(this._colors.obstacle, [92, 99, 110]);

    for (const key of Object.keys(g.layers)) {
      const layer = Number(key);
      // segment caché (visibility=false) : jamais dessiné, comme le renderer officiel
      if (g.hiddenSegments && g.hiddenSegments.has(layer)) continue;
      const runs = g.layers[key];
      if (layer === LAYER.FLOOR) {
        this._paintRuns(ctx, runs, floor[0], floor[1], floor[2], 1);
      } else if (layer >= LAYER.SEGMENT_MIN && layer <= LAYER.SEGMENT_MAX) {
        const rgb = colorParts(g.segmentColor(layer), [200, 210, 220]);
        this._paintRuns(ctx, runs, rgb[0], rgb[1], rgb[2], 1);
      } else if (layer >= LAYER.OUTLINE_MIN && layer <= LAYER.OUTLINE_MAX) {
        this._paintRuns(ctx, runs, wall[0], wall[1], wall[2], 1, 0.25, 1.5);
      } else if (layer === LAYER.WALL) {
        this._paintRuns(ctx, runs, wall[0], wall[1], wall[2], 1, 0.25, 1.5);
      } else if (layer === LAYER.OBSTACLE_WALL) {
        this._paintRuns(ctx, runs, obstacle[0], obstacle[1], obstacle[2], 1);
      }
      // OUTSIDE(0), wifi(2..14), 249/250/252/253 : ignorés, sémantique non applicable
    }

    // surbrillance : segments actifs (robot en cours) et sélection
    const hi = (ids, rgb, a) => {
      for (const id of ids) {
        const runs = g.layers[id];
        if (runs) this._paintRuns(ctx, runs, rgb[0], rgb[1], rgb[2], a);
      }
    };
    const actC = colorParts(this._colors.activeSegment, [30, 136, 229]);
    const selC = colorParts(this._colors.selectedSegment, [255, 152, 0]);
    hi(g.activeSegments || [], actC, 0.45);
    hi([...this._selectedRooms], selC, 0.45);

    // vecteurs
    this._drawQuads(ctx, g);
    this._drawVirtualWalls(ctx, g);
    this._drawZonesAndPoints(ctx, g);
    this._drawPath(ctx, g);
    this._drawMarkers(ctx, g);

    // repasse en pixels écran (logiques) pour les libellés (pas de texte dans le repère inversé)
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    if (this._config.show_room_labels !== false && g.width >= 40) {
      this._drawRoomLabels(ctx, g);
      this._drawDeviceLabels(ctx, g);
    }
  }

  /** peint une couche de runs : [x, y, n, ...] ; y en unités raster.
   * yPad/hMul : extension verticale (murs plus épais). */
  _paintRuns(ctx, runs, r, gr, b, a, yPad = 0, hMul = 1) {
    if (!runs || !runs.length) return;
    ctx.fillStyle = a >= 1 ? `rgb(${r | 0},${gr | 0},${b | 0})` : `rgba(${r | 0},${gr | 0},${b | 0},${a})`;
    for (let i = 0; i + 2 < runs.length; i += 3) {
      if (yPad || hMul !== 1) ctx.fillRect(runs[i], runs[i + 1] - yPad, runs[i + 2], hMul);
      else ctx.fillRect(runs[i], runs[i + 1], runs[i + 2], 1);
    }
  }

  _drawQuads(ctx, g) {
    const conv = (v) => g.vacToPixel(v[0], v[1]);
    for (const area of g.activeAreas || []) {
      this._strokeQuad(ctx, area.slice(0, 8).map(Number), this._colors.activeArea, this._colors.activeAreaStroke, conv);
    }
    for (const c of g.carpets || []) {
      if (Array.isArray(c) && c.length >= 8) {
        this._strokeQuad(ctx, c.slice(0, 8).map(Number), this._colors.carpet, this._colors.carpetStroke, conv, true);
      }
    }
    for (const z of g.noGo || []) {
      this._strokeQuad(ctx, z.slice(0, 8).map(Number), this._colors.noGo, this._colors.virtualWall, conv);
    }
    for (const z of g.noMop || []) {
      if (Array.isArray(z) && z.length >= 10 && Number(z[9]) === 1) continue; // cachée
      this._strokeQuad(ctx, z.slice(0, 8).map(Number), this._colors.noMop, "#aa2fff", conv);
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
    ctx.strokeStyle = this._colors.virtualWall;
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
      ctx.fillStyle = this._colors.pendingZone;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = this._colors.pendingZoneStroke;
      ctx.strokeRect(x, y, w, h);
    }
    ctx.fillStyle = this._colors.point;
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
      this._colors.path,          // S   : trajectoire principale
      this._colors.pathMove,      // W
      this._colors.pathMove,      // M
    ];
    ctx.lineWidth = 0.7;
    for (const entry of g.path) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const color = styles[entry[0]] || this._colors.pathMove;
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
    const robotPx = g.robot && g.robot.length >= 2
      ? g.vacToPixel(Number(g.robot[0]), Number(g.robot[1])) : null;
    const chargerPx = g.charger && g.charger.length >= 2
      ? g.vacToPixel(Number(g.charger[0]), Number(g.charger[1])) : null;
    // robot et base au même endroit (docké) : un seul marqueur combiné
    const overlapped = robotPx && chargerPx &&
      Math.hypot(robotPx[0] - chargerPx[0], robotPx[1] - chargerPx[1]) < 5;

    // chargeur
    if (chargerPx && !overlapped) {
      const [cx, cy] = chargerPx;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, 3), 0, Math.PI * 2);
      ctx.fillStyle = this._colors.charger;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 0.5;
      ctx.stroke();
      if (g.charger[2] != null && !Number.isNaN(Number(g.charger[2]))) {
        const a = ((90 - Number(g.charger[2])) % 360 + 360) % 360;
        const rad = (a * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(rad) * 6, cy - Math.sin(rad) * 6);
        ctx.strokeStyle = this._colors.charger;
        ctx.stroke();
      }
    }
    // robot
    if (robotPx) {
      const [rx, ry] = robotPx;
      if (overlapped) {
        // anneau vert de la base autour du robot docké
        ctx.beginPath();
        ctx.arc(rx, ry, Math.max(3.4, 4.8), 0, Math.PI * 2);
        ctx.strokeStyle = this._colors.charger;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      const a = g.robot[2] != null ? ((90 - Number(g.robot[2])) % 360 + 360) % 360 : null;
      ctx.beginPath();
      ctx.arc(rx, ry, Math.max(2, 3.4), 0, Math.PI * 2);
      ctx.fillStyle = this._colors.robot;
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
        ctx.strokeStyle = this._colors.robot;
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }
    }
  }

  /** étiquettes des pièces (repère écran). */
  _drawRoomLabels(ctx, g) {
    const scale = this._scale;
    ctx.font = `${Math.max(9, Math.round(scale * 2.6))}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = this._colors.label;
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
    const robotPx = g.robot && g.robot.length >= 2
      ? g.vacToPixel(Number(g.robot[0]), Number(g.robot[1])) : null;
    const chargerPx = g.charger && g.charger.length >= 2
      ? g.vacToPixel(Number(g.charger[0]), Number(g.charger[1])) : null;
    const overlapped = robotPx && chargerPx &&
      Math.hypot(robotPx[0] - chargerPx[0], robotPx[1] - chargerPx[1]) < 5;
    if (robotPx) {
      ctx.fillText("🤖", robotPx[0] * scale, (g.height - robotPx[1]) * scale);
    }
    if (chargerPx && !overlapped) {
      ctx.fillText("⚡", chargerPx[0] * scale, (g.height - chargerPx[1]) * scale - scale * 2);
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

/* ------------------------------------------------------------------ *
 * Éditeur visuel (GUI editor)
 * ------------------------------------------------------------------ */
const EDITOR_MANAGED_KEYS = new Set([
  "entity", "camera", "title", "update_interval",
  "controls", "room_cleaning", "zone_cleaning", "goto", "follow_path",
  "show_room_labels", "debug",
]);

class DreameOpenMapCardEditor extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._config = {};
    this._inputs = {};
    this._built = false;
    if (this.attachShadow) this.attachShadow({ mode: "open" });
  }

  set hass(h) {
    this._hass = h;
    if (this._built) this._fillDatalists();
  }
  get hass() { return this._hass; }

  setConfig(config) {
    this._config = config && typeof config === "object" ? { ...config } : {};
    if (this._built) this._loadValues();
    else this._build();
  }

  connectedCallback() {
    if (!this._built) this._build();
  }

  focus() {
    const first = this.shadowRoot && this.shadowRoot.querySelector("input");
    if (first && typeof first.focus === "function") first.focus();
  }

  _build() {
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: block; color: var(--primary-text-color, #111); }
        .rows { display: flex; flex-direction: column; gap: 10px; }
        .row { display: flex; flex-direction: column; gap: 4px; }
        .row > label { font-size: .8rem; font-weight: 600; }
        .row input[type="text"], .row input[type="number"] {
          width: 100%; box-sizing: border-box;
          border: 1px solid var(--divider-color, rgba(0,0,0,.2));
          border-radius: 8px; padding: 8px 10px;
          font: inherit; font-size: .9rem;
          color: var(--primary-text-color, #111);
          background: var(--card-background-color, #fff);
        }
        input:focus-visible { outline: 2px solid var(--primary-color, #1e88e5); outline-offset: 1px; }
        .toggles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 14px; }
        @media (min-width: 700px) { .toggles { grid-template-columns: repeat(3, 1fr); } }
        .tg { display: flex; align-items: center; gap: 8px; font-size: .85rem; cursor: pointer; }
        .tg input { accent-color: var(--primary-color, #1e88e5); }
        .note { font-size: .75rem; color: var(--secondary-text-color, #777); }
      </style>
      <div class="rows">
        <div class="row">
          <label for="f-entity">Aspirateur (vacuum.*)</label>
          <input id="f-entity" type="text" list="dl-vacuum" placeholder="vacuum.mon_dreame" autocomplete="off">
        </div>
        <div class="row">
          <label for="f-camera">Caméra « Données cartographiques actuelles » (camera.*)</label>
          <input id="f-camera" type="text" list="dl-camera" placeholder="camera.mon_dreame_map_data" autocomplete="off">
        </div>
        <div class="row">
          <label for="f-title">Titre (optionnel)</label>
          <input id="f-title" type="text" placeholder="D9 Max — carte interactive">
        </div>
        <div class="row">
          <label for="f-interval">Rafraîchissement de base en s (1–120, défaut 5)</label>
          <input id="f-interval" type="number" min="1" max="120" step="1" placeholder="5">
        </div>
        <div class="row">
          <label>Affichages et modes</label>
          <div class="toggles">
            <label class="tg"><input id="f-controls" type="checkbox" checked> Boutons aspirateur</label>
            <label class="tg"><input id="f-rooms" type="checkbox" checked> Nettoyage par pièces</label>
            <label class="tg"><input id="f-zone" type="checkbox" checked> Nettoyage de zone</label>
            <label class="tg"><input id="f-goto" type="checkbox" checked> Aller à</label>
            <label class="tg"><input id="f-follow" type="checkbox"> Suivre un chemin</label>
            <label class="tg"><input id="f-labels" type="checkbox" checked> Noms des pièces sur la carte</label>
            <label class="tg"><input id="f-debug" type="checkbox"> Debug (détails d'erreur)</label>
          </div>
        </div>
        <div class="note">Couleurs avancées (colors, segment_colors) : à régler en mode YAML — voir le README.</div>
        <datalist id="dl-vacuum"></datalist>
        <datalist id="dl-camera"></datalist>
      </div>
    `;
    const bind = (id) => {
      const el = root.querySelector("#" + id);
      this._inputs[id] = el;
      if (el) {
        el.addEventListener("input", () => this._emit());
        el.addEventListener("change", () => this._emit());
      }
    };
    ["entity", "camera", "title", "interval", "controls", "rooms", "zone", "goto", "follow", "labels", "debug"]
      .forEach((id) => bind("f-" + id));
    this._built = true;
    this._loadValues();
    this._fillDatalists();
  }

  _loadValues() {
    const c = this._config || {};
    // ne pas écraser le champ en cours d'édition (HA reçoit config-changed et
    // rappelle setConfig après chaque frappe)
    const ae = typeof document !== "undefined" && document.activeElement ? document.activeElement : null;
    const skipIfFocused = (el) => ae && el === ae;
    const set = (id, v) => {
      const el = this._inputs[id];
      if (el && !skipIfFocused(el)) el.value = v;
    };
    set("f-entity", c.entity != null ? String(c.entity) : "");
    set("f-camera", c.camera != null ? String(c.camera) : "");
    set("f-title", c.title != null ? String(c.title) : "");
    if (c.update_interval != null) set("f-interval", String(c.update_interval));
    const chk = (id, v) => { const el = this._inputs[id]; if (el) el.checked = !!v; };
    chk("f-controls", c.controls !== false);
    chk("f-rooms", c.room_cleaning !== false);
    chk("f-zone", c.zone_cleaning !== false);
    chk("f-goto", c.goto !== false);
    chk("f-follow", c.follow_path === true);
    chk("f-labels", c.show_room_labels !== false);
    chk("f-debug", c.debug === true);
  }

  _fillDatalists() {
    const states = this._hass && this._hass.states ? this._hass.states : null;
    const root = this.shadowRoot;
    if (!states || !root) return;
    const keys = Object.keys(states).sort();
    const vac = keys.filter((k) => k.startsWith("vacuum."));
    const cam = keys.filter((k) => k.startsWith("camera."));
    // garde anti-churn : hass est poussé une fois par seconde, ne pas reconstruire
    const sig = vac.length + "|" + (vac[vac.length - 1] || "") + "#" + cam.length + "|" + (cam[cam.length - 1] || "");
    if (this._dlSig === sig) return;
    this._dlSig = sig;
    const fill = (id, list) => {
      const dl = root.querySelector("#" + id);
      if (!dl) return;
      dl.innerHTML = "";
      for (const v of list.slice(0, 300)) {
        const o = document.createElement("option");
        o.value = v;
        dl.append(o);
      }
    };
    fill("dl-vacuum", vac);
    fill("dl-camera", cam);
  }

  _buildConfig() {
    // préserve tout ce que l'éditeur ne gère pas : `type`, colors, segment_colors,
    // et toute clé ajoutée en YAML — seuls les champs gérés sont réécrits
    const src = this._config && typeof this._config === "object" ? this._config : {};
    const out = {};
    for (const k of Object.keys(src)) {
      if (!EDITOR_MANAGED_KEYS.has(k)) out[k] = src[k];
    }
    const val = (id) => {
      const el = this._inputs[id];
      return el ? String(el.value || "").trim() : "";
    };
    const entity = val("f-entity");
    const camera = val("f-camera");
    const title = val("f-title");
    if (entity) out.entity = entity;
    if (camera) out.camera = camera;
    if (title) out.title = title;
    const iv = parseInt(val("f-interval"), 10);
    if (Number.isFinite(iv) && iv !== 5) {
      out.update_interval = Math.max(1, Math.min(120, iv));
    }
    const ch = (id) => !!(this._inputs[id] && this._inputs[id].checked);
    // les options fausses par défaut ne sont écrites que quand cochées ;
    // les vraies par défaut ne sont écrites que quand décochées
    if (!ch("f-controls")) out.controls = false;
    if (!ch("f-rooms")) out.room_cleaning = false;
    if (!ch("f-zone")) out.zone_cleaning = false;
    if (!ch("f-goto")) out.goto = false;
    if (!ch("f-labels")) out.show_room_labels = false;
    if (ch("f-follow")) out.follow_path = true;
    if (ch("f-debug")) out.debug = true;
    return out;
  }

  _emit() {
    const config = this._buildConfig();
    try {
      this.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      }));
    } catch (e) {
      /* environnement sans CustomEvent : rien à propager */
    }
  }
}

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
  if (typeof customElements !== "undefined" && !customElements.get("dreame-open-map-card-editor")) {
    customElements.define("dreame-open-map-card-editor", DreameOpenMapCardEditor);
  }
}

/* export volontairement absent : sans import ni export, ce fichier est
 * chargeable comme ressource « JavaScript Module » ET « JavaScript Legacy ». */