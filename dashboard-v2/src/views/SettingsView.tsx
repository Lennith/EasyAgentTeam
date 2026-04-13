import { useEffect, useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import { useSettings } from "@/hooks/useSettings";
import type { ModelInfo, RuntimeSettings, Theme } from "@/types";
import { modelsApi, settingsApi } from "@/services/api";
import { Save, Loader, Database, Wifi, Palette } from "lucide-react";

const DEFAULT_MINIMAX_MODEL = "MiniMax-M2.5-High-speed";

const THEMES: { value: Theme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "vibrant", label: "Vibrant Medium" },
  { value: "lively", label: "Lively Day" }
];

const THEME_STORAGE_KEY = "dashboard_theme";

function isTheme(value: string | null | undefined): value is Theme {
  return value === "dark" || value === "vibrant" || value === "lively";
}

function readCurrentTheme(): Theme {
  const fromDom = document.documentElement.getAttribute("data-theme");
  if (isTheme(fromDom)) {
    return fromDom;
  }
  try {
    const fromStorage = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(fromStorage)) {
      return fromStorage;
    }
  } catch {
    // ignore local storage errors
  }
  return "dark";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore local storage errors
  }
}

export function SettingsView() {
  const t = useTranslation();
  const { settings: dashboardSettings, updateSettings } = useSettings();
  const [runtimeSettings, setSettings] = useState<RuntimeSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const [codexCliCommand, setCodexCliCommand] = useState("");
  const [theme, setTheme] = useState<Theme>(() => readCurrentTheme());
  const [minimaxApiKey, setMiniMaxApiKey] = useState("");
  const [minimaxApiBase, setMiniMaxApiBase] = useState("");
  const [minimaxModel, setMiniMaxModel] = useState(DEFAULT_MINIMAX_MODEL);
  const [minimaxModels, setMiniMaxModels] = useState<ModelInfo[]>([]);
  const [minimaxSessionDir, setMiniMaxSessionDir] = useState("");
  const [minimaxMaxSteps, setMiniMaxMaxSteps] = useState(100);
  const [minimaxTokenLimit, setMiniMaxTokenLimit] = useState(80000);

  useEffect(() => {
    let closed = false;
    async function load() {
      try {
        const [settingsResult, modelResult] = await Promise.allSettled([
          settingsApi.get(),
          modelsApi.list(undefined, true)
        ]);
        if (settingsResult.status !== "fulfilled") {
          throw settingsResult.reason;
        }
        const data = settingsResult.value;
        if (!closed) {
          const minimaxOptions =
            modelResult.status === "fulfilled"
              ? (modelResult.value.models ?? []).filter((model) => model.vendor === "minimax")
              : [];
          setMiniMaxModels(minimaxOptions);
          setSettings(data);
          setCodexCliCommand(data.codexCliCommand ?? "");
          const resolvedTheme = data.theme ?? readCurrentTheme();
          setTheme(resolvedTheme);
          setMiniMaxApiKey(data.minimaxApiKey ?? "");
          setMiniMaxApiBase(data.minimaxApiBase ?? "");
          setMiniMaxModel(data.minimaxModel ?? DEFAULT_MINIMAX_MODEL);
          setMiniMaxSessionDir(data.minimaxSessionDir ?? "");
          setMiniMaxMaxSteps(data.minimaxMaxSteps ?? 100);
          setMiniMaxTokenLimit(data.minimaxTokenLimit ?? 80000);
          setError(null);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load settings");
        }
      } finally {
        if (!closed) setLoading(false);
      }
    }
    load();
    return () => {
      closed = true;
    };
  }, []);

  async function onThemeChange(nextTheme: Theme) {
    setTheme(nextTheme);
    applyTheme(nextTheme);
    setThemeSaving(true);
    setError(null);
    try {
      await settingsApi.update({ theme: nextTheme });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save theme");
    } finally {
      setThemeSaving(false);
    }
  }

  async function onSave() {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      const updated = await settingsApi.update({
        codexCliCommand,
        theme,
        minimaxApiKey: minimaxApiKey.trim().length > 0 ? minimaxApiKey.trim() : null,
        minimaxApiBase: minimaxApiBase.trim().length > 0 ? minimaxApiBase.trim() : null,
        minimaxModel,
        minimaxSessionDir: minimaxSessionDir || undefined,
        minimaxMaxSteps,
        minimaxTokenLimit
      });
      setMiniMaxApiKey(updated.minimaxApiKey ?? "");
      setMiniMaxApiBase(updated.minimaxApiBase ?? "");
      applyTheme(theme);
      setSuccess(t.settingsSaved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="settings-page">
        <div className="page-header">
          <h1>{t.settings}</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>{t.loadingSettings}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-page">
      <div className="page-header">
        <h1>{t.settings}</h1>
      </div>

      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">{success}</div>}

      <div className="card">
        <div className="card-header">
          <h3>Dashboard Settings</h3>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px",
            background: "var(--bg-elevated)",
            borderRadius: "8px",
            marginBottom: "16px"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {dashboardSettings.useMockData ? (
              <Database size={20} style={{ color: "var(--accent-warning)" }} />
            ) : (
              <Wifi size={20} style={{ color: "var(--accent-success)" }} />
            )}
            <div>
              <div style={{ fontWeight: 500 }}>Data Source</div>
              <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                {dashboardSettings.useMockData
                  ? "Using mock data for preview (no backend required)"
                  : "Using real backend API data"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              className={`btn ${!dashboardSettings.useMockData ? "btn-primary" : "btn-secondary"}`}
              onClick={() => updateSettings({ useMockData: false })}
            >
              <Wifi size={14} />
              Live API
            </button>
            <button
              className={`btn ${dashboardSettings.useMockData ? "btn-primary" : "btn-secondary"}`}
              onClick={() => updateSettings({ useMockData: true })}
            >
              <Database size={14} />
              Mock Data
            </button>
          </div>
        </div>

        {/* Theme Selector */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px",
            background: "var(--bg-surface)",
            borderRadius: "8px",
            marginBottom: "16px"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Palette size={20} style={{ color: "var(--accent-primary)" }} />
            <div>
              <div style={{ fontWeight: 500 }}>Theme</div>
              <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Choose your preferred color scheme</div>
            </div>
          </div>
          <select
            value={theme}
            onChange={(e) => {
              void onThemeChange(e.target.value as Theme);
            }}
            style={{ width: "auto", minWidth: "150px" }}
          >
            {THEMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {themeSaving && (
            <span style={{ marginLeft: "8px", fontSize: "12px", color: "var(--text-muted)" }}>Saving...</span>
          )}
        </div>

        {dashboardSettings.useMockData && (
          <div
            style={{
              padding: "12px",
              background: "var(--accent-warning)20",
              borderRadius: "6px",
              fontSize: "13px",
              color: "var(--accent-warning)"
            }}
          >
            ⚠️ Mock data mode is enabled. Some features may not work correctly. Switch to "Live API" when the backend is
            available.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>{t.modelRuntime}</h3>
        </div>

        <div
          style={{
            padding: "12px",
            background: "var(--bg-surface)",
            borderRadius: "8px",
            marginBottom: "16px",
            fontSize: "13px",
            color: "var(--text-muted)"
          }}
        >
          <div>
            Host platform: <strong>{runtimeSettings?.hostPlatformLabel ?? "Unknown"}</strong>
            {runtimeSettings?.macosUntested ? " (design-compatible, not fully validated)" : ""}
          </div>
          <div>MiniMax shell policy: {runtimeSettings?.supportedShellTypes?.join(", ") ?? "N/A"}</div>
          <div>Default shell: {runtimeSettings?.defaultShellType ?? "N/A"}</div>
        </div>

        <div className="form-group">
          <label>{t.codex}</label>
          <input
            value={codexCliCommand}
            onChange={(e) => setCodexCliCommand(e.target.value)}
            placeholder={runtimeSettings?.codexCliCommandDefault ?? "codex"}
          />
          <p style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
            Default for this platform: {runtimeSettings?.codexCliCommandDefault ?? "codex"}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>MiniMax Agent</h3>
        </div>

        <div className="form-group">
          <label>API Key</label>
          <input
            type="password"
            value={minimaxApiKey}
            onChange={(e) => setMiniMaxApiKey(e.target.value)}
            placeholder="Enter your MiniMax API key"
          />
        </div>

        <div className="form-group">
          <label>API Base URL</label>
          <input
            value={minimaxApiBase}
            onChange={(e) => setMiniMaxApiBase(e.target.value)}
            placeholder="https://api.minimax.io"
          />
        </div>

        <div className="form-group">
          <label>Model</label>
          <select value={minimaxModel} onChange={(e) => setMiniMaxModel(e.target.value)}>
            {[...new Set([DEFAULT_MINIMAX_MODEL, minimaxModel, ...minimaxModels.map((m) => m.model)])].map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Session Directory (optional)</label>
          <input
            value={minimaxSessionDir}
            onChange={(e) => setMiniMaxSessionDir(e.target.value)}
            placeholder="Leave empty for default (.minimax/sessions)"
          />
          <p style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
            Default: {".minimax/sessions in project root"}
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <div className="form-group">
            <label>Max Steps</label>
            <input
              type="number"
              value={minimaxMaxSteps}
              onChange={(e) => setMiniMaxMaxSteps(parseInt(e.target.value) || 100)}
              min={1}
              max={1000}
            />
          </div>

          <div className="form-group">
            <label>Token Limit</label>
            <input
              type="number"
              value={minimaxTokenLimit}
              onChange={(e) => setMiniMaxTokenLimit(parseInt(e.target.value) || 80000)}
              min={1000}
              max={200000}
            />
          </div>
        </div>
      </div>

      <button className="btn btn-primary" disabled={saving} onClick={onSave} style={{ marginBottom: "24px" }}>
        {saving ? <Loader size={14} className="loading-spinner" /> : <Save size={14} />}
        {saving ? t.saving : t.save}
      </button>
    </section>
  );
}
