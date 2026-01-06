import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import * as L from "leaflet";
import JSZip from "jszip";
import { z } from "zod";
import { useAppStore } from "../state/store";
import { ConfigSchema, PoiSchema, CategorySchema, type Poi, type Category } from "../lib/schema";
import { parseCategoriesFromCsv, parsePoisFromCsv, exampleCategoriesCsv, examplePoisCsv } from "../lib/csv";
import { validateAll } from "../lib/validation";
import { DropZone } from "../components/DropZone";
import { MapView } from "../components/MapView";
import { DetailsModal } from "../components/DetailsModal";
import { QrModal } from "../components/QrModal";
import { compressImage, guessImagePath } from "../lib/image";
import { exportContentZip, exportSiteZip, downloadBlob, type ThemePreset } from "../lib/export";
import { pickPoiName, pickCategoryLabel } from "../lib/contentText";
import { t, langLabel, type UiLang } from "../lib/i18n";
import { publicUrl } from "../lib/publicUrl";

const nextSequentialPoiId = (pois: { id: string }[]): string => {
  let max = 0;
  for (const p of pois) {
    const s = String(p.id ?? "");
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      if (n > max) max = n;
    }
  }
  return String(max + 1);
};


type Step = 0 | 1 | 2 | 3 | 4;
type EditorMode = "easy" | "csv";
type MarkerType = Category["markerType"];

const MARKER_TYPES: MarkerType[] = ["pin", "dot", "badge", "ring", "square", "hex", "flag"];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
function round6(v: number): number {
  return Math.round(v * 1000000) / 1000000;
}

function csvEscape(v: string): string {
  const s = String(v ?? "");
  if (/[\n\r,\"]/g.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function poisToCsv(pois: Poi[], cfgSupportedLangs: string[], defaultLang: string): string {
  const extra = cfgSupportedLangs.filter(l => l !== defaultLang);
  const headers = [
    "id",
    "name",
    "description",
    ...extra.map(l => `name_${l}`),
    ...extra.map(l => `description_${l}`),
    "category",
    "image",
    "lat",
    "lng",
    "x",
    "y",
    "url",
    "hours",
    "closed"
  ];
  const rows = pois.map(p => {
    const cols: string[] = [];
    cols.push(p.id ?? "");
    cols.push(p.name ?? "");
    cols.push(p.description ?? "");
    for (const l of extra) cols.push((p.nameI18n ?? {})[l] ?? "");
    for (const l of extra) cols.push((p.descriptionI18n ?? {})[l] ?? "");
    cols.push(p.category ?? "");
    cols.push(p.image ?? "");
    cols.push(p.lat !== undefined ? String(p.lat) : "");
    cols.push(p.lng !== undefined ? String(p.lng) : "");
    cols.push(p.x !== undefined ? String(p.x) : "");
    cols.push(p.y !== undefined ? String(p.y) : "");
    cols.push(p.url ?? "");
    cols.push((p as any).hours ?? "");
    cols.push((p as any).closed ?? "");
    return cols.map(csvEscape).join(",");
  });
  return [headers.join(","), ...rows].join("\n");
}

function categoriesToCsv(cats: Category[], cfgSupportedLangs: string[], defaultLang: string): string {
  const extra = cfgSupportedLangs.filter(l => l !== defaultLang);
  const headers = [
    "category",
    "label",
    ...extra.map(l => `label_${l}`),
    "icon",
    "order",
    "markerType",
    "markerColor"
  ];
  const rows = cats.map(c => {
    const cols: string[] = [];
    cols.push(c.category ?? "");
    cols.push(c.label ?? "");
    for (const l of extra) cols.push((c.labelI18n ?? {})[l] ?? "");
    cols.push(c.icon ?? "");
    cols.push(c.order !== undefined ? String(c.order) : "");
    cols.push((c.markerType ?? "") as any);
    cols.push(c.markerColor ?? "");
    return cols.map(csvEscape).join(",");
  });
  return [headers.join(","), ...rows].join("\n");
}

function ensureDefaultCategory(uiLang: UiLang, cats: Category[]): Category[] {
  if (cats.length) return cats;
  return [{
    category: "general",
    label: uiLang === "ja" ? "一般" : "General",
    labelI18n: { ja: "一般", en: "General" },
    icon: "📍",
    order: 1,
    markerType: "pin",
    markerColor: "#6ea8fe"
  }];
}



function hashString(s: string): string {
  // fast non-crypto hash (djb2-ish) for UI state tracking
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

export function BuilderPage() {
  const loc = useLocation();
  const importFlow = useMemo(() => {
    try {
      const sp = new URLSearchParams(loc.search);
      return sp.get("mode") === "import";
    } catch {
      return false;
    }
  }, [loc.search]);

  const {
    isLoaded,
    loadFromPublic,

    builderConfig,
    builderPois,
    builderCategories,
    builderAssets,

    setBuilderConfig,
    setBuilderData,
    updateBuilderPoi,

    setBuilderAsset,
    removeBuilderAsset,

    previewBuilder,

    uiLang,
    setUiLang,
    contentLang,
    setContentLang,

    builderUndo,

    undoBuilder,


    builderEpoch,
  } = useAppStore(s => ({
    isLoaded: s.isLoaded,
    loadFromPublic: s.loadFromPublic,

    builderConfig: s.builderConfig,
    builderPois: s.builderPois,
    builderCategories: s.builderCategories,
    builderAssets: s.builderAssets,

    setBuilderConfig: s.setBuilderConfig,
    setBuilderData: s.setBuilderData,
    updateBuilderPoi: s.updateBuilderPoi,

    setBuilderAsset: s.setBuilderAsset,
    removeBuilderAsset: s.removeBuilderAsset,

    previewBuilder: s.previewBuilder,

    uiLang: s.uiLang,
    setUiLang: s.setUiLang,
    contentLang: s.contentLang,
    setContentLang: s.setContentLang,

    builderUndo: s.builderUndo,

    undoBuilder: s.undoBuilder,


    builderEpoch: s.builderEpoch,
  }));


const canUndo = !!builderUndo;
const [undoTick, setUndoTick] = useState(0);

const onUndo = useCallback(() => {
  if (!canUndo) return;
  undoBuilder();
  setUndoTick((v) => v + 1);
}, [canUndo, undoBuilder]);

  const [step, setStep] = useState<Step>(() => (importFlow ? 0 : 1));
  // Step3 has two sub-views: map preview and issue list
  const [previewTab, setPreviewTab] = useState<"map" | "issues">("map");
  const [editorMode, setEditorMode] = useState<EditorMode>("easy");

  // Keep step in sync when switching between normal / import flow.
  useEffect(() => {
    if (importFlow) {
      setStep(0);
    } else {
      setStep((s) => (s === 0 ? 1 : s));
    }
  }, [importFlow]);

  // When a new map is started, reset local UI state (step, tabs, etc.)
  useEffect(() => {
    setStep(importFlow ? 0 : 1);
    setPreviewTab("map");
    setEditorMode("easy");

    // reset import state
    setImportState("idle");
    setImportError("");
    setImportedName("");

    // reset CSV apply state tracking
    setCsvApplyState("idle");
    csvBaselineRef.current = "";
    csvEverApplied.current = false;
    baselineInitOnce.current = false;
  }, [builderEpoch, importFlow]);

  type ApplyState = "idle" | "pending" | "applied";
  const [csvApplyState, setCsvApplyState] = useState<ApplyState>("idle");

  // Warn users before reloading/closing the tab when there are edits that are not applied to CSV.
  // (Modern browsers show a generic confirmation message; the custom string may be ignored.)
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (csvApplyState !== "pending") return;
      e.preventDefault();
      // Some browsers require returnValue to be set.
      e.returnValue = t(uiLang, "reload_warn_unsaved");
      return e.returnValue;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [csvApplyState, uiLang]);

  const csvBaselineRef = useRef<string>("");
  const csvEverApplied = useRef(false);
  const baselineInitOnce = useRef(false);

  const builderHash = useMemo(() => {
    if (!builderConfig) return "";
    const cfg = builderConfig as any;
    const cfgKey = JSON.stringify({
      mode: cfg.mode,
      theme: cfg.theme,
      i18n: cfg.i18n,
      title: cfg.title,
      subtitle: cfg.subtitle,
      titleI18n: cfg.titleI18n,
      subtitleI18n: cfg.subtitleI18n,
      indoor: cfg.indoor,
      outdoor: cfg.outdoor,
    });
    const poisKey = JSON.stringify(builderPois);
    const catsKey = JSON.stringify(builderCategories);
    const assetsKey = JSON.stringify({
      floor: builderAssets.floorFile ? builderAssets.floorFile.name : "",
      images: Object.keys(builderAssets.images || {}).sort(),
    });
    return hashString(cfgKey + "|" + poisKey + "|" + catsKey + "|" + assetsKey);
  }, [builderConfig, builderPois, builderCategories, builderAssets]);

  // Keep button state in sync with whether the current edits are already reflected in the CSV text.
  useEffect(() => {
    if (!builderConfig) return;
    if (!baselineInitOnce.current) {
      baselineInitOnce.current = true;
      csvBaselineRef.current = builderHash;
      setCsvApplyState("idle");
      return;
    }

    if (builderHash !== csvBaselineRef.current) {
      if (csvApplyState !== "pending") setCsvApplyState("pending");
    } else if (csvApplyState === "pending") {
      setCsvApplyState(csvEverApplied.current ? "applied" : "idle");
    }
  }, [builderConfig, builderHash, csvApplyState]);

  const [poisCsv, setPoisCsv] = useState<string>("");
  const [catsCsv, setCatsCsv] = useState<string>("");

  const [activeCategory, setActiveCategory] = useState<string>("");
  const [query, setQuery] = useState<string>("");

  const [selectedPoiId, setSelectedPoiId] = useState<string>("");
  const [selectedCatKey, setSelectedCatKey] = useState<string>("");

  // Easy editor: allow editing POI ID safely (unique)
  const [poiIdDraft, setPoiIdDraft] = useState<string>("");
  const [poiIdError, setPoiIdError] = useState<string>("");

  const [picked, setPicked] = useState<Poi | null>(null);
  const [qrOpen, setQrOpen] = useState(false);

  // Import flow
  const [importOk, setImportOk] = useState(false);
  const [importMsg, setImportMsg] = useState<string>("");
  // Publish (step 4): color template for the full site zip
  const [publishTheme, setPublishTheme] = useState<ThemePreset>("blue");

  // Apply selected publish color template as a live preview (affects Viewer as well).
  useEffect(() => {
    const map: Record<string, string> = {
      blue: "#6ea8fe",
      green: "#2fd4a3",
      orange: "#ffb020",
      purple: "#b39ddb",
      red: "#ff6b6b",
    };
    const accent = map[publishTheme] || map.blue;
    document.documentElement.style.setProperty("--accent", accent);
    return () => {
      document.documentElement.style.removeProperty("--accent");
    };
  }, [publishTheme]);

  // Local preview URLs for uploaded images (so changes are visible immediately)
  const [floorPreviewUrl, setFloorPreviewUrl] = useState<string>("");
  const [imagePreviewUrls, setImagePreviewUrls] = useState<Record<string, string>>({});

  // indoor position picking
  const [pickPos, setPickPos] = useState(false);
  const [addOnMapClick, setAddOnMapClick] = useState(false);

  // Import (edit exported zip) state
  const [importState, setImportState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [importError, setImportError] = useState<string>("");
  const [importedName, setImportedName] = useState<string>("");

  const clearAllBuilderAssets = useCallback(() => {
    if (builderAssets.floorFile) removeBuilderAsset("floor", "");
    for (const k of Object.keys(builderAssets.images)) {
      removeBuilderAsset("image", k);
    }
  }, [builderAssets, removeBuilderAsset]);

  const importZipIntoBuilder = useCallback(async (file: File) => {
    if (!window.confirm(t(uiLang, "confirm_overwrite"))) return;
    setImportError("");
    setImportState("loading");
    setImportedName(file.name);

    const zip = await JSZip.loadAsync(file);
    const paths = Object.keys(zip.files).filter(p => !zip.files[p].dir && !p.startsWith("__MACOSX/"));
    const cfgPath = paths.find(p => p.endsWith("data/config.json"));
    if (!cfgPath) throw new Error("data/config.json が見つかりませんでした（site.zip / content-pack.zip を選んでください）");
    const prefix = cfgPath.slice(0, cfgPath.length - "data/config.json".length);

    async function readJson<T>(rel: string): Promise<T> {
      const p = prefix + rel;
      const f = zip.file(p);
      if (!f) throw new Error(`${rel} が見つかりませんでした`);
      const txt = await f.async("text");
      return JSON.parse(txt) as T;
    }

    const rawCfg = await readJson<any>("data/config.json");
    const rawPois = await readJson<any>("data/pois.json");
    const rawCats = await readJson<any>("data/categories.json");

    const nextCfg = ConfigSchema.parse(rawCfg);
    const nextPois = z.array(PoiSchema).parse(rawPois);
    const nextCats = z.array(CategorySchema).parse(rawCats);

    // Replace working data
    setBuilderConfig(nextCfg);
    setBuilderData(nextPois, nextCats);

    // Replace assets (floor + images)
    clearAllBuilderAssets();

    const floorUrl = nextCfg.mode === "indoor" ? (nextCfg.indoor?.imageUrl || "") : "";
    const floorPath = floorUrl.replace(/^\//, "");
    if (floorPath) {
      const floorEntry = zip.file(prefix + floorPath);
      if (floorEntry) {
        const blob = await floorEntry.async("blob");
        const name = floorPath.split("/").pop() || "floor.png";
        const floorFile = new File([blob], name, { type: (blob as any).type || "image/png" });
        setBuilderAsset("floor", floorUrl, floorFile);
      }
    }

    const imageEntries = paths.filter(p => p.startsWith(prefix + "images/"));
    for (const p of imageEntries) {
      const entry = zip.file(p);
      if (!entry) continue;
      const blob = await entry.async("blob");
      const name = p.split("/").pop() || "image";
      const key = "/" + p.slice(prefix.length);
      const imgFile = new File([blob], name, { type: (blob as any).type || "" });
      setBuilderAsset("image", key, imgFile);
    }

    // Set language to the imported map default
    setContentLang(nextCfg.i18n.defaultLang);
    setUiLang(nextCfg.i18n.defaultLang.toLowerCase().startsWith("en") ? "en" : "ja");

    previewBuilder();
    setImportState("done");
  }, [uiLang, setBuilderConfig, setBuilderData, clearAllBuilderAssets, setBuilderAsset, setContentLang, setUiLang, previewBuilder]);

  // Initialize from public sample data only when there is no working draft.
  // This prevents accidental resets when switching between "見る" and "作る".
  useEffect(() => {
    if (builderConfig) return;
    if (isLoaded) return;
    loadFromPublic().catch(() => {});
  }, [builderConfig, isLoaded, loadFromPublic]);

  // Initialize csv strings when builder data first becomes available
  useEffect(() => {
    if (!builderConfig) return;
    const supported = builderConfig.i18n?.supportedLangs ?? ["ja", "en"];
    const def = builderConfig.i18n?.defaultLang ?? "ja";
    setPoisCsv(poisToCsv(builderPois, supported, def));
    setCatsCsv(categoriesToCsv(builderCategories, supported, def));
  }, [builderConfig]); // only once per config load

  const cfg = builderConfig;
  const supportedLangs = cfg?.i18n?.supportedLangs ?? ["ja", "en"];
  const defaultLang = cfg?.i18n?.defaultLang ?? "ja";
  const effectiveContentLang = contentLang || defaultLang;

  // Create / revoke object URLs for immediate preview of uploaded assets
  useEffect(() => {
    if (!builderAssets.floorFile) { setFloorPreviewUrl(""); return; }
    const url = URL.createObjectURL(builderAssets.floorFile);
    setFloorPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [builderAssets.floorFile]);

  // Auto-detect indoor floor image size from the uploaded file
  useEffect(() => {
    if (!cfg || cfg.mode !== "indoor") return;
    if (!floorPreviewUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = (img as any).naturalWidth || img.width;
      const h = (img as any).naturalHeight || img.height;
      if (!w || !h) return;
      if (cfg.indoor.imageWidthPx === w && cfg.indoor.imageHeightPx === h) return;
      setBuilderConfig({ ...cfg, indoor: { ...cfg.indoor, imageWidthPx: w, imageHeightPx: h } });
    };
    img.src = floorPreviewUrl;
    return () => { cancelled = true; };
  }, [cfg?.mode, cfg?.indoor?.imageWidthPx, cfg?.indoor?.imageHeightPx, floorPreviewUrl, setBuilderConfig]);


  useEffect(() => {
    const entries = Object.entries(builderAssets.images ?? {});
    if (!entries.length) { setImagePreviewUrls({}); return; }
    const next: Record<string, string> = {};
    for (const [k, f] of entries) {
      try { next[k] = URL.createObjectURL(f); } catch {}
    }
    setImagePreviewUrls(next);
    return () => {
      for (const u of Object.values(next)) {
        try { URL.revokeObjectURL(u); } catch {}
      }
    };
  }, [builderAssets.images]);

  // Keep the preset selector in sync with current indoor image size (optional UI sugar)

  const issues = useMemo(() => (cfg ? validateAll(cfg, builderPois, builderCategories) : []), [cfg, builderPois, builderCategories]);
  const hasError = issues.some(i => i.level === "error");

  const canNext3 = !!cfg && !hasError;
  const canNext4 = canNext3;

  // Always keep a valid selectedPoiId if possible
  useEffect(() => {
    if (!builderPois.length) { setSelectedPoiId(""); return; }
    if (!selectedPoiId) { setSelectedPoiId(builderPois[0].id); return; }
    if (!builderPois.some(p => p.id === selectedPoiId)) setSelectedPoiId(builderPois[0].id);
  }, [builderPois, selectedPoiId]);

  // Keep POI category non-empty (beginner safety)
  useEffect(() => {
    if (!selectedPoiId) return;
    const p = builderPois.find(pp => pp.id === selectedPoiId);
    if (!p) return;
    if (p.category) return;
    const cats = ensureDefaultCategory(uiLang, builderCategories);
    if (!builderCategories.length) {
      setBuilderData(builderPois, cats);
      setCatsCsv(categoriesToCsv(cats, supportedLangs, defaultLang));
    }
    updateBuilderPoi({ ...p, category: cats[0].category });
  }, [selectedPoiId, builderPois, builderCategories, uiLang, setBuilderData, setCatsCsv, supportedLangs, defaultLang, updateBuilderPoi]);

  const selectedPoi = useMemo(() => builderPois.find(p => p.id === selectedPoiId) ?? null, [builderPois, selectedPoiId]);
  const selectedCat = useMemo(() => builderCategories.find(c => c.category === selectedCatKey) ?? null, [builderCategories, selectedCatKey]);

  // Keep the POI id draft input in sync when selection changes
  useEffect(() => {
    if (!selectedPoiId) { setPoiIdDraft(""); setPoiIdError(""); return; }
    const p = builderPois.find(pp => pp.id === selectedPoiId);
    if (!p) return;
    setPoiIdDraft(p.id);
    setPoiIdError("");
  }, [selectedPoiId, builderPois]);

  const imageChoices = useMemo(() => {
    const set = new Set<string>();
    for (const k of Object.keys(builderAssets.images ?? {})) set.add(k);
    for (const p of builderPois) if (p.image) set.add(p.image);
    return Array.from(set).sort();
  }, [builderAssets.images, builderPois]);

  const applyCsv = useCallback(() => {
    if (!cfg) return;
    const nextPois = parsePoisFromCsv(poisCsv);
    let nextCats = parseCategoriesFromCsv(catsCsv);

    nextCats = ensureDefaultCategory(uiLang, nextCats);
    // Ensure every POI has a category
    const catKey = nextCats[0]?.category ?? "general";
    const fixedPois = nextPois.map(p => ({ ...p, category: p.category || catKey }));

    setBuilderData(fixedPois, nextCats);
    // normalize csv view to canonical form
    setPoisCsv(poisToCsv(fixedPois, supportedLangs, defaultLang));
    setCatsCsv(categoriesToCsv(nextCats, supportedLangs, defaultLang));
  }, [cfg, poisCsv, catsCsv, setBuilderData, uiLang, supportedLangs, defaultLang]);

  const updatePoi = useCallback((id: string, patch: Partial<Poi>) => {
    if (!cfg) return;
    const nextPois = builderPois.map(p => p.id === id ? { ...p, ...patch } : p);
    setBuilderData(nextPois, builderCategories);
    setPoisCsv(poisToCsv(nextPois, supportedLangs, defaultLang));
  }, [cfg, builderPois, builderCategories, setBuilderData, supportedLangs, defaultLang]);

  const commitPoiId = useCallback(() => {
    if (!cfg) return;
    if (!selectedPoi) return;

    const oldId = selectedPoi.id;
    const nextId = (poiIdDraft || "").trim();
    if (!nextId) {
      setPoiIdError(uiLang === "ja" ? "IDを入力してください" : "Please enter an ID.");
      setPoiIdDraft(oldId);
      return;
    }
    if (nextId === oldId) return;
    if (builderPois.some(p => p.id === nextId)) {
      setPoiIdError(uiLang === "ja" ? "このIDはすでに使われています" : "This ID is already in use.");
      setPoiIdDraft(oldId);
      return;
    }

    const nextPois = builderPois.map(p => (p.id === oldId ? { ...p, id: nextId } : p));
    setBuilderData(nextPois, builderCategories);
    setPoisCsv(poisToCsv(nextPois, supportedLangs, defaultLang));
    setSelectedPoiId(nextId);
    setPoiIdError("");

    // Avoid stale details modal pointing to the old id
    if (picked && picked.id === oldId) setPicked(null);
  }, [cfg, selectedPoi, poiIdDraft, builderPois, builderCategories, setBuilderData, supportedLangs, defaultLang, uiLang, picked]);

  const addPoi = useCallback(() => {
    if (!cfg) return;
    const nextCats = ensureDefaultCategory(uiLang, builderCategories);
    if (!builderCategories.length) {
      setBuilderData(builderPois, nextCats);
      setCatsCsv(categoriesToCsv(nextCats, supportedLangs, defaultLang));
    }
    const id = nextSequentialPoiId(builderPois);

    // Give beginners a reasonable starting coordinate near the sample.
    // Outdoor: lat/lng near the configured center.
    // Indoor: x/y near the center of the floor image.
    const n = builderPois.length + 1;
    const s = n % 2 === 0 ? 1 : -1;
    const [baseLat, baseLng] = (cfg.outdoor?.center ?? [35.681236, 139.767125]) as [number, number];
    const dLat = s * 0.00012 * (1 + (n % 5));
    const dLng = -s * 0.00012 * (1 + ((n + 2) % 5));
    const lat = baseLat + dLat;
    const lng = baseLng + dLng;
    const clamp01 = (v: number) => Math.max(0.02, Math.min(0.98, v));
    const x = clamp01(0.5 + s * 0.06 * (1 + (n % 3)));
    const y = clamp01(0.5 - s * 0.05 * (1 + ((n + 1) % 3)));
    const next: Poi = {
      id,
      name: uiLang === "ja" ? "新しい地点" : "New place",
      description: "",
      category: nextCats[0].category,
      image: "",
      url: "",
      nameI18n: {},
      descriptionI18n: {},
      // We always set both pairs so the user doesn't have to understand the fields.
      lat,
      lng,
      x,
      y,
    };
    const nextPois = [next, ...builderPois];
    setBuilderData(nextPois, nextCats);
    setPoisCsv(poisToCsv(nextPois, supportedLangs, defaultLang));
    setSelectedPoiId(id);
  }, [cfg, uiLang, builderCategories, builderPois, setBuilderData, setPoisCsv, setCatsCsv, supportedLangs, defaultLang]);

  const deletePoi = useCallback((id: string) => {
    if (!cfg) return;
    const nextPois = builderPois.filter(p => p.id !== id);
    setBuilderData(nextPois, builderCategories);
    setPoisCsv(poisToCsv(nextPois, supportedLangs, defaultLang));
    if (selectedPoiId === id) setSelectedPoiId(nextPois[0]?.id ?? "");
  }, [cfg, builderPois, builderCategories, selectedPoiId, setBuilderData, supportedLangs, defaultLang]);

  const updateCategory = useCallback((key: string, patch: Partial<Category>) => {
    if (!cfg) return;
    const nextCats = builderCategories.map(c => c.category === key ? { ...c, ...patch } : c);
    setBuilderData(builderPois, nextCats);
    setCatsCsv(categoriesToCsv(nextCats, supportedLangs, defaultLang));
  }, [cfg, builderPois, builderCategories, setBuilderData, supportedLangs, defaultLang]);

  const addCategory = useCallback(() => {
    if (!cfg) return;
    const base = "cat";
    let n = builderCategories.length + 1;
    let key = `${base}${n}`;
    while (builderCategories.some(c => c.category === key)) { n++; key = `${base}${n}`; }
    const next: Category = {
      category: key,
      label: uiLang === "ja" ? "新しいカテゴリ" : "New category",
      labelI18n: { ja: "新しいカテゴリ", en: "New category" },
      icon: "📍",
      order: n,
      markerType: "pin",
      markerColor: "#6ea8fe",
    };
    const nextCats = [next, ...builderCategories];
    setBuilderData(builderPois, nextCats);
    setCatsCsv(categoriesToCsv(nextCats, supportedLangs, defaultLang));
    setSelectedCatKey(key);
  }, [cfg, builderCategories, builderPois, uiLang, setBuilderData, supportedLangs, defaultLang]);

  const deleteCategory = useCallback((key: string) => {
    if (!cfg) return;
    const nextCats = builderCategories.filter(c => c.category !== key);
    const safeCats = ensureDefaultCategory(uiLang, nextCats);
    const catKey = safeCats[0].category;
    const nextPois = builderPois.map(p => (p.category === key || !p.category) ? { ...p, category: catKey } : p);
    setBuilderData(nextPois, safeCats);
    setCatsCsv(categoriesToCsv(safeCats, supportedLangs, defaultLang));
    setPoisCsv(poisToCsv(nextPois, supportedLangs, defaultLang));
    if (selectedCatKey === key) setSelectedCatKey(safeCats[0]?.category ?? "");
  }, [cfg, builderCategories, builderPois, uiLang, selectedCatKey, setBuilderData, supportedLangs, defaultLang]);

  // Sync current easy-editor state into the CSV text areas (useful when switching to CSV mode)
  const syncCsvFromBuilder = useCallback(() => {
    if (!cfg) return;
    setPoisCsv(poisToCsv(builderPois, supportedLangs, defaultLang));

    setCatsCsv(categoriesToCsv(builderCategories, supportedLangs, defaultLang));
  }, [cfg, builderPois, builderCategories, supportedLangs, defaultLang]);

  // After undo, refresh CSV text areas to match the restored builder state.
  useEffect(() => {
    if (undoTick === 0) return;
    syncCsvFromBuilder();
  }, [undoTick, syncCsvFromBuilder]);


  const onPreviewMapClick = useCallback((latlng: L.LatLng) => {
    if (!cfg) return;

    // Add new POI by clicking the map (requested UX improvement)
    if (addOnMapClick) {
      const nextCats = ensureDefaultCategory(uiLang, builderCategories);
      const cats = builderCategories.length ? builderCategories : nextCats;

      const defaultCat = (cats[0]?.category ?? "default") as string;
      const id = nextSequentialPoiId(builderPois);
      const n = builderPois.length + 1;
      const s = n % 2 === 0 ? 1 : -1;

      // Default x/y (used for indoor, and kept filled for outdoor too)
      let x = clamp01(0.5 + s * 0.06 * (1 + (n % 3)));
      let y = clamp01(0.5 - s * 0.05 * (1 + ((n + 1) % 3)));

      let lat = (cfg.outdoor?.centerLat ?? 35.681236) + s * 0.0002;
      let lng = (cfg.outdoor?.centerLng ?? 139.767125) + s * 0.0002;

      if (cfg.mode === "indoor") {
        const w = cfg.indoor.imageWidthPx;
        const h = cfg.indoor.imageHeightPx;
        x = clamp01(latlng.lng / w);
        y = clamp01(latlng.lat / h);
      } else {
        lat = latlng.lat;
        lng = latlng.lng;
      }

      const next: Poi = PoiSchema.parse({
        id,
        category: defaultCat,
        name: uiLang === "ja" ? "新しい地点" : "New place",
        description: "",
        image: "",
        lat: round6(lat),
        lng: round6(lng),
        x: round4(x),
        y: round4(y),
        url: "",
        hours: "",
        closed: "",
      });

      const nextPois = [next, ...builderPois];
      setBuilderData(nextPois, cats);
      setPoisCsv(poisToCsv(nextPois, supportedLangs, defaultLang));
      if (!builderCategories.length) {
        setCatsCsv(categoriesToCsv(cats, supportedLangs, defaultLang));
      }
      setSelectedPoiId(id);
      return;
    }

    if (!pickPos) return;
    if (!selectedPoiId) return;

    if (cfg.mode === "indoor") {
      const w = cfg.indoor.imageWidthPx;
      const h = cfg.indoor.imageHeightPx;
      const x = clamp01(latlng.lng / w);
      const y = clamp01(latlng.lat / h);

      // Update through the same path as the easy editor so CSV stays in sync.
      updatePoi(selectedPoiId, { x: round4(x), y: round4(y) });
      return;
    }

    // Outdoor: use lat/lng
    updatePoi(selectedPoiId, { lat: round6(latlng.lat), lng: round6(latlng.lng) });
  }, [cfg, pickPos, selectedPoiId, updatePoi, addOnMapClick, uiLang, builderCategories, builderPois, setBuilderData, setPoisCsv, setCatsCsv, supportedLangs, defaultLang]);

  // Keyboard shortcuts: even if focus is inside textarea
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      // Ctrl/Cmd+Z: one-step undo (avoid interfering with native undo inside inputs)
      if ((e.key === "z" || e.key === "Z") && !e.shiftKey) {
        const el = e.target as any;
        const tag = (el?.tagName || "").toLowerCase();
        const isTyping = tag === "input" || tag === "textarea" || !!el?.isContentEditable;
        if (!isTyping && canUndo) {
          e.preventDefault();
          onUndo();
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        applyCsv();
      }
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        previewBuilder();
        setStep(3);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [applyCsv, previewBuilder, canUndo, onUndo]);

  // When entering Step 3, default to the map tab
  useEffect(() => {
    if (step === 3) setPreviewTab("map");
  }, [step]);

  const filteredPois = useMemo(() => {
    const q = query.trim().toLowerCase();
    return builderPois.filter(p => {
      if (activeCategory && p.category !== activeCategory) return false;
      const name = pickPoiName(p, cfg ?? ({} as any), effectiveContentLang).toLowerCase();
      if (!q) return true;
      return name.includes(q) || (p.id ?? "").toLowerCase().includes(q);
    });
  }, [builderPois, activeCategory, query, cfg, effectiveContentLang]);

  if (!cfg) {
    // In import flow we want to show the import screen even before sample data finishes loading.
    if (importFlow && step === 0) {
      return (
        <main className="layout layoutSingle">
          <section className="pane">
            <div className="paneHeader">
              <div style={{ fontWeight: 900 }}>{t(uiLang, "builder")}</div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <button className="btn primary" onClick={() => setStep(0)}>{t(uiLang, "step_import")}</button>
              </div>
            </div>
            <div className="paneBody">
              <div className="cards">
                <div className="card">
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "import_title")}</div>
                  <div className="hint" style={{ marginBottom: 12 }}>{t(uiLang, "import_hint")}</div>
                  <DropZone
                    title={t(uiLang, "import_choose_zip")}
                    accept=".zip"
                    multiple={false}
                    onFiles={(files) => {
                      const f = files.item(0);
                      if (!f) return;
                      importZipIntoBuilder(f).catch((e: any) => {
                        setImportError(String(e?.message ?? e));
                        setImportState("error");
                      });
                    }}
                    buttonLabel={t(uiLang, "import_choose_zip")}
                  />
                  {importedName ? <div className="hint" style={{ marginTop: 8 }}>{importedName}</div> : null}
                  {importState === "loading" ? <div className="hint" style={{ marginTop: 8 }}>{uiLang === "ja" ? "読み込み中…" : "Importing…"}</div> : null}
                  {importState === "done" ? <div className="hint" style={{ marginTop: 8 }}>{t(uiLang, "import_loaded")}</div> : null}
                  {importState === "error" && importError ? <div className="hint" style={{ marginTop: 8, color: "#f66" }}>{importError}</div> : null}
                </div>
              </div>
            </div>
          </section>
        </main>
      );
    }
    return <main className="layout"><section className="pane"><div className="card">{uiLang === "ja" ? "読み込み中…" : "Loading…"}</div></section></main>;
  }

  // In the builder, show the field for the current language without falling back.
  // (If we fallback, beginners may think they're editing Japanese but actually edit English, etc.)
  const titleEditing = (effectiveContentLang === defaultLang)
    ? cfg.title
    : ((cfg.titleI18n ?? {})[effectiveContentLang] ?? "");
  const subtitleEditing = (effectiveContentLang === defaultLang)
    ? (cfg.subtitle ?? "")
    : ((cfg.subtitleI18n ?? {})[effectiveContentLang] ?? "");

  const editingLangLabel = langLabel(effectiveContentLang, uiLang);


  const csvApplyBtnClass =
    "btn " + (csvApplyState === "idle" ? "soft" : csvApplyState === "pending" ? "primary" : "success");

  const onApplyToCsv = () => {
    // Reflect current edits into the CSV text (and also update preview data).
    syncCsvFromBuilder();
    previewBuilder();
    csvEverApplied.current = true;
    csvBaselineRef.current = builderHash;
    setCsvApplyState("applied");
  };

  return (
    <main className="layout layoutSingle">
      <section className="pane">
        <div className="paneHeader">
          <div style={{ fontWeight: 900 }}>{t(uiLang, "builder")}</div>

          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {importFlow ? (
              <button className={"btn " + (step === 0 ? "primary" : "")} onClick={() => setStep(0)}>{t(uiLang, "step_import")}</button>
            ) : null}
            <button className={"btn " + (step === 1 ? "primary" : "")} onClick={() => setStep(1)}>{t(uiLang, importFlow ? "step_template_2" : "step_template")}</button>
            <button className={"btn " + (step === 2 ? "primary" : "")} onClick={() => setStep(2)}>{t(uiLang, importFlow ? "step_assets_3" : "step_assets")}</button>
            <button className={"btn " + (step === 3 ? "primary" : "")} onClick={() => setStep(3)} disabled={!canNext3}>{t(uiLang, importFlow ? "step_preview_4" : "step_preview")}</button>
            <button className={"btn " + (step === 4 ? "primary" : "")} onClick={() => setStep(4)} disabled={!canNext4}>{t(uiLang, importFlow ? "step_publish_5" : "step_publish")}</button>

<button className={"btn soft"} onClick={onUndo} disabled={!canUndo} title={uiLang === "ja" ? "Ctrl+Z: 元に戻す" : "Ctrl+Z: Undo"} aria-label={t(uiLang, "undo")} style={{ width: 44, padding: 0, fontSize: 20, lineHeight: "44px" }}>↰</button>
<span className={"savePill " + (csvApplyState === "pending" ? "unsaved" : "saved")} title={uiLang === "ja" ? "CSVに反映されていない変更があるかを表示します" : "Shows whether there are changes not written to CSV"}>
  {csvApplyState === "pending" ? "⚠️" : "✅"} {t(uiLang, csvApplyState === "pending" ? "unsaved" : "saved")}
</span>
          </div>
        </div>

        <div className="paneBody">

        {/* STEP 0 (Import exported zip) */}
        {importFlow && step === 0 ? (
          <div className="cards">
            <div className="card">
              <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "import_title")}</div>
              <div className="hint" style={{ marginBottom: 12 }}>{t(uiLang, "import_hint")}</div>
              <DropZone
                title={t(uiLang, "import_choose_zip")}
                accept=".zip"
                multiple={false}
                onFiles={(files) => {
                  const f = files.item(0);
                  if (!f) return;
                  importZipIntoBuilder(f).catch((e: any) => {
                    setImportError(String(e?.message ?? e));
                    setImportState("error");
                  });
                }}
                buttonLabel={t(uiLang, "import_choose_zip")}
              />
              {importedName ? <div className="hint" style={{ marginTop: 8 }}>{importedName}</div> : null}
              {importState === "loading" ? <div className="hint" style={{ marginTop: 8 }}>{uiLang === "ja" ? "読み込み中…" : "Importing…"}</div> : null}
              {importState === "done" ? <div className="hint" style={{ marginTop: 8 }}>{t(uiLang, "import_loaded")}</div> : null}
              {importState === "error" && importError ? <div className="hint" style={{ marginTop: 8, color: "#f66" }}>{importError}</div> : null}

              <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
                <button className={"btn " + (importState === "done" ? "primary" : "soft")} onClick={() => setStep(1)} disabled={importState !== "done"}>
                  {t(uiLang, "next_template")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* STEP 1 */}
        {step === 1 ? (
          <div className="cards">
            <div className="card">
              <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "template_title")}</div>
              <div className="grid2">
                <label>
                  {t(uiLang, "mode")}
                  <select
                    value={cfg.mode}
                    onChange={(e) => {
                      const mode = e.target.value as any;
                      if (mode === "indoor") setBuilderConfig({ ...cfg, mode: "indoor", indoor: { ...cfg.indoor } });
                      else setBuilderConfig({ ...cfg, mode: "outdoor" });
                    }}
                  >
                    <option value="outdoor">{t(uiLang, "mode_outdoor")}</option>
                    <option value="indoor">{t(uiLang, "mode_indoor")}</option>
                  </select>
                </label>

                <label>
                  {t(uiLang, "default_lang")}
                  <select
                    value={cfg.i18n.defaultLang}
                    onChange={(e) => setBuilderConfig({ ...cfg, i18n: { ...cfg.i18n, defaultLang: e.target.value } })}
                  >
                    {supportedLangs.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>

                <label>
                  {t(uiLang, "title")} <span className="badge">({editingLangLabel})</span>
                  <input value={titleEditing} onChange={(e) => {
                    const v = e.target.value;
                    if (effectiveContentLang === cfg.i18n.defaultLang) setBuilderConfig({ ...cfg, title: v });
                    else setBuilderConfig({ ...cfg, titleI18n: { ...(cfg.titleI18n ?? {}), [effectiveContentLang]: v } });
                  }} />
                </label>

                <label>
                  {t(uiLang, "subtitle")} <span className="badge">({editingLangLabel})</span>
                  <input value={subtitleEditing} onChange={(e) => {
                    const v = e.target.value;
                    if (effectiveContentLang === cfg.i18n.defaultLang) setBuilderConfig({ ...cfg, subtitle: v });
                    else setBuilderConfig({ ...cfg, subtitleI18n: { ...(cfg.subtitleI18n ?? {}), [effectiveContentLang]: v } });
                  }} />
                </label>


                <label>
                  {t(uiLang, "tab_title")}
                  <input
                    value={cfg.ui?.tabTitle ?? "AtlasKobo — 地図サイト制作キット"}
                    onChange={(e) => setBuilderConfig({ ...cfg, ui: { ...(cfg.ui ?? {}), tabTitle: e.target.value } })}
                  />
                </label>

                {cfg.mode === "indoor" ? (
                  <div className="hint" style={{ gridColumn: "1 / -1" }}>
                    {uiLang === "ja"
                      ? "屋内画像のサイズ（横幅/縦幅）は、フロア画像をアップロードしたときに自動で読み取ります。"
                      : "Indoor image size (width/height) will be detected automatically when you upload the floor image."}
                  </div>
                ) : null}
              </div>

              <div className="row" style={{ marginTop: 10, justifyContent: importFlow ? "space-between" : "flex-end" }}>
                {importFlow ? (
                  <button className="btn soft" onClick={() => setStep(0)}>{t(uiLang, "back")}（{t(uiLang, "step_import")}）</button>
                ) : <span />}
                <button className="btn primary" onClick={() => setStep(2)}>{t(uiLang, "next_assets")}</button>
              </div>
            </div>

            <div className="card">
              <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "template_hint_title")}</div>
              <div className="hint">{t(uiLang, "template_hint_body")}</div>
            </div>
          </div>
        ) : null}

        {/* STEP 2 */}
        {step === 2 ? (
          <div className="cards">
            <div className="card">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "end" }}>
                <div>
                  <div style={{ fontWeight: 900 }}>{t(uiLang, "edit_data_title")}</div>
                  <div className="hint">{t(uiLang, "edit_data_hint")}</div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className={"btn " + (editorMode === "easy" ? "primary" : "")} onClick={() => setEditorMode("easy")}>{t(uiLang, "easy_editor")}</button>
                  <button className={"btn " + (editorMode === "csv" ? "primary" : "")} onClick={() => setEditorMode("csv")}>{t(uiLang, "advanced_csv")}</button>
                </div>
              </div>

              {editorMode === "easy" ? (
                <>
                <div className="grid2" style={{ marginTop: 10 }}>
                  {/* POI list + form */}
                  <div className="card" style={{ padding: 12 }}>
                    <div style={{ fontWeight: 900, marginBottom: 8 }}>{t(uiLang, "pois_easy_title")}</div>

                    <div className="row" style={{ gap: 8 }}>
                      <select value={activeCategory} onChange={(e) => setActiveCategory(e.target.value)}>
                        <option value="">{t(uiLang, "all")}</option>
                        {builderCategories.map(c => (
                          <option key={c.category} value={c.category}>
                            {(c.icon ? `${c.icon} ` : "") + pickCategoryLabel(c, effectiveContentLang, defaultLang)}
                          </option>
                        ))}
                      </select>
                      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t(uiLang, "search_placeholder")} />
                      <button className="btn" onClick={addPoi}>{t(uiLang, "add_poi")}</button>
                    </div>

                    <div className="list" style={{ marginTop: 10, maxHeight: 260, overflow: "auto" }}>
                      {filteredPois.map(p => (
                        <button
                          key={p.id}
                          className={"listItem " + (p.id === selectedPoiId ? "active" : "")}
                          onClick={() => setSelectedPoiId(p.id)}
                          type="button"
                        >
                          <div style={{ fontWeight: 800 }}>{pickPoiName(p, cfg, effectiveContentLang)}</div>
                          <div className="hint">{p.id}</div>
                        </button>
                      ))}
                      {!filteredPois.length ? <div className="hint" style={{ padding: 10 }}>{t(uiLang, "select_item_hint")}</div> : null}
                    </div>
                  </div>

                  <div className="card" style={{ padding: 12 }}>
                    <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontWeight: 900 }}>{uiLang === "ja" ? "地点の編集" : "Edit place"}</div>
                      {selectedPoi ? (
                        <button className="btn danger" onClick={() => deletePoi(selectedPoi.id)}>{t(uiLang, "delete_poi")}</button>
                      ) : null}
                    </div>

                    {selectedPoi ? (
                      <div className="grid2" style={{ marginTop: 10 }}>
                        <label>
                          {t(uiLang, "field_id")}
                          <input
                            value={poiIdDraft}
                            onChange={(e) => { setPoiIdDraft(e.target.value); setPoiIdError(""); }}
                            onBlur={commitPoiId}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                // commit on Enter by blurring (keeps behavior consistent)
                                (e.currentTarget as HTMLInputElement).blur();
                              }
                            }}
                          />
                          {poiIdError ? <div className="hint dangerText">{poiIdError}</div> : null}
                        </label>

                        <label>
                          {t(uiLang, "field_category")}
                          <select value={selectedPoi.category} onChange={(e) => updatePoi(selectedPoi.id, { category: e.target.value })}>
                            {ensureDefaultCategory(uiLang, builderCategories).map(c => (
                              <option key={c.category} value={c.category}>
                                {(c.icon ? `${c.icon} ` : "") + pickCategoryLabel(c, effectiveContentLang, defaultLang)}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label>
                          {t(uiLang, "field_name_ja")}
                          <input
                            value={selectedPoi.name}
                            onChange={(e) => updatePoi(selectedPoi.id, { name: e.target.value })}
                          />
                        </label>

                        <label>
                          {t(uiLang, "field_name_en")}
                          <input
                            value={(selectedPoi.nameI18n ?? {}).en ?? ""}
                            onChange={(e) => updatePoi(selectedPoi.id, { nameI18n: { ...(selectedPoi.nameI18n ?? {}), en: e.target.value } })}
                          />
                        </label>

                        <label>
                          {t(uiLang, "field_desc_ja")}
                          <textarea
                            value={selectedPoi.description ?? ""}
                            onChange={(e) => updatePoi(selectedPoi.id, { description: e.target.value })}
                            rows={3}
                          />
                        </label>

                        <label>
                          {t(uiLang, "field_desc_en")}
                          <textarea
                            value={(selectedPoi.descriptionI18n ?? {}).en ?? ""}
                            onChange={(e) => updatePoi(selectedPoi.id, { descriptionI18n: { ...(selectedPoi.descriptionI18n ?? {}), en: e.target.value } })}
                            rows={3}
                          />
                        </label>

                        <label>
                          {t(uiLang, "field_image")}
                          <select value={selectedPoi.image ?? ""} onChange={(e) => updatePoi(selectedPoi.id, { image: e.target.value })}>
                            <option value="">{uiLang === "ja" ? "なし" : "None"}</option>
                            {imageChoices.map(k => <option key={k} value={k}>{k}</option>)}
                          </select>
                        </label>

                        <label>
                          {t(uiLang, "field_url")}
                          <input value={selectedPoi.url ?? ""} onChange={(e) => updatePoi(selectedPoi.id, { url: e.target.value })} placeholder="https://..." />
                        </label>

{cfg.mode === "outdoor" ? (
  <>
    <label>
      {t(uiLang, "field_hours")}
      <input
        value={(selectedPoi as any).hours ?? ""}
        onChange={(e) => updatePoi(selectedPoi.id, { hours: e.target.value })}
        placeholder={uiLang === "ja" ? "10:00-18:00" : "10:00-18:00"}
      />
    </label>
    <label>
      {t(uiLang, "field_closed")}
      <input
        value={(selectedPoi as any).closed ?? ""}
        onChange={(e) => updatePoi(selectedPoi.id, { closed: e.target.value })}
        placeholder={uiLang === "ja" ? "水 / Mon / 無休" : "Wed / Mon / None"}
      />
    </label>
    <div className="hint" style={{ gridColumn: "1 / -1" }}>
      {uiLang === "ja"
        ? "※「営業中🟢 / 営業時間外🔴」表示に使われます（屋外のみ）。例: 10:00-18:00 / 定休日: 水。※定休日がない場合は空欄（または「無休」）にしてください。"
        : "Used for the open/closed indicator (outdoor only). Example: 10:00-18:00 / Closed: Wed. If there is no regular closing day, leave it blank (or write \"None\")."}
    </div>
  </>
) : null}


                        {cfg.mode === "outdoor" ? (
                          <div className="hint" style={{ gridColumn: "1 / -1" }}>
                            {uiLang === "ja"
                              ? "屋外の位置（緯度・経度）は「3.できあがり確認」で地図をクリックして調整できます。"
                              : "You can adjust outdoor position (lat/lng) by clicking the map in Step 3 (Preview)."}
                          </div>
                        ) : (
                          <>
                            <label>
                              x (0〜1)
                              <input
                                type="number"
                                step="0.0001"
                                value={selectedPoi.x ?? ""}
                                onChange={(e) => updatePoi(selectedPoi.id, { x: clamp01(Number(e.target.value)) })}
                              />
                            </label>
                            <label>
                              y (0〜1)
                              <input
                                type="number"
                                step="0.0001"
                                value={selectedPoi.y ?? ""}
                                onChange={(e) => updatePoi(selectedPoi.id, { y: clamp01(Number(e.target.value)) })}
                              />
                            </label>
                            <div className="hint" style={{ gridColumn: "1 / -1" }}>
                              {uiLang === "ja"
                                ? "屋内の位置は「できあがり確認」で地図をクリックして調整できます。ここでは数値（0〜1）でも調整できます。"
                                : "You can adjust indoor position by clicking the map in Preview. You can also edit numbers here (0–1)."}
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="hint" style={{ marginTop: 10 }}>{t(uiLang, "select_item_hint")}</div>
                    )}
                  </div>

                  {/* Categories */}
                  <div className="card" style={{ padding: 12, gridColumn: "1 / -1" }}>
                    <div className="row" style={{ justifyContent: "space-between", alignItems: "end" }}>
                      <div>
                        <div style={{ fontWeight: 900 }}>{t(uiLang, "cats_easy_title")}</div>
                        <div className="hint">{uiLang === "ja" ? "マーカーの形や色もここで選べます。" : "Choose marker type and color here."}</div>
                      </div>
                      <button className="btn" onClick={addCategory}>{t(uiLang, "add_category")}</button>
                    </div>

                    <div className="list" style={{ marginTop: 10 }}>
                      {builderCategories.map(c => {
                        // Category.label is the *default language* label. For beginners, we always show explicit
                        // fields for ja/en, regardless of which is default.
                        const labelJa = (c.labelI18n?.ja ?? (defaultLang === "ja" ? (c.label ?? "") : "")) ?? "";
                        const labelEn = (c.labelI18n?.en ?? (defaultLang === "en" ? (c.label ?? "") : "")) ?? "";
                        const color = c.markerColor || "#6ea8fe";
                        return (
                          <div key={c.category} className="row" style={{ justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                            <div style={{ minWidth: 240 }}>
                              <div style={{ fontWeight: 800 }}>{(c.icon ? `${c.icon} ` : "")}{labelJa || c.category}</div>
                              <div className="hint">{c.category}</div>
                            </div>

                            <div className="row" style={{ flexWrap: "wrap", gap: 10, justifyContent: "end" }}>
                              <label className="row" style={{ gap: 6 }}>
                                {uiLang === "ja" ? "表示名" : "Label"}
                                <input
                                  value={labelJa}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    const nextI18n = { ...(c.labelI18n ?? {}), ja: v };
                                    if (defaultLang === "ja") updateCategory(c.category, { label: v, labelI18n: nextI18n });
                                    else updateCategory(c.category, { labelI18n: nextI18n });
                                  }}
                                  style={{ width: 160 }}
                                />
                              </label>
                              <label className="row" style={{ gap: 6 }}>
                                en
                                <input
                                  value={labelEn}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    const nextI18n = { ...(c.labelI18n ?? {}), en: v };
                                    if (defaultLang === "en") updateCategory(c.category, { label: v, labelI18n: nextI18n });
                                    else updateCategory(c.category, { labelI18n: nextI18n });
                                  }}
                                  style={{ width: 160 }}
                                />
                              </label>
                              <label className="row" style={{ gap: 6 }}>
                                icon
                                <input value={c.icon ?? ""} onChange={(e) => updateCategory(c.category, { icon: e.target.value })} style={{ width: 70 }} />
                              </label>
                              <label className="row" style={{ gap: 6 }}>
                                {uiLang === "ja" ? "形" : "Type"}
                                <select value={(c.markerType ?? "pin") as any} onChange={(e) => updateCategory(c.category, { markerType: e.target.value as any })}>
                                  {MARKER_TYPES.map(mt => <option key={mt} value={mt}>{mt}</option>)}
                                </select>
                              </label>
                              <ColorButton value={color} onChange={(v) => updateCategory(c.category, { markerColor: v })} />
                              <button className="btn danger" onClick={() => deleteCategory(c.category)}>{uiLang === "ja" ? "削除" : "Delete"}</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              
                <div className="row" style={{ gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
                  <button className={csvApplyBtnClass} onClick={onApplyToCsv}>{t(uiLang, "apply_to_csv")}</button>
                </div>
                </>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <div className="hint">{uiLang === "ja" ? "Ctrl/⌘+Enter: CSVに反映 / Ctrl/⌘+Shift+Enter: プレビュー更新" : "Ctrl/⌘+Enter: Write to CSV / Ctrl/⌘+Shift+Enter: Update preview"}</div>
                  <div className="grid2" style={{ marginTop: 10 }}>
                    <div>
                      <div className="row" style={{ justifyContent: "space-between", alignItems: "end" }}>
                        <div style={{ fontWeight: 900 }}>{t(uiLang, "pois_csv")}</div>
                        <button className="btn" onClick={() => setPoisCsv(examplePoisCsv())}>{t(uiLang, "fill_sample")}</button>
                      </div>
                      <textarea value={poisCsv} onChange={(e) => setPoisCsv(e.target.value)} rows={16} />
                      <div className="hint">{t(uiLang, "poi_csv_hint")}</div>
                    </div>

                    <div>
                      <div className="row" style={{ justifyContent: "space-between", alignItems: "end" }}>
                        <div style={{ fontWeight: 900 }}>{t(uiLang, "cats_csv")}</div>
                        <button className="btn" onClick={() => setCatsCsv(exampleCategoriesCsv())}>{t(uiLang, "fill_sample")}</button>
                      </div>
                      <textarea value={catsCsv} onChange={(e) => setCatsCsv(e.target.value)} rows={16} />
                      <div className="hint">{t(uiLang, "cat_csv_hint")}</div>
                    </div>
                  </div>

                  <div className="row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button className="btn primary" onClick={applyCsv}>{t(uiLang, "apply_csv")}</button>
                  </div>
                </div>
              )}
            </div>

            {/* Assets */}
            <div className="card">
              <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "assets_title")}</div>

              {cfg.mode === "indoor" ? (
                <div className="card" style={{ marginTop: 8 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "assets_floor_title")}</div>
                  <div className="hint" style={{ marginBottom: 8 }}>
                    {uiLang === "ja" ? "現在のフロア画像（プレビュー）" : "Current floor image (preview)"}
                  </div>
                  <div className="floorPreview">
                    <img
                      src={floorPreviewUrl || publicUrl(cfg.indoor.imageUrl)}
                      alt="floor preview"
                      style={{ maxWidth: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 12, border: "1px solid rgba(255,255,255,0.10)" }}
                    />
                  </div>
                  <DropZone
                    label={t(uiLang, "assets_floor_drop")}
                    accept="image/*"
                    onFiles={async (files) => {
                      const f = files[0];
                      if (!f) return;
                      const out = await compressImage(f, 2200);
                      setBuilderAsset("floor", "floor", out);
                      // Auto-detect floor image size (px) so beginners don't have to type it.
                      let objUrl: string | null = null;
                      try {
                        objUrl = URL.createObjectURL(out);
                        const img = new Image();
                        const size = await new Promise<{ w: number; h: number }>((resolve, reject) => {
                          img.onload = () => resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
                          img.onerror = () => reject(new Error("failed to read image size"));
                          img.src = objUrl!;
                        });
                        setBuilderConfig({ ...cfg, indoor: { ...cfg.indoor, imageWidthPx: size.w, imageHeightPx: size.h } });
                      } catch {
                        // ignore
                      } finally {
                        if (objUrl) URL.revokeObjectURL(objUrl);
                      }

                    }}
                  />
                  {builderAssets.floorFile ? (
                    <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                      <div className="hint">{builderAssets.floorFile.name}</div>
                      <button className="btn danger" onClick={() => removeBuilderAsset("floor")}>{uiLang === "ja" ? "削除" : "Remove"}</button>
                    </div>
                  ) : <div className="hint" style={{ marginTop: 8 }}>{t(uiLang, "assets_floor_hint")}</div>}
                </div>
              ) : null}

              <div className="card" style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "assets_images_title")}</div>
                <DropZone
                  label={t(uiLang, "assets_images_drop")}
                  accept="image/*"
                  multiple
                  onFiles={async (files) => {
                    for (const f of files) {
                      const out = await compressImage(f, 1800);
                      const key = guessImagePath(out.name);
                      setBuilderAsset("image", key, out);
                    }
                  }}
                />
                <div className="hint" style={{ marginTop: 8 }}>{t(uiLang, "assets_images_hint")}</div>

                {Object.keys(builderAssets.images ?? {}).length ? (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>
                      {uiLang === "ja" ? "アップロード済みの画像" : "Uploaded images"}
                    </div>
                    <div className="thumbGrid">
                      {Object.entries(builderAssets.images ?? {}).map(([key, file]) => (
                        <div key={key} className="thumbItem">
                          {imagePreviewUrls[key] ? (
                            <img src={imagePreviewUrls[key]} alt={key} />
                          ) : (
                            <div className="thumbFallback">IMG</div>
                          )}
                          <div className="thumbMeta">
                            <div className="thumbName">{file.name}</div>
                            <div className="hint" style={{ margin: 0 }}>{key}</div>
                          </div>
                          <button className="btn danger" onClick={() => removeBuilderAsset("image", key)}>
                            {uiLang === "ja" ? "削除" : "Remove"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="row" style={{ marginTop: 10, justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => setStep(1)}>{t(uiLang, "back")}（{t(uiLang, importFlow ? "step_template_2" : "step_template")}）</button>
                <button className="btn primary" onClick={() => { previewBuilder(); setStep(3); }} disabled={hasError}>{t(uiLang, "next_preview")}</button>
              </div>
            </div>

          </div>
        ) : null}

        {/* STEP 3 */}
        {step === 3 ? (
          <div className="cards">
            <div className="card">
              <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "preview_title")}</div>
              <div className="hint">{t(uiLang, "preview_hint")}</div>

              {/* Tabs (map / issues). Placed above the Leaflet map so it never gets hidden. */}
              <div
                className="row"
                style={{
                  gap: 8,
                  marginTop: 10,
                  position: "relative",
                  zIndex: 1200,
                  background: "var(--card)",
                  paddingTop: 4,
                  paddingBottom: 4,
                }}
              >
                <button
                  className={"btn " + (previewTab === "map" ? "primary" : "")}
                  onClick={() => setPreviewTab("map")}
                >
                  {uiLang === "ja" ? "地図" : "Map"}
                </button>
                <button
                  className={"btn " + (previewTab === "issues" ? "primary" : "")}
                  onClick={() => setPreviewTab("issues")}
                >
                  {t(uiLang, "detect_errors_title")}{issues.length ? ` (${issues.length})` : ""}
                </button>
              </div>

              {previewTab === "map" ? (
                <>
                  <div className="row" style={{ gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                    <label className="row" style={{ gap: 8 }}>
                      {uiLang === "ja" ? "移動する地点" : "Move place"}
                      <select value={selectedPoiId} onChange={(e) => setSelectedPoiId(e.target.value)}>
                        {builderPois.map(p => (
                          <option key={p.id} value={p.id}>{pickPoiName(p, cfg, effectiveContentLang)}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      className={"btn " + (pickPos ? "primary" : "")}
                      onClick={() => setPickPos(v => {
                        const next = !v;
                        if (next) setAddOnMapClick(false);
                        return next;
                      })}
                    >
                      {t(uiLang, "set_position")} {pickPos ? "ON" : "OFF"}
                    </button>
                    <button
                      className={"btn " + (addOnMapClick ? "primary" : "")}
                      onClick={() => setAddOnMapClick(v => {
                        const next = !v;
                        if (next) setPickPos(false);
                        return next;
                      })}
                    >
                      {t(uiLang, "add_on_map_click")} {addOnMapClick ? "ON" : "OFF"}
                    </button>
                    <div className="hint">
                      {addOnMapClick
                        ? t(uiLang, "add_on_map_click_hint")
                        : (uiLang === "ja"
                            ? (cfg.mode === "indoor"
                                ? "ON の間はクリックして屋内の位置（x/y）を調整します（詳細は開きません）"
                                : "ON の間はクリックして屋外の位置（緯度・経度）を設定します（詳細は開きません）")
                            : (cfg.mode === "indoor"
                                ? "When ON, click to adjust indoor position (x/y). (Details won't open.)"
                                : "When ON, click to set outdoor position (lat/lng). (Details won't open.)"))}
                    </div>
                  </div>

                  <div className="mapWrap" style={{ height: 520, marginTop: 10 }}>
                    <MapView
                      config={cfg}
                      pois={builderPois}
                      categories={builderCategories}
                      contentLang={effectiveContentLang}
                      uiLang={uiLang}
                      onPickPoi={(pickPos || addOnMapClick) ? undefined : (p) => setPicked(p)}
                      onMapClick={onPreviewMapClick}
                      indoorImageOverrideUrl={floorPreviewUrl || undefined}
                    />
                  </div>
                </>
              ) : null}

              {previewTab === "issues" ? (
                <div className={hasError ? "danger" : "ok"} style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "detect_errors_title")}</div>
                  {issues.length ? (
                    <ul className="hint" style={{ margin: 0 }}>
                      {issues.slice(0, 40).map((i, idx) => (
                        <li key={idx}>{i.level.toUpperCase()}: {i.poiId ? `[${i.poiId}] ` : ""}{i.message[uiLang]}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="hint">{t(uiLang, "validation_ok")}</div>
                  )}
                </div>
              ) : null}

              <div className="row" style={{ gap: 10, marginTop: 12, width: "100%", justifyContent: "space-between" }}>
                <button className="btn" onClick={() => setStep(2)}>{t(uiLang, "back")}</button>
                <div className="row" style={{ gap: 10 }}>
                <button className={csvApplyBtnClass} onClick={onApplyToCsv}>
                  {t(uiLang, "apply_to_csv")}
                </button>
                <button className="btn primary" onClick={() => setStep(4)} disabled={!canNext4}>{t(uiLang, "next_publish")}</button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* STEP 4 */}
        {step === 4 ? (
          <div className="cards">
            <div className="card">
              <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "publish_title")}</div>
              <div className="hint">{t(uiLang, "publish_hint")}</div>

              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>{t(uiLang, "publish_color_templates")}</div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {([
                    { key: "blue", label: t(uiLang, "theme_blue"), color: "#6ea8fe" },
                    { key: "green", label: t(uiLang, "theme_green"), color: "#2fd4a3" },
                    { key: "orange", label: t(uiLang, "theme_orange"), color: "#ffb020" },
                    { key: "purple", label: t(uiLang, "theme_purple"), color: "#b39ddb" },
                    { key: "red", label: t(uiLang, "theme_red"), color: "#ff6b6b" },
                  ] as const).map((p) => (
                    <button
                      key={p.key}
                      className={"btn " + (publishTheme === p.key ? "primary" : "")}
                      type="button"
                      onClick={() => setPublishTheme(p.key as ThemePreset)}
                    >
                      <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 999, background: p.color, marginRight: 8 }} />
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="row" style={{ gap: 10, marginTop: 14, flexWrap: "wrap", justifyContent: "flex-start" }}>
                <button
                  className="btn primary"
                  onClick={async () => {
                    const blob = await exportSiteZip({
                      config: cfg,
                      pois: builderPois,
                      categories: builderCategories,
                      floorFile: builderAssets.floorFile,
                      images: builderAssets.images,
                      themePreset: publishTheme,
                    });
                    downloadBlob(blob, "site.zip");
                  }}
                >
                  {t(uiLang, "download_site_zip")}
                </button>

                <button className="btn" onClick={() => setQrOpen(true)}>{t(uiLang, "qr_title")}</button>
                <button className="btn" onClick={() => setStep(3)}>{t(uiLang, "back")}</button>
              </div>

              <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: "wrap", justifyContent: "flex-start" }}>
                <button
                  className="btn"
                  onClick={async () => {
                    const blob = await exportContentZip({
                      config: cfg,
                      pois: builderPois,
                      categories: builderCategories,
                      floorFile: builderAssets.floorFile,
                      images: builderAssets.images,
                    });
                    downloadBlob(blob, "content-pack.zip");
                  }}
                >
                  {t(uiLang, "download_content_pack")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        </div>
      </section>

      {picked ? (
        <DetailsModal
          config={cfg}
          poi={picked}
          category={builderCategories.find(c => c.category === picked.category)}
          contentLang={effectiveContentLang}
          uiLang={uiLang}
          onClose={() => setPicked(null)}
        />
      ) : null}

      {qrOpen ? (
        <QrModal
          onClose={() => setQrOpen(false)}
          title={uiLang === "ja" ? "プレビュー" : "Preview"}
          url={location.href.replace(/#\/builder.*/, "#/" )}
        />
      ) : null}
    </main>
  );
}

// Color button that shows selected color
function ColorButton(props: { value: string; onChange: (v: string) => void }) {
  const { value, onChange } = props;
  const safe = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#6ea8fe";
  return (
    <label className="colorBtn" style={{ background: safe }} title={safe}>
      <input
        type="color"
        value={safe}
        onChange={(e) => onChange(e.target.value)}
        aria-label="marker color"
      />
    </label>
  );
}