import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  CircleDot,
  CloudSun,
  Compass,
  Clock3,
  Gauge,
  LayoutDashboard,
  LogIn,
  LogOut,
  Radio,
  ShieldCheck,
  Thermometer,
  UserPlus,
} from 'lucide-react';
import axios from 'axios';


const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://127.0.0.1:5000';
const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const ACTIVE_ALERT_WINDOW_MS = 5 * 60 * 1000;
const ALERT_STATUSES = new Set(['Outlier', 'High', 'Caution', 'Review', 'Critical']);

const defaultData = {
  node_id: 'N/A',
  vibr_x: 0,
  m_temp: 0,
  press: 0,
  altitude_ft: 0,
  cluster: 0,
  cluster_distance: 0,
  ai_confidence: 0,
  composite_trend_value: 0,
  anomaly: false,
  integrity: 'pending',
  telemetry_quality: 'waiting',
  baseline_status: 'nominal',
  baseline: {
    standard: 'ISA / RTCA DO-160 physical anchors',
    altitude_ft: 0,
    temperature_location: 'internal',
    vibration_normal_g: [0.5, 1.5],
    vibration_critical_g: 5,
    pressure_isa_mb: 1013.25,
    pressure_minimum_mb: 750,
    temperature_isa_c: 15,
    temperature_critical_c: 55,
    status: 'nominal',
    alerts: [],
  },
  security: {
    ids_status: 'CLEAR',
    warning_led: false,
    recent_incidents: [],
  },
};

const historySeed = [28, 44, 32, 51, 46, 68, 59, 73, 66, 78, 71, 84];

const navigationItems = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'flight-data', label: 'Telemetry', icon: Radio },
  { key: 'analysis', label: 'Mesh Analysis', icon: BarChart3 },
  { key: 'alerts', label: 'Alerts', icon: AlertTriangle },
  { key: 'operators', label: 'Operators', icon: ShieldCheck },
];

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function Sidebar({ activeTab, alertCount, onLogout, onTabChange }) {
  return (
    <aside className="hidden min-h-screen w-60 bg-slate-950 text-slate-100 lg:block">
      <div className="border-b border-slate-800 px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-slate-800 text-slate-100">
            <Compass size={20} />
          </div>
          <div>
            <p className="text-sm font-semibold">AeroGauge</p>
            <p className="text-xs text-slate-400">Flight intelligence</p>
          </div>
        </div>
      </div>
      <nav className="px-3 py-4">
        {navigationItems.map((item) => (
          <button
            className={`mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition ${
              activeTab === item.key ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-200 hover:bg-white/10'
            }`}
            key={item.label}
            onClick={() => onTabChange(item.key)}
          >
            <item.icon size={18} />
            <span className="flex-1 text-left">{item.label}</span>
            {item.key === 'alerts' && alertCount > 0 && (
              <span className="min-w-6 rounded-full bg-red-500 px-2 py-0.5 text-center text-xs font-semibold text-white">
                {alertCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="absolute bottom-0 w-60 border-t border-white/10 p-3">
        <button className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/10" onClick={onLogout}>
          <LogOut size={18} />
          Sign out
        </button>
      </div>
    </aside>
  );
}

function MobileTabBar({ activeTab, alertCount, onTabChange }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white px-2 pb-2 pt-2 shadow-[0_-8px_24px_rgba(15,23,42,0.12)] lg:hidden">
      <div className="grid grid-cols-5 gap-1">
        {navigationItems.map((item) => (
          <button
            className={`relative flex min-h-14 flex-col items-center justify-center rounded-md px-1 text-[11px] font-semibold transition ${
              activeTab === item.key ? 'bg-sky-50 text-sky-700' : 'text-slate-500 hover:bg-slate-50'
            }`}
            key={item.key}
            onClick={() => onTabChange(item.key)}
            type="button"
          >
            <item.icon size={18} />
            <span className="mt-1 max-w-full truncate">{item.label}</span>
            {item.key === 'alerts' && alertCount > 0 && (
              <span className="absolute right-2 top-1 min-w-5 rounded-full bg-red-500 px-1 text-center text-[10px] font-semibold text-white">
                {alertCount}
              </span>
            )}
          </button>
        ))}
      </div>
    </nav>
  );
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [operatorId, setOperatorId] = useState('');
  const [fullName, setFullName] = useState('');
  const [organisation, setOrganisation] = useState('Aero-Mesh Operations');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const googleButtonRef = useRef(null);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !googleButtonRef.current) {
      return undefined;
    }

    const renderGoogleButton = () => {
      if (!window.google || !googleButtonRef.current) {
        return false;
      }

      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (response) => {
          setIsLoading(true);
          setMessage('');
          try {
            const result = await axios.post(`${API_BASE_URL}/auth/google`, {
              credential: response.credential,
              organisation,
            });
            localStorage.setItem('flight_auth', JSON.stringify(result.data));
            onAuthenticated(result.data);
          } catch (error) {
            setMessage(error.response?.data?.message || 'Google sign-up could not be completed');
          } finally {
            setIsLoading(false);
          }
        },
      });

      googleButtonRef.current.innerHTML = '';
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'outline',
        size: 'large',
        width: googleButtonRef.current.offsetWidth || 320,
        text: mode === 'signup' ? 'signup_with' : 'signin_with',
      });
      return true;
    };

    if (renderGoogleButton()) {
      return undefined;
    }

    const interval = setInterval(() => {
      if (renderGoogleButton()) {
        clearInterval(interval);
      }
    }, 300);

    return () => clearInterval(interval);
  }, [mode, onAuthenticated, organisation]);

  async function handleSubmit(event) {
    event.preventDefault();
    setIsLoading(true);
    setMessage('');

    try {
      const endpoint = mode === 'login' ? '/auth/login' : '/auth/signup';
      const payload = mode === 'login'
        ? { operator_id: operatorId, password }
        : { operator_id: operatorId, full_name: fullName, organisation, password };

      const response = await axios.post(`${API_BASE_URL}${endpoint}`, payload);
      localStorage.setItem('flight_auth', JSON.stringify(response.data));
      onAuthenticated(response.data);
    } catch (error) {
      setMessage(error.response?.data?.message || 'Unable to connect to authentication service');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#eaf5ff] text-slate-900">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center px-6 py-10">
        <div className="grid w-full overflow-hidden rounded-lg border border-sky-100 bg-white shadow-xl lg:grid-cols-[0.95fr_1.05fr]">
          <section className="bg-[#083763] p-8 text-white">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-md bg-sky-400 text-[#083763]">
                <Compass size={24} />
              </div>
              <div>
                <h1 className="text-xl font-semibold">AeroGauge</h1>
                <p className="text-sm text-sky-200">Aviation mesh intelligence</p>
              </div>
            </div>
            <div className="mt-16 max-w-md">
              <p className="text-xs font-semibold uppercase text-sky-300">Operator access</p>
              <h2 className="mt-3 text-4xl font-semibold leading-tight">Aviation-grade telemetry command</h2>
              <p className="mt-4 leading-7 text-sky-100">
                Sign in for real-time mesh analysis and secure operator review of flight health telemetry.
              </p>
            </div>
            <div className="mt-12 grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              {[
                ['Mesh Telemetry', 'Secure gateway active'],
                ['Model Intelligence', 'Aviation-grade review'],
                ['Operator Audit', 'Database-backed access'],
              ].map(([title, body]) => (
                <div className="rounded-lg border border-white/10 bg-white/10 p-4" key={title}>
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="mt-1 text-xs text-sky-200">{body}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="p-8">
            <div className="mb-6 flex rounded-md bg-slate-100 p-1">
              <button className={`flex-1 rounded-md px-4 py-2 text-sm font-semibold ${mode === 'login' ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-500'}`} onClick={() => setMode('login')}>
                Sign in
              </button>
              <button className={`flex-1 rounded-md px-4 py-2 text-sm font-semibold ${mode === 'signup' ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-500'}`} onClick={() => setMode('signup')}>
                Sign up
              </button>
            </div>

            <div className="mb-6">
              <h2 className="text-2xl font-semibold text-slate-950">{mode === 'login' ? 'Welcome back' : 'Create operator account'}</h2>
              <p className="mt-1 text-sm text-slate-500">{mode === 'login' ? 'Use your registered operator ID.' : 'Register an operator before opening the dashboard.'}</p>
            </div>

            <form className="space-y-4" onSubmit={handleSubmit}>
              {mode === 'signup' && (
                <>
                  <label className="block">
                    <span className="text-sm font-medium text-slate-700">Full name</span>
                    <input
                      className="mt-2 w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-4 focus:ring-sky-100"
                      value={fullName}
                      onChange={(event) => setFullName(event.target.value)}
                      placeholder="e.g. Precious Operator"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-medium text-slate-700">Organisation</span>
                    <input
                      className="mt-2 w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-4 focus:ring-sky-100"
                      value={organisation}
                      onChange={(event) => setOrganisation(event.target.value)}
                      placeholder="e.g. Aero-Mesh Operations"
                    />
                  </label>
                </>
              )}
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Operator ID</span>
                <input
                  className="mt-2 w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-4 focus:ring-sky-100"
                  value={operatorId}
                  onChange={(event) => setOperatorId(event.target.value)}
                  placeholder="e.g. OPS-001"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Password</span>
                <input
                  className="mt-2 w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-3 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-4 focus:ring-sky-100"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Minimum 6 characters"
                />
              </label>
              {message && <div className="rounded-md border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</div>}
              <button className="flex w-full items-center justify-center gap-2 rounded-md bg-sky-700 px-4 py-3 font-semibold text-white shadow-sm transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-slate-400" disabled={isLoading} type="submit">
                {mode === 'login' ? <LogIn size={18} /> : <UserPlus size={18} />}
                {isLoading ? 'Please wait...' : mode === 'login' ? 'Enter dashboard' : 'Create and enter'}
              </button>
            </form>

            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200"></div>
              <span className="text-xs font-semibold uppercase text-slate-400">or</span>
              <div className="h-px flex-1 bg-slate-200"></div>
            </div>
            {GOOGLE_CLIENT_ID ? (
              <div className="flex w-full justify-center" ref={googleButtonRef}></div>
            ) : (
              <button
                className="flex w-full cursor-not-allowed items-center justify-center rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-400"
                disabled
                type="button"
              >
                Google sign-up needs a client ID
              </button>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function StatCard({ label, value, unit, icon: Icon, color, change }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-slate-400">{label}</span>
        <div className={`flex h-9 w-9 items-center justify-center rounded-md ${color}`}>
          <Icon size={19} />
        </div>
      </div>
      <div className="mt-4 flex items-end gap-2">
        <span className="font-mono text-3xl font-semibold text-slate-950">{value}</span>
        <span className="pb-1 text-sm text-slate-500">{unit}</span>
      </div>
      <p className="mt-3 text-xs font-medium text-slate-500">{change}</p>
    </section>
  );
}

// ─── FIX: TelemetryChart now uses SVG so bar heights always render correctly ───
// The original used `height: ${point}%` on flex children inside a div with
// h-64. Percentage heights on flex children are not reliably resolved by
// browsers because the flex container's height is layout-determined, not a
// definite containing-block height. SVG avoids this entirely — bar heights
// are expressed in SVG user units, which always resolve.
function TelemetryChart({ data }) {
  const SVG_W = 520;
  const SVG_H = 200;
  const PADDING = { top: 10, right: 8, bottom: 24, left: 8 };
  const chartH = SVG_H - PADDING.top - PADDING.bottom;
  const chartW = SVG_W - PADDING.left - PADDING.right;
  const count = historySeed.length;

  const points = historySeed.map((base, index) => {
    const confidencePressure = Math.max(0, 100 - (data.ai_confidence ?? 0)) * 0.03;
    const live = data.composite_trend_value ?? (data.vibr_x * 2 + Math.max(0, data.m_temp - 25) * 0.1 + data.cluster_distance * 0.5 + confidencePressure);
    return Math.max(12, Math.min(92, base * 0.65 + live * 0.35 + (index % 3) * 3));
  });

  const barW = (chartW / count) * 0.6;
  const gap = chartW / count;
  const isAlert = data.anomaly;

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-sm xl:col-span-2">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-white">Telemetry Trend</h2>
          <p className="mt-1 text-sm text-slate-400">Composite signal from vibration, temperature, pressure, and model confidence.</p>
        </div>
        <span className="rounded-md bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100">LIVE</span>
      </div>

      <svg
        className="mt-6 w-full"
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Telemetry trend bar chart"
      >
        {/* axis lines */}
        <line
          x1={PADDING.left} y1={PADDING.top}
          x2={PADDING.left} y2={PADDING.top + chartH}
          stroke="#334155" strokeWidth="1"
        />
        <line
          x1={PADDING.left} y1={PADDING.top + chartH}
          x2={PADDING.left + chartW} y2={PADDING.top + chartH}
          stroke="#334155" strokeWidth="1"
        />

        {points.map((pct, index) => {
          const barH = (pct / 100) * chartH;
          const x = PADDING.left + index * gap + (gap - barW) / 2;
          const y = PADDING.top + chartH - barH;
          const fill = isAlert
            ? index === count - 1 ? '#ef4444' : '#f87171'
            : index === count - 1 ? '#38bdf8' : '#475569';

          return (
            <g key={index}>
              <rect
                x={x} y={y}
                width={barW} height={barH}
                rx="3" ry="3"
                fill={fill}
                opacity={index === count - 1 ? 1 : 0.7}
              />
              <text
                x={x + barW / 2}
                y={PADDING.top + chartH + 14}
                textAnchor="middle"
                fontSize="9"
                fill="#64748b"
              >
                {index + 1}
              </text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}

function MiniWave({ data }) {
  const values = [18, 31, 26, 47, 34, 58, 43, 61, 52, 68, 57, 75].map((value, index) => {
    return Math.min(92, value + data.cluster_distance * 2 + (data.anomaly ? index : 0));
  });
  const polyline = values.map((value, index) => `${index * 24},${100 - value}`).join(' ');

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-sm">
      <div className="flex items-center gap-3 text-slate-100">
        <Gauge size={21} />
        <h2 className="font-semibold text-white">Mesh Health Profile</h2>
      </div>
      <div className="mt-5 flex items-end justify-between">
        <div>
          <p className="text-sm text-slate-400">Mesh deviation score</p>
          <p className="mt-1 font-mono text-4xl font-semibold text-white">{data.cluster_distance.toFixed(2)}</p>
          <p className="mt-2 text-sm text-slate-400">Confidence {Number(data.ai_confidence ?? 0).toFixed(0)}%</p>
        </div>
        <span className={`rounded-md px-3 py-2 text-xs font-semibold ${data.anomaly ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
          {data.anomaly ? 'OUTLIER' : 'IN RANGE'}
        </span>
      </div>
      <svg className="mt-6 h-28 w-full" viewBox="0 0 264 100" role="img" aria-label="Mesh health profile">
        <polyline fill="none" points={polyline} stroke="#f8fafc" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />
        <line stroke="#fecaca" strokeDasharray="5 5" strokeWidth="2" x1="0" x2="264" y1="35" y2="35" />
      </svg>
    </section>
  );
}

function SecurityPanel({ security }) {
  const incidents = security?.recent_incidents || [];
  const hasAlert = security?.ids_status === 'ALERT';

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-md ${hasAlert ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
            {hasAlert ? <AlertTriangle size={21} /> : <ShieldCheck size={21} />}
          </div>
          <div>
            <h2 className="font-semibold text-slate-950">Intrusion Detection</h2>
            <p className="mt-1 text-sm text-slate-500">Login, device, packet, and network checks.</p>
          </div>
        </div>
        <span className={`rounded-md px-3 py-2 text-xs font-semibold ${hasAlert ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
          {security?.ids_status || 'CLEAR'}
        </span>
      </div>

      <div className="mt-5">
        <div className={`rounded-md border p-3 ${security?.warning_led ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-100 bg-slate-50 text-slate-600'}`}>
          <p className="text-xs font-semibold uppercase">Warning LED</p>
          <p className="mt-1 text-sm font-semibold">{security?.warning_led ? 'Flashing' : 'Standby'}</p>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-md border border-slate-100">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-4 py-3 font-semibold">Event</th>
              <th className="px-4 py-3 font-semibold">Severity</th>
              <th className="px-4 py-3 font-semibold">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {incidents.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan="3">No security incidents recorded.</td>
              </tr>
            ) : incidents.slice(0, 5).map((incident, index) => (
              <tr key={`${incident.created_at}-${index}`}>
                <td className="px-4 py-3 font-medium text-slate-700">{incident.event_type}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-md px-2 py-1 text-xs font-semibold ${incident.severity === 'critical' || incident.severity === 'high' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                    {incident.severity}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">{incident.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function getAlertRows(data) {
  const hasTelemetry = hasLiveTelemetry(data);

  return [
    ['Mesh packet', data.node_id, data.anomaly ? 'Review' : 'Clean'],
    ['Vibration', data.vibr_x.toFixed(3), data.vibr_x > 0.5 ? 'High' : 'Stable'],
    ['Motor temp', `${data.m_temp.toFixed(1)} deg C`, data.m_temp > 40 ? 'Caution' : 'Normal'],
    ['Pressure', `${data.press.toFixed(0)} hPa`, 'Tracked'],
    ['Mesh deviation score', data.cluster_distance.toFixed(2), data.anomaly ? 'Outlier' : 'Accepted'],
    ['AI Confidence', `${Number(data.ai_confidence ?? 0).toFixed(0)}%`, data.ai_confidence < 50 ? 'Review' : 'High'],
    ['Integrity', data.integrity || 'pending', data.integrity === 'verified' ? 'Verified' : hasTelemetry ? 'Review' : 'Pending'],
  ];
}

function hasLiveTelemetry(data) {
  return data.node_id !== 'N/A' && data.telemetry_quality !== 'waiting';
}

function getAlertCount(data) {
  if (!data.anomaly) return 0;
  const baseline = data.baseline || {};
  const baselineAlerts = (baseline.alerts || []).length;
  return Math.max(1, baselineAlerts);
}

function formatSessionHoursRemaining(expiresAt) {
  if (!expiresAt) return '?';
  const diff = new Date(expiresAt) - Date.now();
  return Math.max(0, Math.round(diff / 3600000));
}

function buildAnalysis(data) {
  if (!hasLiveTelemetry(data)) {
    return 'No live telemetry received yet. Connect the ESP32 gateway and start the flight intelligence processor.';
  }
  if (data.anomaly) {
    const source = data.classification_source === 'baseline' ? 'physical DO-160 boundary violation' : 'KMeans model anomaly';
    return `ANOMALY DETECTED via ${source}. Vibration ${data.vibr_x.toFixed(3)} G, temperature ${data.m_temp.toFixed(1)} °C, pressure ${data.press.toFixed(0)} hPa. Cluster distance ${data.cluster_distance.toFixed(2)} exceeds learned nominal envelope. Operator review required.`;
  }
  return `All sensor channels nominal. Vibration ${data.vibr_x.toFixed(3)} G within DO-160 bounds. Temperature ${data.m_temp.toFixed(1)} °C and pressure ${data.press.toFixed(0)} hPa within ISA reference. Model confidence ${data.ai_confidence.toFixed(0)}%.`;
}

function TelemetryCards({ data }) {
  // Altitude arrives in feet (converted from metres in flight_intelligence.py)
  // AI Confidence now lives only in the Alerts tab (see getAlertRows) — keeping
  // the main dashboard focused on raw sensor readings.
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <StatCard label="Vibration" value={data.vibr_x.toFixed(3)} unit="G" icon={Activity} color="bg-sky-50 text-sky-700" change="Airframe vibration index" />
      <StatCard label="Motor Temp" value={data.m_temp.toFixed(1)} unit="deg C" icon={Thermometer} color="bg-orange-50 text-orange-700" change="Thermal stable" />
      <StatCard label="Pressure" value={data.press.toFixed(0)} unit="hPa" icon={CloudSun} color="bg-teal-50 text-teal-700" change="Environmental pressure" />
      <StatCard label="Altitude" value={data.altitude_ft.toFixed(0)} unit="ft" icon={CircleDot} color="bg-violet-50 text-violet-700" change="Flight altitude reference" />
      <StatCard label="Node" value={data.node_id} unit="" icon={Radio} color="bg-emerald-50 text-emerald-700" change="Active mesh node" />
    </div>
  );
}

function FlightDataView({ data }) {
  const rows = [
    ['Node ID', data.node_id],
    ['Vibration X', `${data.vibr_x.toFixed(3)} G`],
    ['Motor Temperature', `${data.m_temp.toFixed(1)} °C`],
    ['Pressure', `${data.press.toFixed(2)} hPa`],
    ['Altitude', `${data.altitude_ft.toFixed(0)} ft  (${(data.altitude_ft / 3.28084).toFixed(1)} m)`],
    ['Cluster', data.cluster],
    ['Cluster Distance', data.cluster_distance.toFixed(3)],
    ['Anomaly', data.anomaly ? 'YES' : 'No'],
    ['Hard Boundary', data.hard_boundary ? 'YES' : 'No'],
    ['Classification', data.classification],
    ['Classification Source', data.classification_source],
    ['Telemetry Quality', data.telemetry_quality],
    ['Integrity', data.integrity],
    ['Received At', data.received_at ? new Date(data.received_at).toLocaleTimeString() : '—'],
  ];

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold text-slate-950">Raw Telemetry Stream</h2>
      <p className="mt-1 text-sm text-slate-500">Live sensor packet from the active mesh node. ISA baseline and DO-160 limits are on the Mesh Analysis tab.</p>
      <div className="mt-4 overflow-hidden rounded-md border border-slate-100">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-4 py-3 font-semibold">Field</th>
              <th className="px-4 py-3 font-semibold">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(([field, value]) => (
              <tr key={field}>
                <td className="px-4 py-3 font-medium text-slate-700">{field}</td>
                <td className="px-4 py-3 font-mono text-slate-600">{String(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AnalysisView({ data }) {
  const baseline = data.baseline || {};
  const alerts = baseline.alerts || [];

  const rows = [
    ['ISA Standard', baseline.standard ?? '—', 'Reference'],
    ['Altitude Reference', `${baseline.altitude_ft ?? 0} ft`, 'Reference'],
    ['ISA Pressure', `${baseline.pressure_isa_mb ?? '—'} mb`, 'Reference'],
    ['ISA Temperature', `${baseline.temperature_isa_c ?? '—'} °C`, 'Reference'],
    ['Vibration Normal', baseline.vibration_normal_g ? `${baseline.vibration_normal_g[0]}–${baseline.vibration_normal_g[1]} G` : '—', 'Normal'],
    ['Vibration Critical', `${baseline.vibration_critical_g ?? '—'} G`, 'Limit'],
    ['Pressure Minimum', `${baseline.pressure_minimum_mb ?? '—'} mb`, 'Limit'],
    ['Temperature Critical', `${baseline.temperature_critical_c ?? '—'} °C`, 'Limit'],
    ['Baseline Status', baseline.status ?? 'nominal', baseline.status === 'critical' ? 'Critical' : 'Nominal'],
    ['KMeans Cluster', data.cluster, 'Model'],
    ['Cluster Distance', data.cluster_distance.toFixed(3), data.anomaly ? 'Outlier' : 'Accepted'],
    ['AI Confidence', `${data.ai_confidence.toFixed(1)}%`, data.ai_confidence < 50 ? 'Review' : 'High'],
    ['Composite Trend', data.composite_trend_value?.toFixed(2) ?? '—', 'Composite'],
  ];

  return (
    <div className="space-y-5">
      {alerts.length > 0 && (
        <section className="rounded-lg border border-red-200 bg-red-50 p-4">
          <h2 className="font-semibold text-red-800">Active Baseline Alerts</h2>
          <div className="mt-3 space-y-2">
            {alerts.map((alert, index) => (
              <div key={index} className="rounded-md border border-red-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-red-700">{alert.sensor}</span>
                  <span className="rounded-md bg-red-100 px-2 py-0.5 text-xs font-semibold uppercase text-red-700">{alert.severity}</span>
                </div>
                <p className="mt-1 text-sm text-red-600">{alert.message}</p>
                <p className="mt-1 font-mono text-xs text-slate-500">Observed: {alert.observed} | Limit: {alert.limit}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="font-semibold text-slate-950">Mesh Analysis</h2>
        <p className="mt-1 text-sm text-slate-500">ISA baseline, DO-160 limits, and KMeans model output.</p>
        <div className="mt-4 overflow-hidden rounded-md border border-slate-100">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-3 font-semibold">Signal</th>
                <th className="px-4 py-3 font-semibold">Value</th>
                <th className="px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(([signal, value, rowStatus]) => (
                <tr key={signal}>
                  <td className="px-4 py-3 font-medium text-slate-700">{signal}</td>
                  <td className="px-4 py-3 font-mono text-slate-600">{value}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-md px-2 py-1 text-xs font-semibold ${ALERT_STATUSES.has(rowStatus) ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
                      {rowStatus}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function AlertsView({ data }) {
  const rows = getAlertRows(data);
  const explanation = buildAnalysis(data);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-slate-950">Alert Queue</h2>
          <p className="mt-1 text-sm text-slate-500">Sensor and model-derived alerts for operator review.</p>
        </div>
        <span className={`rounded-md px-3 py-2 text-xs font-semibold ${data.anomaly ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
          {data.anomaly ? 'ANOMALY' : 'CLEAR'}
        </span>
      </div>
      <div className={`mt-4 rounded-md border p-4 ${data.anomaly ? 'border-red-200 bg-red-50' : 'border-slate-100 bg-slate-50'}`}>
        <p className={`text-xs font-semibold uppercase ${data.anomaly ? 'text-red-700' : 'text-slate-400'}`}>What's happening</p>
        <p className={`mt-2 text-sm leading-6 ${data.anomaly ? 'text-red-700' : 'text-slate-600'}`}>{explanation}</p>
      </div>
      <div className="mt-5 overflow-hidden rounded-md border border-slate-100">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-4 py-3 font-semibold">Signal</th>
              <th className="px-4 py-3 font-semibold">Value</th>
              <th className="px-4 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(([signal, value, rowStatus]) => (
              <tr key={signal}>
                <td className="px-4 py-3 font-medium text-slate-700">{signal}</td>
                <td className="px-4 py-3 font-mono text-slate-600">{value}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-md px-2 py-1 text-xs font-semibold ${ALERT_STATUSES.has(rowStatus) ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
                    {rowStatus}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OperatorsView({ operator, operators }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="font-semibold text-slate-950">Organisation Operators</h2>
          <p className="mt-1 text-sm text-slate-500">Only authenticated operators in {operator?.organisation || 'this organisation'} can see this list.</p>
        </div>
        <span className="rounded-md bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-700">{operators.length} ACTIVE</span>
      </div>
      <div className="mt-5 overflow-hidden rounded-md border border-slate-100">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-4 py-3 font-semibold">Operator</th>
              <th className="px-4 py-3 font-semibold">Operator ID</th>
              <th className="px-4 py-3 font-semibold">Organisation</th>
              <th className="px-4 py-3 font-semibold">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {operators.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan="4">No operators found for this organisation.</td>
              </tr>
            ) : operators.map((item) => (
              <tr key={item.operator_id}>
                <td className="px-4 py-3 font-medium text-slate-700">{item.full_name}</td>
                <td className="px-4 py-3 font-mono text-slate-600">{item.operator_id}</td>
                <td className="px-4 py-3 text-slate-600">{item.organisation}</td>
                <td className="px-4 py-3 text-slate-500">{new Date(item.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Dashboard({ activeTab, data, operator, operators, sessionExpiresAt, onLogout, onTabChange }) {
  const status = data.anomaly ? 'Alert Review' : 'Nominal';
  const statusTone = data.anomaly ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200';
  const operatorName = operator?.full_name || operator?.operator_id || 'Operator';
  const alertCount = getAlertCount(data);
  const sessionHours = formatSessionHoursRemaining(sessionExpiresAt);

  const analysis = useMemo(() => {
    return buildAnalysis(data);
  }, [data]);

  const tabTitles = {
    dashboard: ['Real-time flight health', 'Operations Dashboard'],
    'flight-data': ['Sensor telemetry stream', 'Flight Data'],
    analysis: ['Mesh telemetry explanation', 'Mesh Analysis'],
    alerts: ['Operator alert queue', 'Alerts'],
    operators: ['Organisation access control', 'Operators'],
  };
  const [eyebrow, title] = tabTitles[activeTab] || tabTitles.dashboard;

  return (
    <main className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar activeTab={activeTab} alertCount={alertCount} onLogout={onLogout} onTabChange={onTabChange} />
      <section className="min-w-0 flex-1">
        <header className="border-b border-slate-800 bg-slate-950">
          <div className="flex flex-col gap-4 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase text-slate-400">{eyebrow}</p>
              <h1 className="mt-1 text-2xl font-semibold text-white">{title}</h1>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold ${statusTone}`}>
                {data.anomaly ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
                {status}
              </div>
              <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200">
                <Clock3 size={17} />
                {sessionHours}h session
              </div>
              <div className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200">
                {operatorName}
              </div>
              <button className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-500 hover:text-white lg:hidden" onClick={onLogout}>
                <LogOut size={17} />
                Sign out
              </button>
            </div>
          </div>
        </header>

        <div className="pb-24 p-5 lg:pb-5">
          {activeTab === 'dashboard' && (
            <>
              <TelemetryCards data={data} />
              <section className="mt-4 grid gap-4 xl:grid-cols-3">
                <TelemetryChart data={data} />
                <MiniWave data={data} />
              </section>
              <section className="mt-4 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="font-semibold text-slate-950">Mesh Analysis</h2>
                  <p className="mt-3 leading-7 text-slate-600">{analysis}</p>
                  <div className="mt-5 rounded-md bg-slate-50 p-4">
                    <p className="text-xs font-semibold uppercase text-slate-400">Model basis</p>
                    <p className="mt-2 text-sm text-slate-600">Filtered vibration, temperature, and pressure are compared with the learned healthy operating profile.</p>
                  </div>
                </div>
                <SecurityPanel security={data.security} />
              </section>
            </>
          )}
          {activeTab === 'flight-data' && <FlightDataView data={data} />}
          {activeTab === 'analysis' && <AnalysisView data={data} />}
          {activeTab === 'alerts' && <AlertsView data={data} />}
          {activeTab === 'operators' && <OperatorsView operator={operator} operators={operators} />}
        </div>
      </section>
      <MobileTabBar activeTab={activeTab} alertCount={alertCount} onTabChange={onTabChange} />
    </main>
  );
}

function App() {
  const [data, setData] = useState(defaultData);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [operators, setOperators] = useState([]);
  const [session, setSession] = useState(() => {
    const saved = localStorage.getItem('flight_auth');
    return saved ? JSON.parse(saved) : null;
  });

  useEffect(() => {
    if (!session?.token) {
      return undefined;
    }

    const fetchData = () => {
      axios.get(`${API_BASE_URL}/data`, { headers: authHeaders(session.token) })
        .then((res) => setData({ ...defaultData, ...res.data }))
        .catch((error) => {
          if (error.response?.status === 401) {
            localStorage.removeItem('flight_auth');
            setSession(null);
          }
        });
    };

    fetchData();
    const interval = setInterval(fetchData, 1000);
    return () => clearInterval(interval);
  }, [session]);

  useEffect(() => {
    if (!session?.token) {
      setOperators([]);
      return undefined;
    }

    const fetchOperators = () => {
      axios.get(`${API_BASE_URL}/operators`, { headers: authHeaders(session.token) })
        .then((res) => setOperators(res.data.operators || []))
        .catch((error) => {
          if (error.response?.status === 401) {
            localStorage.removeItem('flight_auth');
            setSession(null);
          }
        });
    };

    fetchOperators();
    return undefined;
  }, [session]);

  function handleLogout() {
    localStorage.removeItem('flight_auth');
    setSession(null);
    setData(defaultData);
    setActiveTab('dashboard');
    setOperators([]);
  }

  if (!session?.token) {
    return <AuthScreen onAuthenticated={setSession} />;
  }

  return (
    <Dashboard
      activeTab={activeTab}
      data={data}
      operator={session.operator}
      operators={operators}
      sessionExpiresAt={session.expires_at}
      onLogout={handleLogout}
      onTabChange={setActiveTab}
    />
  );
}

export default App;