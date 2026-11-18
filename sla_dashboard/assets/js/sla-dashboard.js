/*
 * SLA dashboard (Services → SLA dashboard) — desenha os gráficos a partir de window.SLA_DASHBOARD.
 * SVG e DOM puros, sem bibliotecas. Cores pelo tema do Zabbix (CSS em sla-dashboard.css); textos pelo
 * dicionário traduzido no PHP (o CI18n lê os textos de t() direto deste arquivo, então todo texto
 * visível passa por t() com aspas simples).
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

let numFmtCache = {};
function num(v, digits = 2) {
	const key = digits;
	numFmtCache[key] ||= new Intl.NumberFormat(LANG, {minimumFractionDigits: digits, maximumFractionDigits: digits});
	return numFmtCache[key].format(v);
}

function pct(v) {
	if (v === null || v === undefined) return '—';
	// Mais casas quando perto de 100%, senão 99,95% vira 100,00%.
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

// ---------------------------------------------------------------- estado/cores

/** Estado de uma medida contra o SLO: ok (sem parada), met (parou mas cumpriu), breach (abaixo do SLO). */
function stateOf(sli, slo, down) {
	if (sli === null || sli === undefined) return 'none';
	if (sli < slo) return 'breach';
	return down > 0 ? 'met' : 'ok';
}

const STATE_LABEL = () => ({
	ok: t('No downtime'),
	met: t('Downtime within SLO'),
	breach: t('Below SLO'),
	none: t('No data')
});

function seriesVar(i) {
	return `var(--sd-series-${(i % 8) + 1})`;
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

function panel(title, subtitle = '', cls = '') {
	const p = el('div', {class: `sd-panel ${cls}`});
	p.appendChild(el('div', {class: 'sd-panel-head'},
		`<div class="sd-panel-title">${esc(title)}</div>${subtitle ? `<div class="sd-panel-sub">${esc(subtitle)}</div>` : ''}`));
	const body = el('div', {class: 'sd-panel-body'});
	p.appendChild(body);
	return [p, body];
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

function tipRow(label, value, swatch = '') {
	return `<div class="sd-tip-row">${swatch ? `<span class="sd-swatch" style="background:${swatch}"></span>` : ''}<span class="sd-tip-label">${esc(label)}</span><span class="sd-tip-value">${esc(value)}</span></div>`;
}

// ---------------------------------------------------------------- KPIs

function kpis(data, rows) {
	const wrap = el('div', {class: 'sd-kpis'});
	let up = 0, down = 0, incidents = 0, mttrSum = 0, mttrN = 0, met = 0, measured = 0, ongoing = 0;
	for (const r of rows) {
		up += r.up; down += r.down; incidents += r.incidents;
		if (r.mttr !== null) { mttrSum += r.mttr * r.incidents; mttrN += r.incidents; }
		if (r.sli !== null) { measured++; if (r.sli >= r.slo) met++; }
		if (r.ongoing) ongoing++;
	}
	const sli = up + down > 0 ? up / (up + down) * 100 : null;
	const minSlo = Math.min(...data.slas.map((s) => s.slo));
	const sliState = sli === null ? 'none' : (met === measured ? 'ok' : (sli >= minSlo ? 'met' : 'breach'));

	const tiles = [
		{label: t('Overall SLI'), value: pct(sli), state: sliState,
			note: t('Time-weighted across %1$s services', measured)},
		{label: t('Services meeting SLO'), value: measured ? `${met} / ${measured}` : '—',
			state: measured === 0 ? 'none' : met === measured ? 'ok' : 'breach', bar: measured ? met / measured : null,
			note: measured - met > 0 ? t('%1$s below SLO', measured - met) : t('All within SLO')},
		{label: t('Downtime'), value: duration(down), state: down > 0 ? 'met' : 'ok',
			note: rangeLabel(data)},
		{label: t('Incidents'), value: String(incidents), state: ongoing ? 'breach' : incidents ? 'met' : 'ok',
			note: ongoing ? t('%1$s ongoing now', ongoing) : t('None ongoing')},
		{label: t('Mean time to recover'), value: mttrN ? duration(mttrSum / mttrN) : '—', state: 'none',
			note: t('MTTR, resolved incidents')}
	];

	for (const k of tiles) {
		const tile = el('div', {class: `sd-kpi is-${k.state}`});
		tile.innerHTML = `
			<div class="sd-kpi-label">${esc(k.label)}</div>
			<div class="sd-kpi-value">${esc(k.value)}</div>
			${k.bar !== undefined && k.bar !== null ? `<div class="sd-kpi-bar"><span style="width:${(k.bar * 100).toFixed(1)}%"></span></div>` : ''}
			<div class="sd-kpi-note">${esc(k.note)}</div>`;
		wrap.appendChild(tile);
	}
	return wrap;
}

// ---------------------------------------------------------------- SLA cards (compliance)

function slaCards(data, rows) {
	const [p, body] = panel(t('SLA compliance'), rangeLabel(data), 'sd-span-1');
	const list = el('div', {class: 'sd-sla-list'});
	data.slas.forEach((sla, i) => {
		const rs = rows.filter((r) => r.slaid === sla.slaid);
		let up = 0, down = 0, breach = 0;
		for (const r of rs) { up += r.up; down += r.down; if (r.sli !== null && r.sli < sla.slo) breach++; }
		const sli = up + down > 0 ? up / (up + down) * 100 : null;
		const state = stateOf(sli, sla.slo, down);
		// Escala da barra: do "SLO - margem" até 100%, senão tudo parece cheio.
		const floor = Math.max(0, sla.slo - Math.max(1, (100 - sla.slo) * 4));
		const pos = (v) => Math.max(0, Math.min(100, (v - floor) / (100 - floor) * 100));
		const item = el('div', {class: `sd-sla is-${state}`});
		const href = `zabbix.php?action=slareport.list&filter_slaid=${encodeURIComponent(sla.slaid)}&filter_set=1`;
		item.innerHTML = `
			<div class="sd-sla-top">
				<span class="sd-swatch" style="background:${seriesVar(i)}"></span>
				<a class="sd-sla-name" href="${href}">${esc(sla.name)}</a>
				<span class="sd-chip is-${state}">${esc(STATE_LABEL()[state])}</span>
			</div>
			<div class="sd-sla-nums">
				<span class="sd-sla-sli">${esc(pct(sli))}</span>
				<span class="sd-muted">${esc(t('SLO'))} ${esc(pct(sla.slo))}</span>
			</div>
			<div class="sd-gauge" aria-hidden="true">
				<span class="sd-gauge-fill" style="width:${sli === null ? 0 : pos(sli).toFixed(2)}%"></span>
				<span class="sd-gauge-slo" style="left:${pos(sla.slo).toFixed(2)}%"></span>
			</div>
			<div class="sd-sla-meta sd-muted">${esc(t('%1$s services', rs.length))} · ${esc(breach ? t('%1$s below SLO', breach) : t('All within SLO'))}${sla.schedule ? ` · ${esc(t('Custom schedule'))}` : ''}${sla.excluded.length ? ` · ${esc(t('Excluded downtimes'))}: ${sla.excluded.length}` : ''}</div>`;
		list.appendChild(item);
	});
	body.appendChild(list);
	return p;
}

// ---------------------------------------------------------------- linha do SLI

function niceMin(minVal) {
	const gap = 100 - minVal;
	if (gap <= 0) return 99;
	const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100];
	const step = steps.find((s) => s * 4 >= gap * 1.15) || 100;
	return Math.max(0, 100 - step * 4);
}

function trendChart(data) {
	const [p, body] = panel(t('SLI trend'), t('Per SLA, time-weighted across its services; dashed line = SLO'), 'sd-span-2');
	const legend = el('div', {class: 'sd-legend'});
	data.slas.forEach((sla, i) => {
		legend.appendChild(el('span', {class: 'sd-legend-item'},
			`<span class="sd-legend-line" style="background:${seriesVar(i)}"></span>${esc(sla.name)}`));
	});
	if (data.slas.length > 1) body.appendChild(legend);

	const holder = el('div', {class: 'sd-chart'});
	body.appendChild(holder);

	const draw = () => {
		holder.innerHTML = '';
		const W = Math.max(280, holder.clientWidth);
		const H = 240;
		const m = {l: 58, r: 16, t: 12, b: 28};
		const n = data.buckets.length;
		let lo = 100;
		data.slas.forEach((s) => {
			lo = Math.min(lo, s.slo);
			s.series.forEach((v) => { if (v !== null) lo = Math.min(lo, v); });
		});
		const y0 = niceMin(lo);
		const x = (i) => m.l + (n <= 1 ? (W - m.l - m.r) / 2 : i * (W - m.l - m.r) / (n - 1));
		const y = (v) => m.t + (100 - v) / (100 - y0) * (H - m.t - m.b);

		const root = svg('svg', {width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'sd-svg', role: 'img',
			'aria-label': t('SLI trend')});

		// grade + eixo Y
		for (let k = 0; k <= 4; k++) {
			const v = y0 + (100 - y0) * k / 4;
			root.appendChild(svg('line', {x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'sd-grid'}));
			const lbl = svg('text', {x: m.l - 8, y: y(v) + 4, class: 'sd-axis', 'text-anchor': 'end'});
			lbl.textContent = `${num(v, 100 - y0 < 1 ? 2 : 100 - y0 < 10 ? 1 : 0)}%`;
			root.appendChild(lbl);
		}
		// eixo X: ~6 rótulos
		const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - m.l - m.r) / 90))));
		for (let i = 0; i < n; i += every) {
			const lbl = svg('text', {x: x(i), y: H - 8, class: 'sd-axis', 'text-anchor': 'middle'});
			lbl.textContent = bucketLabel(data, data.buckets[i]);
			root.appendChild(lbl);
		}

		data.slas.forEach((sla, si) => {
			const color = seriesVar(si);
			root.appendChild(svg('line', {x1: m.l, x2: W - m.r, y1: y(sla.slo), y2: y(sla.slo), class: 'sd-slo-line',
				style: `stroke:${color}`}));
			let d = '';
			let pen = false;
			sla.series.forEach((v, i) => {
				if (v === null) { pen = false; return; }
				d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
				pen = true;
			});
			root.appendChild(svg('path', {d, class: 'sd-line', style: `stroke:${color}`}));
			// pontos só abaixo do SLO (o que importa ver)
			sla.series.forEach((v, i) => {
				if (v !== null && v < sla.slo) {
					root.appendChild(svg('circle', {cx: x(i), cy: y(v), r: 4, class: 'sd-dot-breach', style: `fill:${color}`}));
				}
			});
		});

		// crosshair + tooltip
		const cross = svg('line', {y1: m.t, y2: H - m.b, class: 'sd-cross', visibility: 'hidden'});
		root.appendChild(cross);
		const hit = svg('rect', {x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, class: 'sd-hit'});
		root.appendChild(hit);
		hit.addEventListener('mousemove', (ev) => {
			const box = root.getBoundingClientRect();
			const px = ev.clientX - box.left;
			const i = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px - m.l) / ((W - m.l - m.r) / (n - 1)))));
			cross.setAttribute('x1', x(i));
			cross.setAttribute('x2', x(i));
			cross.setAttribute('visibility', 'visible');
			let html = `<div class="sd-tip-title">${esc(bucketLabel(data, data.buckets[i], true))}</div>`;
			data.slas.forEach((sla, si) => {
				const v = sla.series[i];
				html += tipRow(sla.name, `${pct(v)}${v !== null && v < sla.slo ? ' ▼' : ''}`, seriesVar(si));
			});
			showTip(html, ev);
		});
		hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });

		holder.appendChild(root);
	};
	return [p, draw];
}

// ---------------------------------------------------------------- heatmap

function heatmap(data, rows, svcName) {
	const [p, body] = panel(t('SLI heatmap'), t('Each cell is one period of one service, compared with the SLO of its SLA'), 'sd-span-3');
	const legend = el('div', {class: 'sd-legend'});
	for (const s of ['ok', 'met', 'breach', 'none']) {
		legend.appendChild(el('span', {class: 'sd-legend-item'}, `<span class="sd-cell-swatch is-${s}"></span>${esc(STATE_LABEL()[s])}`));
	}
	body.appendChild(legend);

	const holder = el('div', {class: 'sd-heat'});
	body.appendChild(holder);
	const slaById = Object.fromEntries(data.slas.map((s, i) => [s.slaid, {...s, index: i}]));

	const draw = () => {
		holder.innerHTML = '';
		const n = data.buckets.length;
		const labelW = Math.min(300, Math.max(160, holder.clientWidth * 0.24));
		const avail = holder.clientWidth - labelW - 8;
		const gap = n > 120 ? 1 : 2;
		const cw = Math.max(6, Math.min(36, Math.floor(avail / n) - gap));
		const ch = 20;
		const W = labelW + n * (cw + gap) + 8;
		const H = 22 + rows.length * (ch + 4);
		const root = svg('svg', {width: W, height: H, class: 'sd-svg', role: 'img', 'aria-label': t('SLI heatmap')});

		const every = Math.max(1, Math.ceil(70 / (cw + gap)));
		for (let i = 0; i < n; i += every) {
			const lbl = svg('text', {x: labelW + i * (cw + gap), y: 12, class: 'sd-axis'});
			lbl.textContent = bucketLabel(data, data.buckets[i]);
			root.appendChild(lbl);
		}

		rows.forEach((r, ri) => {
			const yy = 22 + ri * (ch + 4);
			const sla = slaById[r.slaid];
			const name = svg('text', {x: 0, y: yy + 14, class: 'sd-row-label'});
			name.textContent = svcName(r.serviceid);
			const sub = svg('tspan', {class: 'sd-row-sub', dx: 6});
			sub.textContent = data.slas.length > 1 ? sla.name : '';
			name.appendChild(sub);
			root.appendChild(name);
			// corta o rótulo comprido
			const clip = svg('clipPath', {id: `sd-clip-${ri}`});
			clip.appendChild(svg('rect', {x: 0, y: yy, width: labelW - 10, height: ch}));
			root.appendChild(clip);
			name.setAttribute('clip-path', `url(#sd-clip-${ri})`);

			r.cells.forEach((c, i) => {
				const state = c === null ? 'none' : stateOf(c[0], r.slo, c[1]);
				const rect = svg('rect', {x: labelW + i * (cw + gap), y: yy, width: cw, height: ch, rx: Math.min(3, cw / 3),
					class: `sd-cell is-${state}`});
				rect.addEventListener('mousemove', (ev) => {
					let html = `<div class="sd-tip-title">${esc(svcName(r.serviceid))}</div>
						<div class="sd-tip-sub">${esc(sla.name)} · ${esc(bucketLabel(data, data.buckets[i], true))}</div>`;
					html += tipRow(t('SLI'), pct(c ? c[0] : null));
					html += tipRow(t('SLO'), pct(r.slo));
					html += tipRow(t('Downtime'), c ? duration(c[1]) : '—');
					if (c && c[2]) html += tipRow(t('Incidents'), String(c[2]));
					html += `<div class="sd-tip-state is-${state}">${esc(STATE_LABEL()[state])}</div>`;
					showTip(html, ev);
				});
				rect.addEventListener('mouseleave', hideTip);
				root.appendChild(rect);
			});
		});
		holder.appendChild(root);
	};
	return [p, draw];
}

// ---------------------------------------------------------------- barras ranqueadas

function rankedBars(title, subtitle, items, cls) {
	const [p, body] = panel(title, subtitle, cls);
	if (!items.length) {
		body.appendChild(el('div', {class: 'sd-empty-small'}, esc(t('No downtime in the selected period.'))));
		return p;
	}
	const list = el('div', {class: 'sd-bars'});
	for (const it of items) {
		const row = el('div', {class: 'sd-bar-row'});
		row.innerHTML = `
			<div class="sd-bar-label"><span class="sd-bar-name">${esc(it.label)}</span><span class="sd-bar-sub">${esc(it.sub || '')}</span></div>
			<div class="sd-bar-track">
				<span class="sd-bar-fill is-${it.state}" style="width:${Math.max(1.5, Math.min(100, it.ratio * 100)).toFixed(1)}%"></span>
				${it.marker !== undefined ? `<span class="sd-bar-marker" style="left:${it.marker.toFixed(1)}%"></span>` : ''}
			</div>
			<div class="sd-bar-value">${esc(it.value)}</div>`;
		row.addEventListener('mousemove', (ev) => showTip(it.tip, ev));
		row.addEventListener('mouseleave', hideTip);
		list.appendChild(row);
	}
	body.appendChild(list);
	return p;
}

function budgetPanel(data, rows, svcName, slaName) {
	// Consumo do orçamento de erro: parada / parada permitida pelo SLO no tempo medido.
	const items = rows
		.filter((r) => r.sli !== null && r.slo < 100)
		.map((r) => {
			const allowed = (r.up + r.down) * (1 - r.slo / 100);
			const used = allowed > 0 ? r.down / allowed : 0;
			return {r, used};
		})
		.filter((x) => x.used > 0)
		.sort((a, b) => b.used - a.used)
		.slice(0, 10)
		.map(({r, used}) => ({
			label: svcName(r.serviceid),
			sub: data.slas.length > 1 ? slaName(r.slaid) : '',
			// a barra vai até 200%; o marcador fica nos 100% (o limite do SLO)
			ratio: Math.min(used, 2) / 2,
			marker: 50,
			state: used > 1 ? 'breach' : used >= 0.75 ? 'warn' : 'met',
			value: `${num(used * 100, 0)}%`,
			tip: `<div class="sd-tip-title">${esc(svcName(r.serviceid))}</div><div class="sd-tip-sub">${esc(slaName(r.slaid))}</div>`
				+ tipRow(t('Error budget used'), `${num(used * 100, 1)}%`)
				+ tipRow(t('Error budget'), duration(r.budget))
				+ tipRow(t('Downtime'), duration(r.down))
				+ tipRow(t('SLI'), pct(r.sli)) + tipRow(t('SLO'), pct(r.slo))
		}));
	return rankedBars(t('Error budget used'), t('Downtime as a share of what the SLO allows; marker = 100%'), items, 'sd-span-half');
}

function downtimePanel(data, rows, svcName, slaName) {
	// Um serviço em várias SLAs aparece uma vez (mesma parada); fica o maior valor.
	const bySvc = new Map();
	for (const r of rows) {
		const cur = bySvc.get(r.serviceid);
		if (!cur || r.down > cur.down) bySvc.set(r.serviceid, r);
	}
	const list = [...bySvc.values()].filter((r) => r.down > 0).sort((a, b) => b.down - a.down).slice(0, 10);
	const max = list.length ? list[0].down : 1;
	const items = list.map((r) => ({
		label: svcName(r.serviceid),
		sub: `${t('Incidents')}: ${r.incidents}`,
		ratio: r.down / max,
		state: 'series',
		value: duration(r.down),
		tip: `<div class="sd-tip-title">${esc(svcName(r.serviceid))}</div>`
			+ tipRow(t('Downtime'), duration(r.down))
			+ tipRow(t('Incidents'), String(r.incidents))
			+ tipRow(t('Mean time to recover'), duration(r.mttr))
	}));
	return rankedBars(t('Top downtime'), t('Services with the most downtime in the selected period'), items, 'sd-span-half');
}

// ---------------------------------------------------------------- tabela

function sparkline(cells, slo) {
	const vals = cells.map((c) => (c ? c[0] : null));
	const present = vals.filter((v) => v !== null);
	if (!present.length) return '';
	const W = 120, H = 26;
	const lo = Math.min(slo, ...present);
	const y0 = niceMin(lo);
	const n = vals.length;
	const x = (i) => (n <= 1 ? W / 2 : 2 + i * (W - 4) / (n - 1));
	const y = (v) => 3 + (100 - v) / (100 - y0) * (H - 6);
	let d = '', pen = false;
	vals.forEach((v, i) => {
		if (v === null) { pen = false; return; }
		d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
		pen = true;
	});
	const dots = vals.map((v, i) => (v !== null && v < slo ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2" class="sd-spark-dot"/>` : '')).join('');
	return `<svg class="sd-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><line x1="0" x2="${W}" y1="${y(slo).toFixed(1)}" y2="${y(slo).toFixed(1)}" class="sd-spark-slo"/><path d="${d}" class="sd-spark-line"/>${dots}</svg>`;
}

const COLUMNS = [
	{key: 'name', label: () => t('Service'), sort: (r, ctx) => ctx.svcName(r.serviceid).toLowerCase()},
	{key: 'sla', label: () => t('SLA'), sort: (r, ctx) => ctx.slaName(r.slaid).toLowerCase()},
	{key: 'slo', label: () => t('SLO'), sort: (r) => r.slo, num: true},
	{key: 'sli', label: () => t('SLI'), sort: (r) => (r.sli === null ? 1e9 : r.sli - r.slo), num: true},
	{key: 'up', label: () => t('Uptime'), sort: (r) => r.up, num: true},
	{key: 'down', label: () => t('Downtime'), sort: (r) => r.down, num: true},
	{key: 'budget', label: () => t('Error budget'), sort: (r) => (r.budget === null ? 1e15 : r.budget), num: true},
	{key: 'incidents', label: () => t('Incidents'), sort: (r) => r.incidents, num: true},
	{key: 'mttr', label: () => t('MTTR'), sort: (r) => r.mttr ?? -1, num: true},
	{key: 'trend', label: () => t('Trend')}
];

let tableSort = {key: 'sli', dir: 1};

function table(data, rows, ctx) {
	const [p, body] = panel(t('Services'), t('Click a service to open its SLA report'), 'sd-span-3');
	const wrap = el('div', {class: 'sd-table-wrap'});
	body.appendChild(wrap);

	const render = () => {
		const col = COLUMNS.find((c) => c.key === tableSort.key) || COLUMNS[3];
		const sorted = [...rows].sort((a, b) => {
			const va = col.sort(a, ctx), vb = col.sort(b, ctx);
			return (va < vb ? -1 : va > vb ? 1 : 0) * tableSort.dir;
		});
		let html = '<table class="sd-table"><thead><tr>';
		for (const c of COLUMNS) {
			const active = c.key === tableSort.key;
			html += `<th class="${c.num ? 'is-num' : ''}${c.sort ? ' is-sortable' : ''}${active ? ' is-sorted' : ''}" data-key="${c.key}">${esc(c.label())}${active ? `<span class="sd-sort">${tableSort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`;
		}
		html += '</tr></thead><tbody>';
		for (const r of sorted) {
			const state = stateOf(r.sli, r.slo, r.down);
			const link = `zabbix.php?action=slareport.list&filter_slaid=${encodeURIComponent(r.slaid)}&filter_serviceid=${encodeURIComponent(r.serviceid)}&filter_set=1`;
			const svc = data.services[r.serviceid];
			html += `<tr>
				<td><span class="sd-status-dot ${svc && svc.status >= 0 ? 'is-problem' : 'is-ok'}" title="${esc(svc && svc.status >= 0 ? t('Problem') : t('OK'))}"></span><a href="${link}">${esc(ctx.svcName(r.serviceid))}</a>${r.ongoing ? ` <span class="sd-chip is-breach">${esc(t('Problem'))}</span>` : ''}</td>
				<td class="sd-muted">${esc(ctx.slaName(r.slaid))}</td>
				<td class="is-num">${esc(pct(r.slo))}</td>
				<td class="is-num"><span class="sd-chip is-${state}">${esc(pct(r.sli))}</span></td>
				<td class="is-num">${esc(duration(r.up))}</td>
				<td class="is-num">${esc(duration(r.down))}</td>
				<td class="is-num ${r.budget !== null && r.budget < 0 ? 'sd-neg' : ''}">${esc(duration(r.budget))}</td>
				<td class="is-num">${r.incidents}</td>
				<td class="is-num">${esc(duration(r.mttr))}</td>
				<td>${sparkline(r.cells, r.slo)}</td>
			</tr>`;
		}
		html += '</tbody></table>';
		wrap.innerHTML = html;
		wrap.querySelectorAll('th.is-sortable').forEach((th) => th.addEventListener('click', () => {
			const key = th.dataset.key;
			tableSort = {key, dir: tableSort.key === key ? -tableSort.dir : 1};
			render();
		}));
	};
	render();
	return p;
}

// ---------------------------------------------------------------- página

function render(root, data) {
	root.innerHTML = '';

	if (!data.slas.length || !data.buckets.length) {
		root.appendChild(el('div', {class: 'sd-empty'},
			`<div class="sd-empty-title">${esc(t('No data found'))}</div><div class="sd-muted">${esc(t('No enabled SLA matches the filter. Choose other SLAs, services, hosts or tags in the filter above.'))}</div>`));
		return [];
	}

	const slaById = Object.fromEntries(data.slas.map((s) => [s.slaid, s]));
	const rows = data.rows.map((r) => ({...r, slo: slaById[r.slaid].slo}));
	const svcName = (id) => (data.services[id] ? data.services[id].name : id);
	const slaName = (id) => (slaById[id] ? slaById[id].name : id);

	if (!rows.length) {
		root.appendChild(el('div', {class: 'sd-empty'},
			`<div class="sd-empty-title">${esc(t('No data found'))}</div><div class="sd-muted">${esc(t('No service matches the filter.'))}</div>`));
		return [];
	}

	if (data.truncated) {
		root.appendChild(el('div', {class: 'sd-note'},
			esc(t('Too many periods for the selected range: showing the last %1$s. Group by a longer period or choose a shorter range.', data.buckets.length))));
	}

	root.appendChild(kpis(data, rows));

	const grid = el('div', {class: 'sd-grid'});
	root.appendChild(grid);

	const [trendPanel, drawTrend] = trendChart(data);
	grid.appendChild(trendPanel);
	grid.appendChild(slaCards(data, rows));

	const heatRows = [...rows].sort((a, b) => (a.slaid === b.slaid
		? svcName(a.serviceid).localeCompare(svcName(b.serviceid), LANG)
		: slaName(a.slaid).localeCompare(slaName(b.slaid), LANG)));
	const [heatPanel, drawHeat] = heatmap(data, heatRows, svcName);
	grid.appendChild(heatPanel);

	grid.appendChild(budgetPanel(data, rows, svcName, slaName));
	grid.appendChild(downtimePanel(data, rows, svcName, slaName));
	grid.appendChild(table(data, rows, {svcName, slaName}));

	return [drawTrend, drawHeat];
}

function mount() {
	const root = document.getElementById('sla-dashboard-root');
	if (!root || !boot.data) return;

	let data = boot.data;
	let draws = render(root, data);
	const redraw = () => draws.forEach((d) => d());
	redraw();

	let raf = 0;
	new ResizeObserver(() => {
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(redraw);
	}).observe(root);

	// Atualização periódica com o mesmo filtro (salvo no perfil). Só redesenha se algo mudou.
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
				const y = document.querySelector('.wrapper')?.scrollTop;
				draws = render(root, data);
				redraw();
				if (y !== undefined) document.querySelector('.wrapper').scrollTop = y;
			}
			catch (e) {
				// rede/sessão: tenta de novo no próximo ciclo
			}
		}, boot.refreshMs);
	}
}

mount();
