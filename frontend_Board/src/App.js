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

function TelemetryChart({ data }) {
  const points = historySeed.map((base, index) => {
    const confidencePressure = Math.max(0, 100 - (data.ai_confidence ?? 0)) * 0.03;
    const live = data.composite_trend_value ?? (data.vibr_x * 2 + Math.max(0, data.m_temp - 25) * 0.1 + data.cluster_distance * 0.5 + confidencePressure);
    return Math.max(12, Math.min(92, base * 0.65 + live * 0.35 + (index % 3) * 3));
  });

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-sm xl:col-span-2">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-white">Telemetry Trend</h2>
          <p className="mt-1 text-sm text-slate-400">Composite signal from vibration, temperature, pressure, and model confidence.</p>
        </div>
        <span className="rounded-md bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100">LIVE</span>
      </div>
      <div className="mt-6 flex h-64 items-end gap-3 border-b border-l border-slate-700 px-2 pb-2">
        {points.map((point, index) => (
          <div className="flex flex-1 flex-col items-center gap-2" key={index}>
            <div className="w-full rounded-t-md bg-slate-600 transition-all" style={{ height: `${point}%` }}></div>
            <span className="text-[10px] font-medium text-slate-500">{index + 1}</span>
          </div>
        ))}
      </div>
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
    ['Integrity', data.integrity || 'pending', data.integrity === 'verified' ? 'Verified' : hasTelemetry ? 'Review' : 'Pending'],
  ];
}

function hasLiveTelemetry(data) {
  return data.telemetry_quality !== 'waiting' && data.node_id !== 'None' && data.node_id !== 'N/A';
}

function isRecentIncident(incident) {
  if (!incident?.created_at) {
    return false;
  }

  const createdAt = new Date(incident.created_at).getTime();
  return Number.isFinite(createdAt) && Date.now() - createdAt <= ACTIVE_ALERT_WINDOW_MS;
}

function getActiveAlertRows(data) {
  if (!hasLiveTelemetry(data)) {
    return [];
  }

  return getAlertRows(data).filter(([, , rowStatus]) => ALERT_STATUSES.has(rowStatus));
}

function getAlertCount(data) {
  const signalAlerts = getActiveAlertRows(data).length;
  const incidentAlerts = data.security?.recent_incidents?.filter((incident) => (
    isRecentIncident(incident) && (
      incident.severity === 'medium' || incident.severity === 'high' || incident.severity === 'critical'
    )
  )).length || 0;
  return signalAlerts + incidentAlerts;
}

function getWrittenAlerts(data) {
  const telemetryMessages = getActiveAlertRows(data).map(([signal, value, rowStatus]) => {
    const descriptions = {
      'Mesh packet': `The latest mesh telemetry packet from ${value} needs operator review because the pattern was marked abnormal.`,
      Vibration: `Vibration is high at ${value} G. Inspect the airframe reading before continuing normal monitoring.`,
      'Motor temp': `Motor temperature is in caution range at ${value}. Check cooling and operating load.`,
      Pressure: `Pressure reading is being tracked at ${value}.`,
      'Mesh deviation score': `Mesh deviation score is ${value}, outside the learned healthy operating profile.`,
      Integrity: `Telemetry integrity is ${value}. Review packet verification before trusting this feed.`,
    };

    return {
      key: `telemetry-${signal}`,
      title: `${signal}: ${rowStatus}`,
      message: descriptions[signal] || `${signal} reported ${rowStatus.toLowerCase()} with value ${value}.`,
      tone: rowStatus === 'Caution' ? 'amber' : 'red',
    };
  });

  const securityMessages = (data.security?.recent_incidents || [])
    .filter((incident) => (
      isRecentIncident(incident)
      && ['medium', 'high', 'critical'].includes(incident.severity)
    ))
    .map((incident, index) => ({
      key: `security-${incident.created_at}-${index}`,
      title: `${incident.event_type}: ${incident.severity}`,
      message: `${incident.details || 'A security incident was recorded.'} Source: ${incident.source || 'unknown'}.`,
      tone: incident.severity === 'medium' ? 'amber' : 'red',
    }));

  return [...telemetryMessages, ...securityMessages];
}

function buildAnalysis(data) {
  const vibrationState = data.vibr_x > 0.5 ? 'higher than expected' : 'within the expected range';
  const thermalState = data.m_temp > 40 ? 'showing thermal caution' : 'thermally stable';
  const pressureState = data.press > 0 ? `pressure is tracking at ${data.press.toFixed(0)} hPa` : 'pressure has not reported a live value yet';

  if (data.anomaly) {
    return `Mesh analysis is marking this telemetry pattern as outside the healthy operating envelope. Vibration is ${vibrationState}, motor temperature is ${thermalState}, and ${pressureState}. The operator should review the telemetry packet and airframe condition before continuing normal flight observation.`;
  }

  return `Mesh analysis is accepting the latest telemetry as normal. The deviation score is ${data.cluster_distance.toFixed(2)}, vibration is ${vibrationState}, motor temperature is ${thermalState}, and ${pressureState}. Continue monitoring the feed because any sharp movement in distance or temperature will change this assessment in real time.`;
}

function formatSessionHoursRemaining(expiresAt) {
  if (!expiresAt) {
    return '12.0';
  }

  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) {
    return '12.0';
  }

  return Math.max(0, remainingMs / (1000 * 60 * 60)).toFixed(1);
}

function TelemetryCards({ data }) {
  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <StatCard icon={Activity} label="Vibration" value={data.vibr_x.toFixed(3)} unit="G" color="bg-sky-50 text-sky-700" change="Airframe vibration index" />
      <StatCard icon={Thermometer} label="Motor Temp" value={data.m_temp.toFixed(1)} unit="deg C" color="bg-amber-50 text-amber-700" change={data.m_temp > 40 ? 'Thermal caution' : 'Thermal stable'} />
      <StatCard icon={CloudSun} label="Pressure" value={data.press.toFixed(0)} unit="hPa" color="bg-cyan-50 text-cyan-700" change="Environmental pressure" />
      <StatCard icon={CircleDot} label="Node" value={data.node_id} unit="" color="bg-emerald-50 text-emerald-700" change="Active mesh node" />
    </section>
  );
}

function FlightDataView({ data }) {
  const telemetryRows = [
    ['Node ID', data.node_id],
    ['Vibration X', `${data.vibr_x.toFixed(3)} G`],
    ['Motor temperature', `${data.m_temp.toFixed(1)} deg C`],
    ['Pressure', `${data.press.toFixed(0)} hPa`],
    ['Altitude reference', `${Number(data.altitude_ft ?? 0).toFixed(0)} ft`],
    ['Mesh profile group', data.cluster ?? 0],
    ['Mesh deviation score', data.cluster_distance.toFixed(2)],
    ['Model confidence', `${Number(data.ai_confidence ?? 0).toFixed(0)}%`],
    ['Composite trend', (data.composite_trend_value ?? 0).toFixed(2)],
    ['Telemetry integrity', data.integrity || 'pending'],
  ];

  return (
    <>
      <TelemetryCards data={data} />
      <section className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <TelemetryChart data={data} />
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold text-slate-950">Live Sensor Telemetry</h2>
          <p className="mt-1 text-sm text-slate-500">Real-time values received from the secure mesh gateway and backend inference.</p>
          <div className="mt-4 overflow-hidden rounded-md border border-slate-100">
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-slate-100">
                {telemetryRows.map(([label, value]) => (
                  <tr key={label}>
                    <td className="px-4 py-3 font-medium text-slate-500">{label}</td>
                    <td className="px-4 py-3 font-mono text-slate-800">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

function AnalysisView({ data }) {
  const analysis = buildAnalysis(data);

  return (
    <section className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
      <MiniWave data={data} />
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-950">Live Mesh Analysis</h2>
            <p className="mt-1 text-sm text-slate-500">Operational explanation generated from the current telemetry state.</p>
          </div>
          <span className={`rounded-md px-3 py-2 text-xs font-semibold ${data.anomaly ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
            {data.anomaly ? 'OUTLIER' : 'IN RANGE'}
          </span>
        </div>
        <p className="mt-5 leading-7 text-slate-700">{analysis}</p>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {[
            ['Vibration input', `${data.vibr_x.toFixed(3)} G`, data.vibr_x > 0.5 ? 'Elevated' : 'Stable'],
            ['Thermal input', `${data.m_temp.toFixed(1)} deg C`, data.m_temp > 40 ? 'Caution' : 'Stable'],
            ['Mesh deviation', data.cluster_distance.toFixed(2), data.anomaly ? 'Outside envelope' : 'Healthy envelope'],
          ].map(([label, value, status]) => (
            <div className="rounded-md border border-slate-100 bg-slate-50 p-4" key={label}>
              <p className="text-xs font-semibold uppercase text-slate-400">{label}</p>
              <p className="mt-2 font-mono text-xl font-semibold text-slate-950">{value}</p>
              <p className="mt-1 text-sm text-slate-500">{status}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AlertsView({ data }) {
  const alertRows = getAlertRows(data);
  const writtenAlerts = getWrittenAlerts(data);

  return (
    <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <SecurityPanel security={data.security} />
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-slate-950">Alert Registry</h2>
            <p className="mt-1 text-sm text-slate-500">Telemetry and security alerts are collected here for operator review.</p>
          </div>
          <span className="rounded-md bg-slate-100 px-3 py-2 font-mono text-xs text-slate-500">REAL TIME</span>
        </div>
        <div className="mt-4 space-y-3">
          {writtenAlerts.length === 0 ? (
            <div className="rounded-md border border-emerald-100 bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-800">No active alerts</p>
              <p className="mt-1 text-sm text-emerald-700">No live telemetry or recent security activity currently needs operator review.</p>
            </div>
          ) : writtenAlerts.map((alert) => (
            <div
              className={`rounded-md border p-4 ${alert.tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-red-200 bg-red-50 text-red-800'}`}
              key={alert.key}
            >
              <p className="text-sm font-semibold">{alert.title}</p>
              <p className="mt-1 text-sm leading-6">{alert.message}</p>
            </div>
          ))}
        </div>
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
              {alertRows.map(([signal, value, rowStatus]) => (
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
