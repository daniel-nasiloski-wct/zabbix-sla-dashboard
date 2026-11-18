/*
 * SLA dashboard (Services → SLA dashboard). Navega pela árvore de serviços do Zabbix:
 *  - visão geral: um card por serviço de topo (o serviço com SLA que não tem ancestral com SLA, ex. cada
 *    cliente de um provedor whitelabel), agrupados pelo pai sem SLA e ordenados do pior para o melhor;
 *  - clicar abre o serviço: SLI × SLO no período, um gráfico, e os componentes (filhos com SLA), que
 *    também podem ser abertos. O caminho fica na URL (#/id/id), então o voltar do navegador funciona.
 * SVG e DOM puros. Cores pelo tema do Zabbix (sla-dashboard.css). Textos pelo dicionário traduzido no
 * PHP: o CI18n lê os textos de t() direto deste arquivo, então todo texto visível passa por t() com
 * aspas simples.
 */

const boot = window.SLA_DASHBOARD || {};
const DICT = boot.i18n || {};
const LANG = boot.lang && boot.lang !== 'default' ? boot.lang : undefined;

function t(text, ...args) {
	let out = DICT[text] || text;
	args.forEach((a, i) => { out = out.split(`%${i + 1}$s`).join(String(a)); });
	return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const SVG = 'http://www.w3.org/2000/svg';
const PERIOD = {HOUR: 0, DAY: 1, WEEK: 2, MONTH: 3, YEAR: 4};

// ---------------------------------------------------------------- formatação

const numFmt = {};
function num(v, digits = 2) {
	numFmt[digits] ||= new Intl.NumberFormat(LANG, {minimumFractionDigits: digits, maximumFractionDigits: digits});
	return numFmt[digits].format(v);
}

function pct(v) {
	if (v === null || v === undefined) return '—';
	// Mais casas perto de 100%, senão 99,95% vira 100,00%.
	const d = v >= 99.99 && v < 100 ? 4 : v >= 99 && v < 100 ? 3 : 2;
	return `${num(v, d)}%`;
}

function duration(sec) {
	if (sec === null || sec === undefined) return '—';
	const neg = sec < 0;
	let s = Math.abs(Math.round(sec));
	if (s === 0) return '0';
	const parts = [];
	const d = Math.floor(s / 86400); s %= 86400;
	const h = Math.floor(s / 3600); s %= 3600;
	const m = Math.floor(s / 60); s %= 60;
	if (d) parts.push(t('%1$sd', d));
	if (h) parts.push(t('%1$sh', h));
	if (m && !d) parts.push(t('%1$sm', m));
	if (s && !d && !h) parts.push(t('%1$ss', s));
	return (neg ? '−' : '') + parts.slice(0, 2).join(' ');
}

function dateFmt(opts, tz) {
	try {
		return new Intl.DateTimeFormat(LANG, {...opts, timeZone: tz});
	}
	catch (e) {
		return new Intl.DateTimeFormat(LANG, opts);
	}
}

function bucketLabel(data, b, long = false) {
	const tz = data.timezone;
	const d = new Date(b.from * 1000);
	switch (data.period) {
		case PERIOD.HOUR:
			return dateFmt(long ? {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}
				: {hour: '2-digit', minute: '2-digit'}, tz).format(d);
		case PERIOD.DAY:
			return dateFmt(long ? {weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'}
				: {day: 'numeric', month: 'short'}, tz).format(d);
		case PERIOD.WEEK: {
			const f = dateFmt({day: 'numeric', month: 'short'}, tz);
			return long ? `${f.format(d)} – ${f.format(new Date((b.to - 1) * 1000))}` : f.format(d);
		}
		case PERIOD.MONTH:
			return dateFmt({month: long ? 'long' : 'short', year: 'numeric'}, tz).format(d);
		default:
			return dateFmt({year: 'numeric'}, tz).format(d);
	}
}

function rangeLabel(data) {
	if (!data.buckets.length) return '';
	const f = dateFmt({day: 'numeric', month: 'short', year: 'numeric'}, data.timezone);
	return `${f.format(new Date(data.buckets[0].from * 1000))} – ${f.format(new Date((Math.min(data.to, data.buckets.at(-1).to) - 1) * 1000))}`;
}

// ---------------------------------------------------------------- estado

/** ok = sem parada, met = parou mas cumpriu o SLO, breach = abaixo do SLO, none = sem dados. */
function stateOf(sli, slo, down) {
	if (sli === null || sli === undefined) return 'none';
	if (sli < slo) return 'breach';
	return down > 0 ? 'met' : 'ok';
}

const RANK = {breach: 0, met: 1, ok: 2, none: 3};

const STATE_LABEL = () => ({
	ok: t('No downtime'),
	met: t('Downtime within SLO'),
	breach: t('Below SLO'),
	none: t('No data')
});

// ---------------------------------------------------------------- modelo (árvore + linhas)

function model(data) {
	const slas = Object.fromEntries(data.slas.map((s) => [s.slaid, s]));
	const rowsBy = new Map();
	for (const r of data.rows) {
		const sla = slas[r.slaid];
		const row = {...r, slo: sla.slo, slaName: sla.name, state: stateOf(r.sli, sla.slo, r.down)};
		if (!rowsBy.has(r.serviceid)) rowsBy.set(r.serviceid, []);
		rowsBy.get(r.serviceid).push(row);
	}
	const nodes = data.nodes || {};
	const name = (id) => (nodes[id] ? nodes[id][0] : data.services[id]?.name ?? id);
	const problem = (id) => (nodes[id] ? nodes[id][1] >= 0 : false);
	const parents = (id) => (nodes[id] ? nodes[id][2] : []).filter((p) => nodes[p]);
	const children = (id) => (nodes[id] ? nodes[id][3] : []).filter((c) => nodes[c]);
	const measured = (id) => rowsBy.has(id);
	const margin = (r) => (r.sli ?? 101) - r.slo;

	// Linha principal de um serviço: a da SLA pedida, senão a de pior margem até o SLO.
	const primary = (id, slaid = null) => {
		const rows = rowsBy.get(id) || [];
		if (slaid) {
			const same = rows.find((r) => r.slaid === slaid);
			if (same) return same;
		}
		return [...rows].sort((a, b) => (RANK[a.state] - RANK[b.state]) || margin(a) - margin(b))[0] || null;
	};

	const hasMeasuredAncestor = (id) => {
		const seen = new Set();
		const stack = [...parents(id)];
		while (stack.length) {
			const p = stack.pop();
			if (seen.has(p)) continue;
			seen.add(p);
			if (measured(p)) return true;
			stack.push(...parents(p));
		}
		return false;
	};

	// Filhos com SLA mais próximos (desce pelos nós sem SLA).
	const components = (id) => {
		const out = [];
		const seen = new Set([id]);
		const queue = [...children(id)];
		while (queue.length) {
			const c = queue.shift();
			if (seen.has(c)) continue;
			seen.add(c);
			if (measured(c)) out.push(c);
			else queue.push(...children(c));
		}
		return out;
	};

	const top = [...rowsBy.keys()].filter((id) => !hasMeasuredAncestor(id));

	// Grupo do card na visão geral: o pai sem SLA (ex. "Whitelabel Hosting").
	const groupOf = (id) => {
		const p = parents(id).find((x) => !measured(x));
		return p ? name(p) : '';
	};

	const byWorst = (slaid = null) => (a, b) => {
		const ra = primary(a, slaid), rb = primary(b, slaid);
		return (RANK[ra.state] - RANK[rb.state]) || (margin(ra) - margin(rb)) || name(a).localeCompare(name(b), LANG);
	};

	return {rowsBy, name, problem, measured, primary, components, top, groupOf, byWorst};
}

// ---------------------------------------------------------------- DOM helpers

function el(tag, attrs = {}, html = '') {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
	}
	if (html) node.innerHTML = html;
	return node;
}

function svg(tag, attrs = {}) {
	const node = document.createElementNS(SVG, tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v !== undefined && v !== null) node.setAttribute(k, v);
	}
	return node;
}

// ---------------------------------------------------------------- tooltip

const tip = el('div', {class: 'sla-dashboard sd-tip', role: 'tooltip'});
document.body.appendChild(tip);

function showTip(html, ev) {
	tip.innerHTML = html;
	tip.classList.add('is-visible');
	const pad = 14;
	const r = tip.getBoundingClientRect();
	let x = ev.clientX + pad;
	let y = ev.clientY + pad;
	if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
	if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
	tip.style.left = `${Math.max(8, x)}px`;
	tip.style.top = `${Math.max(8, y)}px`;
}

function hideTip() {
	tip.classList.remove('is-visible');
}

function tipRow(label, value) {
	return `<div class="sd-tip-row"><span class="sd-tip-label">${esc(label)}</span><span class="sd-tip-value">${esc(value)}</span></div>`;
}

function tipState(state) {
	return `<div class="sd-tip-state is-${state}">${esc(STATE_LABEL()[state])}</div>`;
}

// ---------------------------------------------------------------- faixa de status (estilo status page)

/**
 * Uma barrinha por período, na cor do estado. Com períodos demais para o espaço, junta vizinhos e
 * fica com o pior estado do grupo.
 */
function strip(data, row, maxSlots, interactive) {
	const n = row.cells.length;
	const per = Math.max(1, Math.ceil(n / maxSlots));
	const wrap = el('div', {class: 'sd-strip', 'aria-hidden': interactive ? null : 'true'});
	for (let i = 0; i < n; i += per) {
		const end = Math.min(n, i + per);
		let state = 'none', down = 0, inc = 0;
		for (let j = i; j < end; j++) {
			const c = row.cells[j];
			if (!c) continue;
			const s = stateOf(c[0], row.slo, c[1]);
			if (state === 'none' || RANK[s] < RANK[state]) state = s;
			down += c[1];
			inc += c[2];
		}
		const bar = el('span', {class: `sd-strip-bar is-${state}`});
		if (interactive) {
			bar.addEventListener('mousemove', (ev) => {
				const label = end - i === 1 ? bucketLabel(data, data.buckets[i], true)
					: `${bucketLabel(data, data.buckets[i], true)} – ${bucketLabel(data, data.buckets[end - 1], true)}`;
				let html = `<div class="sd-tip-title">${esc(label)}</div>`;
				if (end - i === 1 && row.cells[i]) html += tipRow(t('SLI'), pct(row.cells[i][0]));
				html += tipRow(t('Downtime'), state === 'none' ? '—' : duration(down));
				if (inc) html += tipRow(t('Incidents'), String(inc));
				showTip(html + tipState(state), ev);
			});
			bar.addEventListener('mouseleave', hideTip);
		}
		wrap.appendChild(bar);
	}
	return wrap;
}

// ---------------------------------------------------------------- visão geral

function overview(root, data, m, open) {
	const ids = m.top;
	const below = ids.filter((id) => m.primary(id).state === 'breach').length;
	const problems = ids.filter((id) => m.problem(id)).length;

	const head = el('div', {class: 'sd-head'});
	head.innerHTML = `
		<div class="sd-summary">
			<span>${esc(t('%1$s services', ids.length))}</span>
			${below ? `<span class="sd-summary-bad">${esc(t('%1$s below SLO', below))}</span>` : `<span class="sd-summary-ok">${esc(t('All within SLO'))}</span>`}
			${problems ? `<span class="sd-summary-bad">${esc(t('%1$s with a problem now', problems))}</span>` : ''}
			<span class="sd-muted">${esc(rangeLabel(data))}</span>
		</div>`;
	root.appendChild(head);

	const groups = new Map();
	for (const id of ids) {
		const g = m.groupOf(id);
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g).push(id);
	}
	const names = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, LANG));
	const showHeadings = names.length > 1 || names[0] !== '';

	for (const g of names) {
		if (showHeadings) {
			root.appendChild(el('div', {class: 'sd-group'}, esc(g || t('Other services'))));
		}
		const grid = el('div', {class: 'sd-cards'});
		groups.get(g).sort(m.byWorst()).forEach((id, i) => {
			const row = m.primary(id);
			const card = el('button', {type: 'button', class: `sd-card is-${row.state}`,
				style: `animation-delay:${(Math.min(i, 20) * 0.02).toFixed(2)}s`});
			card.innerHTML = `
				<span class="sd-card-name">${m.problem(id) ? `<span class="sd-live" title="${esc(t('Problem'))}"></span>` : ''}${esc(m.name(id))}</span>
				<span class="sd-card-sli">${esc(pct(row.sli))}</span>
				<span class="sd-card-slo">${esc(t('SLO'))} ${esc(pct(row.slo))}</span>`;
			card.appendChild(strip(data, row, 40, false));
			card.addEventListener('click', () => open([id]));
			grid.appendChild(card);
		});
		root.appendChild(grid);
	}
}

// ---------------------------------------------------------------- serviço

function trend(data, row) {
	const holder = el('div', {class: 'sd-chart'});
	const draw = () => {
		holder.innerHTML = '';
		const W = Math.max(280, holder.clientWidth);
		const H = 200;
		const mg = {l: 58, r: 12, t: 14, b: 26};
		const n = data.buckets.length;
		const vals = row.cells.map((c) => (c ? c[0] : null));
		let lo = row.slo;
		vals.forEach((v) => { if (v !== null) lo = Math.min(lo, v); });
		const gap = Math.max(100 - lo, 0.01);
		const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25];
		const y0 = Math.max(0, 100 - (steps.find((s) => s * 4 >= gap * 1.15) || 25) * 4);
		const x = (i) => mg.l + (n <= 1 ? (W - mg.l - mg.r) / 2 : i * (W - mg.l - mg.r) / (n - 1));
		const y = (v) => mg.t + (100 - v) / (100 - y0) * (H - mg.t - mg.b);
		const root = svg('svg', {width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'sd-svg', role: 'img', 'aria-label': t('SLI')});

		for (let k = 0; k <= 4; k++) {
			const v = y0 + (100 - y0) * k / 4;
			root.appendChild(svg('line', {x1: mg.l, x2: W - mg.r, y1: y(v), y2: y(v), class: 'sd-gridline'}));
			const lbl = svg('text', {x: mg.l - 8, y: y(v) + 4, class: 'sd-axis', 'text-anchor': 'end'});
			lbl.textContent = `${num(v, 100 - y0 < 1 ? 2 : 100 - y0 < 10 ? 1 : 0)}%`;
			root.appendChild(lbl);
		}
		const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - mg.l - mg.r) / 90))));
		for (let i = 0; i < n; i += every) {
			const lbl = svg('text', {x: x(i), y: H - 6, class: 'sd-axis', 'text-anchor': 'middle'});
			lbl.textContent = bucketLabel(data, data.buckets[i]);
			root.appendChild(lbl);
		}

		// área sob a linha, SLO tracejado, linha do SLI e pontos abaixo do SLO
		const pts = vals.map((v, i) => (v === null ? null : [x(i), y(v)]));
		let d = '';
		let pen = false;
		pts.forEach((p) => {
			if (!p) { pen = false; return; }
			d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
			pen = true;
		});
		const present = pts.filter(Boolean);
		if (present.length) {
			const area = `M${present.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}`
				+ `L${present.at(-1)[0].toFixed(1)},${y(y0)}L${present[0][0].toFixed(1)},${y(y0)}Z`;
			root.appendChild(svg('path', {d: area, class: 'sd-area'}));
		}
		root.appendChild(svg('line', {x1: mg.l, x2: W - mg.r, y1: y(row.slo), y2: y(row.slo), class: 'sd-slo-line'}));
		// rótulo logo abaixo da linha, à esquerda (em cima ele bate na linha dos 100%)
		const sloLbl = svg('text', {x: mg.l + 6, y: y(row.slo) + 14, class: 'sd-slo-label'});
		sloLbl.textContent = `${t('SLO')} ${pct(row.slo)}`;
		root.appendChild(sloLbl);
		root.appendChild(svg('path', {d, class: 'sd-line'}));
		vals.forEach((v, i) => {
			if (v !== null && v < row.slo) root.appendChild(svg('circle', {cx: x(i), cy: y(v), r: 4, class: 'sd-dot-breach'}));
		});

		const cross = svg('line', {y1: mg.t, y2: H - mg.b, class: 'sd-cross', visibility: 'hidden'});
		root.appendChild(cross);
		const hit = svg('rect', {x: mg.l, y: mg.t, width: W - mg.l - mg.r, height: H - mg.t - mg.b, class: 'sd-hit'});
		root.appendChild(hit);
		hit.addEventListener('mousemove', (ev) => {
			const px = ev.clientX - root.getBoundingClientRect().left;
			const i = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px - mg.l) / ((W - mg.l - mg.r) / (n - 1)))));
			cross.setAttribute('x1', x(i));
			cross.setAttribute('x2', x(i));
			cross.setAttribute('visibility', 'visible');
			const c = row.cells[i];
			showTip(`<div class="sd-tip-title">${esc(bucketLabel(data, data.buckets[i], true))}</div>`
				+ tipRow(t('SLI'), pct(c ? c[0] : null)) + tipRow(t('Downtime'), c ? duration(c[1]) : '—')
				+ (c && c[2] ? tipRow(t('Incidents'), String(c[2])) : '')
				+ tipState(c ? stateOf(c[0], row.slo, c[1]) : 'none'), ev);
		});
		hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
		holder.appendChild(root);
	};
	return [holder, draw];
}

function crumbs(root, m, path, open) {
	const nav = el('div', {class: 'sd-crumbs'});
	const trail = [];
	if (m.top.length > 1) trail.push([t('All services'), []]);
	path.forEach((p, i) => trail.push([m.name(p), path.slice(0, i + 1)]));
	if (trail.length > 1) {
		const back = el('button', {type: 'button', class: 'sd-back', title: t('Back'), 'aria-label': t('Back')}, '‹');
		back.addEventListener('click', () => open(trail.at(-2)[1]));
		nav.appendChild(back);
	}
	trail.forEach(([label, target], i) => {
		if (i) nav.appendChild(el('span', {class: 'sd-crumb-sep'}, '›'));
		if (i === trail.length - 1) {
			nav.appendChild(el('span', {class: 'sd-crumb is-current'}, esc(label)));
		}
		else {
			const b = el('button', {type: 'button', class: 'sd-crumb'}, esc(label));
			b.addEventListener('click', () => open(target));
			nav.appendChild(b);
		}
	});
	root.appendChild(nav);
}

function detail(root, data, m, path, open, slaPick) {
	const id = path.at(-1);
	const rows = m.rowsBy.get(id) || [];
	const row = m.primary(id, slaPick.get(id) || null);

	crumbs(root, m, path, open);

	const head = el('div', {class: `sd-svc is-${row.state}`});
	const report = `zabbix.php?action=slareport.list&filter_slaid=${encodeURIComponent(row.slaid)}&filter_serviceid=${encodeURIComponent(id)}&filter_set=1`;
	head.innerHTML = `
		<div class="sd-svc-top">
			<div class="sd-svc-name">${m.problem(id) ? `<span class="sd-live" title="${esc(t('Problem'))}"></span>` : ''}${esc(m.name(id))}</div>
			<span class="sd-chip is-${row.state}">${esc(STATE_LABEL()[row.state])}</span>
			<a class="sd-svc-link" href="${report}">${esc(t('SLA report'))} ›</a>
		</div>
		<div class="sd-stats">
			<div class="sd-stat sd-stat-main"><span class="sd-stat-value">${esc(pct(row.sli))}</span><span class="sd-stat-label">${esc(t('SLI'))} · ${esc(t('SLO'))} ${esc(pct(row.slo))}</span></div>
			<div class="sd-stat"><span class="sd-stat-value">${esc(duration(row.down))}</span><span class="sd-stat-label">${esc(t('Downtime'))}</span></div>
			<div class="sd-stat"><span class="sd-stat-value${row.budget !== null && row.budget < 0 ? ' sd-neg' : ''}">${esc(duration(row.budget))}</span><span class="sd-stat-label">${esc(t('Error budget'))}</span></div>
			<div class="sd-stat"><span class="sd-stat-value">${row.incidents}</span><span class="sd-stat-label">${esc(t('Incidents'))}</span></div>
		</div>`;
	root.appendChild(head);

	// Abas de SLA só quando o serviço está em mais de uma.
	if (rows.length > 1) {
		const tabs = el('div', {class: 'sd-tabs', role: 'tablist'});
		for (const r of rows) {
			const active = r.slaid === row.slaid;
			const b = el('button', {type: 'button', role: 'tab', class: `sd-tab${active ? ' is-active' : ''}`,
				'aria-selected': active ? 'true' : 'false'}, esc(r.slaName));
			b.addEventListener('click', () => { slaPick.set(id, r.slaid); open(path); });
			tabs.appendChild(b);
		}
		head.appendChild(tabs);
	}

	const [chart, draw] = trend(data, row);
	const chartBox = el('div', {class: 'sd-box'});
	chartBox.appendChild(el('div', {class: 'sd-box-title'},
		`${esc(t('SLI'))} <span class="sd-muted">· ${esc(row.slaName)} · ${esc(rangeLabel(data))}</span>`));
	chartBox.appendChild(chart);
	root.appendChild(chartBox);

	const comps = m.components(id).sort(m.byWorst(row.slaid));
	if (comps.length) {
		const box = el('div', {class: 'sd-box'});
		box.appendChild(el('div', {class: 'sd-box-title'}, esc(t('Components'))));
		const list = el('div', {class: 'sd-comps'});
		for (const c of comps) {
			const r = m.primary(c, row.slaid);
			const deeper = m.components(c).length > 0;
			const item = el('div', {class: `sd-comp is-${r.state}`});
			const nameBtn = el('button', {type: 'button', class: 'sd-comp-name'},
				`${m.problem(c) ? `<span class="sd-live" title="${esc(t('Problem'))}"></span>` : ''}<span class="sd-comp-label">${esc(m.name(c))}</span>${deeper ? '<span class="sd-chev">›</span>' : ''}`);
			nameBtn.addEventListener('click', () => open([...path, c]));
			item.appendChild(nameBtn);
			item.appendChild(el('span', {class: `sd-chip is-${r.state}`}, esc(pct(r.sli))));
			item.appendChild(strip(data, r, 90, true));
			item.appendChild(el('span', {class: 'sd-comp-down', title: t('Downtime')}, esc(duration(r.down))));
			list.appendChild(item);
		}
		box.appendChild(list);
		root.appendChild(box);
	}
	return [draw];
}

// ---------------------------------------------------------------- página

function readPath() {
	return location.hash.replace(/^#\/?/, '').split('/').filter((x) => /^\d+$/.test(x));
}

function mount() {
	const root = document.getElementById('sla-dashboard-root');
	if (!root || !boot.data) return;

	let data = boot.data;
	let draws = [];
	const slaPick = new Map();

	const render = () => {
		hideTip();
		root.innerHTML = '';
		const view = el('div', {class: 'sd-view'});
		root.appendChild(view);
		draws = [];

		if (!data.slas.length || !data.buckets.length || !data.rows.length) {
			view.appendChild(el('div', {class: 'sd-empty'},
				`<div class="sd-empty-title">${esc(t('No data found'))}</div><div class="sd-muted">${esc(t('No service with an enabled SLA matches the filter.'))}</div>`));
			return;
		}
		if (data.truncated) {
			view.appendChild(el('div', {class: 'sd-note'},
				esc(t('Too many periods for the selected range: showing the last %1$s. Group by a longer period or choose a shorter range.', data.buckets.length))));
		}

		const m = model(data);
		// Caminho da URL, só com serviços que ainda aparecem; com um único serviço de topo, ele abre direto.
		let path = readPath().filter((id) => m.measured(id));
		if (!path.length && m.top.length === 1) path = [m.top[0]];

		if (path.length) {
			draws = detail(view, data, m, path, open, slaPick);
		}
		else {
			overview(view, data, m, open);
		}
		draws.forEach((d) => d());
	};

	function open(path) {
		const url = path.length ? `#/${path.join('/')}` : location.pathname + location.search;
		history.pushState(null, '', url);
		render();
		document.querySelector('.wrapper')?.scrollTo({top: 0});
	}

	render();
	window.addEventListener('popstate', render);

	let raf = 0;
	new ResizeObserver(() => {
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(() => draws.forEach((d) => d()));
	}).observe(root);

	// Atualização periódica com o mesmo filtro (salvo no perfil); só redesenha se algo mudou.
	if (boot.refreshMs > 0) {
		let last = JSON.stringify({...data, now: 0});
		setInterval(async () => {
			if (document.hidden) return;
			try {
				const res = await fetch(boot.dataUrl, {credentials: 'same-origin'});
				if (!res.ok) return;
				const fresh = await res.json();
				if (!fresh || !Array.isArray(fresh.buckets)) return;
				const s = JSON.stringify({...fresh, now: 0});
				if (s === last) return;
				last = s;
				data = fresh;
				const wrapper = document.querySelector('.wrapper');
				const y = wrapper?.scrollTop;
				render();
				if (wrapper && y !== undefined) wrapper.scrollTop = y;
			}
			catch (e) {
				// rede/sessão: tenta de novo no próximo ciclo
			}
		}, boot.refreshMs);
	}
}

mount();
