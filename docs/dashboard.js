// HSE Scraper dashboard — vanilla JS, no build step.
//
// Auth model: paste-in GitHub Personal Access Token, stored in localStorage.
// Per-user data: pull `docs/data.json` and Actions runs from the user's fork
// of CaspianTools/caspian-scraper. Falls back to a demo of the upstream
// repo's data when not signed in.

(() => {
  'use strict';

  // ---------- config ----------
  const UPSTREAM = { owner: 'CaspianTools', repo: 'caspian-scraper' };
  const PAT_KEY  = 'hse_dashboard_pat';
  const FORK_KEY = 'hse_dashboard_fork_owner';
  const RUNS_TO_SHOW = 10;
  const ERRORS_TO_SHOW = 20;
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  const SOPS = [
    {
      title: 'Onboard a new employer and its website',
      href: 'https://github.com/CaspianTools/caspian-scraper/blob/main/docs/sops/onboard-employer.md',
    },
  ];

  // ---------- DOM helpers ----------
  const root      = document.getElementById('root');
  const userBar   = document.getElementById('user-bar');
  const footerEl  = document.getElementById('footer-meta');

  const $  = (sel, el = document) => el.querySelector(sel);
  const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const k of kids) {
      if (k == null) continue;
      node.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
    return node;
  };
  const empty = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

  // ---------- formatters ----------
  const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
  const fmtPct = (n, d) => (!d ? '0%' : `${Math.round((n / d) * 100)}%`);

  function fmtRelative(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const delta = Math.round((Date.now() - t) / 1000);
    const abs = Math.abs(delta);
    const tense = delta >= 0 ? 'ago' : 'from now';
    if (abs < 60)        return `${abs}s ${tense}`;
    if (abs < 3600)      return `${Math.round(abs / 60)}m ${tense}`;
    if (abs < 86400)     return `${Math.round(abs / 3600)}h ${tense}`;
    if (abs < 86400 * 7) return `${Math.round(abs / 86400)}d ${tense}`;
    return new Date(t).toISOString().slice(0, 10);
  }
  function fmtAbsolute(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    return new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
  function fmtDuration(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    if (s < 60)   return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  // ---------- auth state ----------
  const getPat   = () => localStorage.getItem(PAT_KEY) || '';
  const setPat   = (v) => v ? localStorage.setItem(PAT_KEY, v) : localStorage.removeItem(PAT_KEY);
  const getFork  = () => localStorage.getItem(FORK_KEY) || '';
  const setFork  = (v) => v ? localStorage.setItem(FORK_KEY, v) : localStorage.removeItem(FORK_KEY);

  // ---------- GitHub API ----------
  async function gh(path, opts = {}) {
    const headers = { 'Accept': 'application/vnd.github+json', ...(opts.headers || {}) };
    const pat = getPat();
    if (pat) headers['Authorization'] = `Bearer ${pat}`;
    const res = await fetch(`https://api.github.com${path}`, { ...opts, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`GitHub API ${res.status} on ${path}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async function fetchUser() {
    return gh('/user');
  }

  async function findFork(login) {
    // Cheapest probe: try direct repo lookup at login/caspian-scraper.
    try {
      const repo = await gh(`/repos/${encodeURIComponent(login)}/${UPSTREAM.repo}`);
      return repo.full_name;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async function fetchDataJsonAuthed(owner) {
    const path = `/repos/${owner}/${UPSTREAM.repo}/contents/docs/data.json`;
    try {
      const blob = await gh(`${path}?ref=main`);
      if (blob && blob.encoding === 'base64' && blob.content) {
        const decoded = atob(blob.content.replace(/\n/g, ''));
        // base64 decode of utf-8 bytes — fix mojibake for non-ASCII content
        const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
        return JSON.parse(new TextDecoder('utf-8').decode(bytes));
      }
      if (blob && blob.download_url) {
        const r = await fetch(blob.download_url);
        return r.json();
      }
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    return null;
  }

  async function fetchDataJsonRaw(owner) {
    const url = `https://raw.githubusercontent.com/${owner}/${UPSTREAM.repo}/main/docs/data.json`;
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`raw ${owner}/data.json → ${r.status}`);
    return r.json();
  }

  async function fetchWorkflowRuns(owner) {
    try {
      const data = await gh(`/repos/${owner}/${UPSTREAM.repo}/actions/runs?per_page=${RUNS_TO_SHOW}`);
      return data.workflow_runs || [];
    } catch (e) {
      console.warn('workflow runs fetch failed:', e.message);
      return [];
    }
  }

  async function fetchEmployers(owner) {
    try {
      const url = `https://raw.githubusercontent.com/${owner}/${UPSTREAM.repo}/main/employers.json`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return [];
      return r.json();
    } catch {
      return [];
    }
  }

  async function dispatchWorkflow(owner, ref = 'main') {
    return gh(`/repos/${owner}/${UPSTREAM.repo}/actions/workflows/scrape.yml/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    });
  }

  async function rerunFailedJobs(owner, runId) {
    return gh(`/repos/${owner}/${UPSTREAM.repo}/actions/runs/${runId}/rerun-failed-jobs`, {
      method: 'POST',
    });
  }

  async function cancelWorkflowRun(owner, runId) {
    return gh(`/repos/${owner}/${UPSTREAM.repo}/actions/runs/${runId}/cancel`, {
      method: 'POST',
    });
  }

  // ---------- views ----------
  function renderLogin(message) {
    empty(root);
    empty(userBar);
    const card = el('section', { className: 'card login-card' });
    card.append(el('h2', {}, 'Sign in'));
    card.append(el('p', {}, 'This dashboard reads ', el('strong', {}, 'your fork'),
      ' of ', el('code', {}, `${UPSTREAM.owner}/${UPSTREAM.repo}`),
      ' and shows what your scraper has been doing.'));
    card.append(el('p', {}, 'Paste a GitHub Personal Access Token. The token is stored only in your browser; revoke any time from ',
      el('a', { href: 'https://github.com/settings/tokens', target: '_blank', rel: 'noopener' }, 'github.com/settings/tokens'),
      '.'));

    const input = el('input', { type: 'password', id: 'pat', placeholder: 'ghp_…', autocomplete: 'off' });
    card.append(input);

    const actions = el('div', { className: 'actions' });
    const submit = el('button', { className: 'primary' }, 'Sign in');
    submit.onclick = () => trySignIn(input.value.trim());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click(); });
    actions.append(submit);
    actions.append(el('span', { className: 'muted-text' }, 'or'));
    const demo = el('a', { href: '#', onclick: (e) => { e.preventDefault(); loadDemo(); } }, 'view demo (upstream data)');
    actions.append(demo);
    card.append(actions);

    if (message) card.append(el('p', { className: 'error-box' }, message));

    card.append(el('div', { className: 'help' },
      el('strong', {}, 'Token scopes: '),
      'For a public fork, ',
      el('a', { href: 'https://github.com/settings/tokens/new?scopes=public_repo&description=caspian-scraper-dashboard', target: '_blank', rel: 'noopener' },
        'create a classic token with public_repo'),
      '. For a private fork, use ', el('code', {}, 'repo'), ' instead.'
    ));

    root.append(card);
  }

  async function trySignIn(token) {
    if (!token) return renderLogin('Paste a token first.');
    setPat(token);
    try {
      const user = await fetchUser();
      const fork = await findFork(user.login);
      if (!fork) {
        return renderLogin(
          `Signed in as @${user.login}, but no fork of ${UPSTREAM.owner}/${UPSTREAM.repo} found on your account. ` +
          `Fork it first at https://github.com/${UPSTREAM.owner}/${UPSTREAM.repo}.`
        );
      }
      setFork(user.login);
      await loadDashboard({ user, fork });
    } catch (e) {
      setPat('');
      renderLogin(`Sign-in failed: ${e.message}`);
    }
  }

  async function loadDemo() {
    empty(root);
    empty(userBar);
    userBar.append(
      el('span', { className: 'fork-tag' }, `demo · ${UPSTREAM.owner}/${UPSTREAM.repo}`),
      el('button', { onclick: () => renderLogin('') }, 'Sign in')
    );
    let data = null;
    try {
      const r = await fetch('./data.json', { cache: 'no-store' });
      if (r.ok) data = await r.json();
    } catch {}
    if (!data) data = await fetchDataJsonRaw(UPSTREAM.owner);
    let runs = [];
    if (getPat()) runs = await fetchWorkflowRuns(`${UPSTREAM.owner}/${UPSTREAM.repo}`);
    renderDashboard({ data, runs, fork: `${UPSTREAM.owner}/${UPSTREAM.repo}`, isDemo: true });
  }

  async function loadDashboard({ user, fork }) {
    empty(root);
    root.append(el('div', { className: 'loading' }, 'Loading dashboard…'));

    let data = null;
    try { data = await fetchDataJsonAuthed(fork); }
    catch (e) {
      if (e.status === 401 || e.status === 403) {
        setPat('');
        return renderLogin(`Token rejected: ${e.message}`);
      }
      console.warn('data.json fetch failed:', e.message);
    }
    const runs = await fetchWorkflowRuns(fork);
    const employers = (!data || !data.employers || !data.employers.length)
      ? await fetchEmployers(fork.split('/')[0])
      : data.employers;

    renderUserBar({ user, fork });
    renderDashboard({ data, runs, fork, employers });
  }

  function renderUserBar({ user, fork }) {
    empty(userBar);
    userBar.append(
      el('img', { src: user.avatar_url, alt: user.login }),
      el('span', { className: 'handle' }, '@' + user.login),
      el('span', { className: 'fork-tag' }, fork),
      el('button', { onclick: refreshDashboard }, 'Refresh'),
      el('button', { onclick: signOut }, 'Sign out')
    );
  }

  function signOut() {
    setPat('');
    setFork('');
    renderLogin('');
  }

  // ---------- main render ----------
  function renderDashboard({ data, runs, fork, employers, isDemo = false }) {
    empty(root);

    if (!data && !runs.length) {
      const box = el('div', { className: 'error-box' });
      box.append(
        el('p', {}, isDemo
          ? 'No demo data yet — the upstream scraper hasn\'t produced docs/data.json.'
          : 'No dashboard data yet for this fork.'
        ),
        el('p', {}, 'Trigger a workflow run on the Actions tab and refresh.')
      );
      root.append(box);
      footerEl.textContent = isDemo ? 'demo · no data' : 'no data';
      return;
    }

    if (!data) {
      data = { runs: [], recent_published: [], totals: {}, employers: employers || [] };
    }
    if (employers && (!data.employers || !data.employers.length)) {
      data.employers = employers.map((e) => ({
        name: e.name || '(unnamed)',
        ats: e.ats || '',
        active: e.active !== false,
      }));
    }

    const runsHistory = data.runs || [];
    const lastRun = runsHistory[runsHistory.length - 1];

    root.append(buildControls(runs, fork, isDemo));
    root.append(buildHero(data, lastRun));
    if ((data.employers || []).length) root.append(buildEmployers(data, lastRun));
    if (runsHistory.length)             root.append(buildTrendChart(runsHistory));
    if ((data.recent_published || []).length) root.append(buildRecentPublished(data.recent_published));
    if (runs.length)                    root.append(buildWorkflowRuns(runs, fork));
    root.append(buildErrorsTimeline(runsHistory));
    if (SOPS.length)                    root.append(buildSOPs(SOPS));

    const lu = data.last_updated || (lastRun && lastRun.finished_at);
    footerEl.textContent = lu
      ? `data: ${fmtAbsolute(lu)} (${fmtRelative(lu)})`
      : 'no run yet';
  }

  function buildControls(runs, fork, isDemo) {
    const sec = el('section', {});
    sec.append(el('h2', {}, 'Controls'));
    const card = el('div', { className: 'card' });
    const row = el('div', { className: 'row wrap' });

    const latest = runs[0];
    const latestActive = latest && (latest.status === 'queued' || latest.status === 'in_progress');
    const latestFailed = latest && latest.status === 'completed' && latest.conclusion && latest.conclusion !== 'success';

    const status = el('div', { className: 'control-status muted-text' }, isDemo ? 'Sign in to use controls.' : '');

    const setStatus = (msg, cls = '') => {
      status.className = 'control-status muted-text' + (cls ? ' ' + cls : '');
      status.textContent = msg;
    };

    const wrap = (btn, action, busyLabel) => {
      const original = btn.textContent;
      btn.onclick = async () => {
        if (btn.disabled) return;
        const siblings = row.querySelectorAll('button');
        siblings.forEach((b) => { b.disabled = true; });
        btn.textContent = busyLabel;
        try {
          await action();
        } catch (e) {
          setStatus(e.message || String(e), 'err-text');
        } finally {
          btn.textContent = original;
          siblings.forEach((b) => { b.disabled = false; });
          applyDisabledRules();
        }
      };
    };

    const runBtn = el('button', { className: 'primary' }, 'Run scrape now');
    const refreshBtn = el('button', {}, 'Refresh');
    const rerunBtn = el('button', {}, 'Re-run last failed');
    const cancelBtn = el('button', {}, 'Cancel current run');
    const openBtn = el('a', {
      className: 'btn-link',
      href: `https://github.com/${fork || (UPSTREAM.owner + '/' + UPSTREAM.repo)}/actions`,
      target: '_blank', rel: 'noopener',
    }, 'Open in GitHub ↗');

    function applyDisabledRules() {
      runBtn.disabled    = isDemo;
      refreshBtn.disabled = false;
      rerunBtn.disabled  = isDemo || !latestFailed;
      cancelBtn.disabled = isDemo || !latestActive;
    }
    applyDisabledRules();

    wrap(runBtn, async () => {
      await dispatchWorkflow(fork || `${UPSTREAM.owner}/${UPSTREAM.repo}`);
      setStatus('Workflow dispatched. New run will appear in a few seconds…', 'ok-text');
      setTimeout(() => { refreshDashboard().catch(() => {}); }, 3500);
    }, 'Dispatching…');

    wrap(refreshBtn, async () => {
      await refreshDashboard();
      setStatus('Refreshed.', 'ok-text');
    }, 'Refreshing…');

    wrap(rerunBtn, async () => {
      if (!latest) return;
      await rerunFailedJobs(fork || `${UPSTREAM.owner}/${UPSTREAM.repo}`, latest.id);
      setStatus(`Re-running failed jobs for run #${latest.run_number || latest.id}…`, 'ok-text');
      setTimeout(() => { refreshDashboard().catch(() => {}); }, 3500);
    }, 'Re-running…');

    wrap(cancelBtn, async () => {
      if (!latest) return;
      await cancelWorkflowRun(fork || `${UPSTREAM.owner}/${UPSTREAM.repo}`, latest.id);
      setStatus(`Cancellation requested for run #${latest.run_number || latest.id}.`, 'ok-text');
      setTimeout(() => { refreshDashboard().catch(() => {}); }, 2500);
    }, 'Cancelling…');

    row.append(runBtn, refreshBtn, rerunBtn, cancelBtn, openBtn);
    card.append(row, status);
    sec.append(card);
    return sec;
  }

  function statusBadge(run) {
    if (!run) return el('span', { className: 'badge muted' }, 'no run');
    const status = run.status || ((run.errors && run.errors.length) ? 'error' : 'ok');
    const cls = status === 'ok' ? 'ok' : (status === 'auth_halt' ? 'err' : 'warn');
    return el('span', { className: 'badge ' + cls }, status.replace('_', ' '));
  }

  function buildHero(data, lastRun) {
    const totals = data.totals || {};
    const sec = el('section', {});
    sec.append(el('h2', {}, 'Overview'));
    const grid = el('div', { className: 'stats-grid' });

    const lastRunCard = el('div', { className: 'card stat' });
    lastRunCard.append(el('div', { className: 'label' }, 'Last run'));
    if (lastRun) {
      lastRunCard.append(
        el('div', { className: 'value' }, statusBadge(lastRun)),
        el('div', { className: 'sub' },
          fmtAbsolute(lastRun.finished_at || lastRun.started_at),
          ' · ', fmtRelative(lastRun.finished_at || lastRun.started_at),
          ' · ', fmtDuration(lastRun.duration_seconds)
        )
      );
    } else {
      lastRunCard.append(el('div', { className: 'value' }, '—'),
        el('div', { className: 'sub' }, 'no runs recorded'));
    }
    grid.append(lastRunCard);

    grid.append(buildStat('Found',    lastRun ? lastRun.found     : 0, 'in last run'));
    grid.append(buildStat('Published',lastRun ? lastRun.published : 0,
      lastRun ? `${fmtPct(lastRun.published, lastRun.found)} of found` : ''));
    grid.append(buildStat('Duplicates', lastRun ? lastRun.skipped_duplicate : 0, 'already on API'));
    grid.append(buildStat('Errors', lastRun ? (lastRun.errors || []).length : 0,
      lastRun && lastRun.errors && lastRun.errors.length ? 'see below' : 'last run'));

    grid.append(buildStat('Runs (all-time)',     totals.runs              || 0, ''));
    grid.append(buildStat('Published (all-time)', totals.published_alltime || 0, ''));
    grid.append(buildStat('Errors (all-time)',   totals.errors_alltime    || 0, ''));

    sec.append(grid);
    return sec;
  }

  function buildStat(label, value, sub) {
    const card = el('div', { className: 'card stat' });
    card.append(
      el('div', { className: 'label' }, label),
      el('div', { className: 'value' }, fmtNum(value)),
    );
    if (sub) card.append(el('div', { className: 'sub' }, sub));
    return card;
  }

  function buildEmployers(data, lastRun) {
    const sec = el('section', {});
    sec.append(el('h2', {}, 'Employers'));
    const card = el('div', { className: 'card' });
    const table = el('table');
    const thead = el('thead');
    thead.append(el('tr', {},
      el('th', {}, 'Name'),
      el('th', {}, 'ATS'),
      el('th', {}, 'Status'),
      el('th', { className: 'num' }, 'Found'),
      el('th', { className: 'num' }, 'Published'),
      el('th', { className: 'num' }, 'Duplicates'),
      el('th', { className: 'num' }, 'Errors')
    ));
    table.append(thead);

    const keyOf = (e) => `${e.name || ''}|${e.url || ''}`;
    const lastByKey = new Map(
      ((lastRun && lastRun.by_employer) || []).map((e) => [keyOf(e), e])
    );
    // Append a URL-tail disambiguator only where the same display name
    // appears more than once.
    const nameCounts = new Map();
    for (const emp of data.employers) {
      nameCounts.set(emp.name, (nameCounts.get(emp.name) || 0) + 1);
    }
    const urlTail = (u) => {
      if (!u) return '';
      try {
        const p = new URL(u).pathname.replace(/\/+$/, '');
        return decodeURIComponent(p.split('/').pop() || '').replace(/\+/g, ' ');
      } catch {
        return u;
      }
    };

    const tbody = el('tbody');
    for (const emp of data.employers) {
      const stats = lastByKey.get(keyOf(emp)) || {};
      const tr = el('tr');
      const nameCell = el('td');
      nameCell.append(emp.name || '(unnamed)');
      if ((nameCounts.get(emp.name) || 0) > 1 && emp.url) {
        nameCell.append(el('div', { className: 'meta' }, urlTail(emp.url)));
      }
      tr.append(
        nameCell,
        el('td', { className: 'muted' }, emp.ats || '—'),
        el('td', {}, emp.active
          ? el('span', { className: 'badge ok' }, 'active')
          : el('span', { className: 'badge muted' }, 'inactive')),
        el('td', { className: 'num' }, fmtNum(stats.found)),
        el('td', { className: 'num' }, fmtNum(stats.published)),
        el('td', { className: 'num' }, fmtNum(stats.skipped_duplicate)),
        el('td', { className: 'num' }, fmtNum((stats.errors || []).length))
      );
      tbody.append(tr);
    }
    table.append(tbody);
    card.append(table);
    sec.append(card);
    return sec;
  }

  let chartInstance = null;
  function buildTrendChart(runsHistory) {
    const sec = el('section', {});
    sec.append(el('h2', {}, 'Trend (last ' + runsHistory.length + ' runs)'));
    const card = el('div', { className: 'card' });
    const wrap = el('div', { className: 'chart-wrap' });
    const canvas = el('canvas');
    wrap.append(canvas);
    card.append(wrap);
    sec.append(card);

    queueMicrotask(() => {
      if (chartInstance) chartInstance.destroy();
      const labels = runsHistory.map((r) => (r.finished_at || r.started_at || '').slice(5, 16).replace('T', ' '));
      const found     = runsHistory.map((r) => r.found || 0);
      const published = runsHistory.map((r) => r.published || 0);
      const errors    = runsHistory.map((r) => (r.errors || []).length);

      chartInstance = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Found',     data: found,     borderColor: '#94a3b8', backgroundColor: 'rgba(148,163,184,0.10)', tension: 0.3, fill: true },
            { label: 'Published', data: published, borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.12)',   tension: 0.3, fill: true },
            { label: 'Errors',    data: errors,    borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,0.10)',   tension: 0.3, fill: true },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            y: { beginAtZero: true, ticks: { precision: 0 } },
            x: { ticks: { autoSkip: true, maxTicksLimit: 8 } },
          },
          plugins: { legend: { position: 'bottom' } },
        },
      });
    });
    return sec;
  }

  function buildRecentPublished(recent) {
    const sec = el('section', {});
    sec.append(el('h2', {}, 'Recently published roles'));
    const card = el('div', { className: 'card' });
    const ul = el('ul', { className: 'role-list' });
    const list = recent.slice().reverse();
    for (const r of list) {
      const li = el('li');
      const left = el('div');
      left.append(el('div', { className: 'title' }, r.title || '(untitled)'));
      const metaParts = [];
      if (r.employer) metaParts.push(r.employer);
      if (r.location) metaParts.push(r.location);
      if (r.country)  metaParts.push(r.country.toUpperCase());
      if (r.employment_type) metaParts.push(r.employment_type);
      if (r.ts) metaParts.push(fmtRelative(r.ts));
      left.append(el('div', { className: 'meta' }, metaParts.join(' · ')));
      li.append(left);
      const links = el('div', { className: 'links' });
      if (r.slug) links.append(el('a', {
        href: `https://entirelysafe.com/vacancies/${encodeURIComponent(r.slug)}`,
        target: '_blank', rel: 'noopener',
      }, 'on entirelysafe'));
      if (r.url)  links.append(el('a', { href: r.url, target: '_blank', rel: 'noopener' }, 'source'));
      li.append(links);
      ul.append(li);
    }
    card.append(ul);
    sec.append(card);
    return sec;
  }

  function buildWorkflowRuns(runs, fork) {
    const sec = el('section', {});
    sec.append(el('h2', {}, 'Workflow runs'));
    const card = el('div', { className: 'card' });
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Run'),
      el('th', {}, 'Status'),
      el('th', {}, 'Trigger'),
      el('th', {}, 'Started'),
      el('th', {}, 'Duration'),
      el('th', {}, '')
    )));
    const tbody = el('tbody');
    for (const r of runs) {
      const tr = el('tr');
      const status = r.conclusion || r.status || 'unknown';
      const cls = status === 'success' ? 'ok'
                : status === 'in_progress' || status === 'queued' ? 'muted'
                : 'err';
      const dur = r.run_started_at && r.updated_at
        ? Math.max(0, Math.round((Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 1000))
        : 0;
      tr.append(
        el('td', {}, '#' + r.run_number),
        el('td', {}, el('span', { className: 'badge ' + cls }, status.replace('_', ' '))),
        el('td', { className: 'muted' }, r.event || '—'),
        el('td', {}, fmtRelative(r.run_started_at || r.created_at)),
        el('td', { className: 'muted' }, fmtDuration(dur)),
        el('td', {}, el('a', { href: r.html_url, target: '_blank', rel: 'noopener' }, 'logs')),
      );
      tbody.append(tr);
    }
    table.append(tbody);
    card.append(table);
    sec.append(card);
    return sec;
  }

  function buildErrorsTimeline(runsHistory) {
    const sec = el('section', {});
    sec.append(el('h2', {}, 'Recent errors'));
    const card = el('div', { className: 'card' });
    const all = [];
    for (const r of runsHistory.slice().reverse()) {
      const ts = r.finished_at || r.started_at;
      for (const m of (r.errors || [])) {
        all.push({ ts, msg: m });
        if (all.length >= ERRORS_TO_SHOW) break;
      }
      if (all.length >= ERRORS_TO_SHOW) break;
    }
    if (!all.length) {
      card.append(el('div', { className: 'empty' }, 'No errors in recent runs.'));
    } else {
      const ul = el('ul', { className: 'errors-list' });
      for (const e of all) {
        const li = el('li');
        li.append(
          el('span', { className: 'ts' }, fmtAbsolute(e.ts)),
          document.createTextNode(' '),
          document.createTextNode(e.msg),
        );
        ul.append(li);
      }
      card.append(ul);
    }
    sec.append(card);
    return sec;
  }

  function buildSOPs(sops) {
    const sec = el('section', {});
    sec.append(el('h2', {}, 'SOPs'));
    const card = el('div', { className: 'card' });
    const ul = el('ul', { className: 'role-list' });
    for (const s of sops) {
      const li = el('li');
      const left = el('div');
      const titleNode = s.href
        ? el('a', { href: s.href, target: '_blank', rel: 'noopener' }, s.title)
        : document.createTextNode(s.title);
      left.append(el('div', { className: 'title' }, titleNode));
      li.append(left);
      ul.append(li);
    }
    card.append(ul);
    sec.append(card);
    return sec;
  }

  // ---------- refresh ----------
  let lastBootArgs = null;
  async function refreshDashboard() {
    if (lastBootArgs && lastBootArgs.mode === 'auth') {
      await loadDashboard(lastBootArgs.payload);
    } else if (lastBootArgs && lastBootArgs.mode === 'demo') {
      await loadDemo();
    }
  }

  // ---------- boot ----------
  async function boot() {
    if (!getPat()) {
      const params = new URLSearchParams(location.search);
      if (params.get('demo') === '1') {
        lastBootArgs = { mode: 'demo' };
        return loadDemo();
      }
      return renderLogin('');
    }
    try {
      const user = await fetchUser();
      const fork = (user.login + '/' + UPSTREAM.repo);
      // Verify fork still exists (handles renames / deletes silently).
      const exists = await findFork(user.login);
      const target = exists || fork;
      lastBootArgs = { mode: 'auth', payload: { user, fork: target } };
      await loadDashboard(lastBootArgs.payload);
    } catch (e) {
      if (e.status === 401) {
        setPat('');
        return renderLogin('Stored token rejected. Sign in again.');
      }
      renderLogin(`Failed to load: ${e.message}`);
    }
  }

  setInterval(() => {
    if (document.visibilityState === 'visible') refreshDashboard();
  }, REFRESH_INTERVAL_MS);

  boot();
})();
